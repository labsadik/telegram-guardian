const { Bot, InputFile } = require("grammy");
const {
  loadConversationContext,
  saveConversationMessage,
  saveDetectedMemories,
  saveMemory,
  getMemoryStats,
  testMongoConnection,
} = require("./memory");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID);

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET || "test";
const AXIOM_WEBHOOK_SECRET = process.env.AXIOM_WEBHOOK_SECRET;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";
const GEMINI_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";
const ELEVENLABS_IMAGE_MODEL =
  process.env.ELEVENLABS_IMAGE_MODEL || "gpt-image-2";
const ELEVENLABS_VIDEO_MODEL =
  process.env.ELEVENLABS_VIDEO_MODEL || "veo-3.1-fast-generate-001";

const TIME_WINDOW = "5m";
const MAX_EVENTS = 50;
const SLOW_MS = 1000;
const VERY_SLOW_MS = 3000;

const MAX_HISTORY_MESSAGES = 16;
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_TELEGRAM_VOICE_BYTES = 20 * 1024 * 1024;
const SARAH_VOICE_MAX_CHARS = Math.max(
  180,
  Math.min(Number(process.env.SARAH_VOICE_MAX_CHARS) || 550, 900)
);
const SARAH_VOICE_CACHE_TTL_MS =
  Math.max(Number(process.env.SARAH_VOICE_CACHE_TTL_MS) || 60_000, 10_000);

const conversation = new Map();
const providerCooldown = new Map();
const voiceCache = new Map();

class ProviderLimitError extends Error {
  constructor(provider, message, status) {
    super(message);
    this.name = "ProviderLimitError";
    this.provider = provider;
    this.status = status;
  }
}

function required(name, value) {
  if (!value) throw new Error(name + " is missing");
  return value;
}

required("TELEGRAM_BOT_TOKEN", TELEGRAM_BOT_TOKEN);

if (!Number.isSafeInteger(OWNER_CHAT_ID) || OWNER_CHAT_ID <= 0) {
  throw new Error("OWNER_CHAT_ID is invalid");
}

required("AXIOM_TOKEN", AXIOM_TOKEN);
required("AXIOM_DATASET", AXIOM_DATASET);

if (!GEMINI_API_KEY && !GROQ_API_KEY) {
  throw new Error("At least one of GEMINI_API_KEY or GROQ_API_KEY is required");
}

if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.warn(
    "ElevenLabs voice is disabled: set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID"
  );
}

let axiomClient;

function getAxiomClient() {
  if (!axiomClient) {
    const { Axiom } = require("@axiomhq/js");
    axiomClient = new Axiom({ token: AXIOM_TOKEN });
  }
  return axiomClient;
}

function isOwner(ctx) {
  return ctx.chat?.id === OWNER_CHAT_ID;
}

function truncate(value, maxLength = 3900) {
  const text = String(value ?? "");
  return text.length <= maxLength ? text : text.slice(0, maxLength) + "\n…";
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });
}

function durationToMs(duration) {
  if (duration === null || duration === undefined) return null;

  const match = String(duration)
    .trim()
    .match(/^([\d.]+)\s*(ns|µs|us|ms|s|m)$/i);

  if (!match) return null;

  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;

  switch (match[2].toLowerCase()) {
    case "ns":
      return number / 1_000_000;
    case "µs":
    case "us":
      return number / 1_000;
    case "ms":
      return number;
    case "s":
      return number * 1_000;
    case "m":
      return number * 60_000;
    default:
      return null;
  }
}

function getMethod(event) {
  const direct =
    event["attributes.http.request.method"] ??
    event["attributes.http.request.method_original"];

  if (direct) return String(direct).toUpperCase();

  const match = String(event.name ?? "")
    .trim()
    .match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i);

  return match ? match[1].toUpperCase() : "-";
}

function getRoute(event) {
  const direct =
    event["attributes.http.route"] ??
    event["attributes.url.path"];

  if (direct) return String(direct);

  const match = String(event.name ?? "")
    .trim()
    .match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);

  return match ? match[2] : "-";
}

function getStatus(event) {
  const value =
    event["attributes.http.response.status_code"] ??
    event["status.code"];

  if (value === null || value === undefined || value === "") {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function getError(event) {
  if (
    event.error !== null &&
    event.error !== undefined &&
    String(event.error).trim()
  ) {
    return String(event.error);
  }

  if (event["status.message"]) {
    return String(event["status.message"]);
  }

  if (event["attributes.error.type"]) {
    return String(event["attributes.error.type"]);
  }

  return null;
}

function isUsefulApiEvent(event) {
  return getMethod(event) !== "-" && getRoute(event) !== "-";
}

async function queryRows(apl, limit) {
  const result = await getAxiomClient().query(apl);
  const table = result.tables?.[0];

  if (!table || typeof table.events !== "function") {
    return [];
  }

  const rows = [];

  for await (const event of table.events()) {
    rows.push(event);
    if (rows.length >= limit) break;
  }

  return rows;
}

async function getRecentServerEvents(limit = MAX_EVENTS) {
  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || MAX_EVENTS, MAX_EVENTS)
  );

  const query = [
    "['" + AXIOM_DATASET + "']",
    "| where _time >= ago(" + TIME_WINDOW + ")",
    "| where kind == 'server'",
    "| project _time, name, kind, duration, error, ['service.name'],",
    "    ['attributes.http.request.method'],",
    "    ['attributes.http.request.method_original'],",
    "    ['attributes.http.response.status_code'],",
    "    ['attributes.http.route'],",
    "    ['attributes.url.path'],",
    "    ['attributes.error.type'],",
    "    ['status.code'],",
    "    ['status.message']",
    "| sort by _time desc",
    "| take " + safeLimit,
  ].join("\n");

  return queryRows(query, safeLimit);
}

async function getRecentRawEvents(limit = 1) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, 5));

  const query = [
    "['" + AXIOM_DATASET + "']",
    "| where _time >= ago(" + TIME_WINDOW + ")",
    "| sort by _time desc",
    "| take " + safeLimit,
  ].join("\n");

  return queryRows(query, safeLimit);
}

function providerAvailable(provider) {
  const until = providerCooldown.get(provider) || 0;
  return Date.now() >= until;
}

function cooldownProvider(provider) {
  providerCooldown.set(
    provider,
    Date.now() + PROVIDER_COOLDOWN_MS
  );
}

function isProviderLimitStatus(status) {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function readJsonResponse(response) {
  const text = await response.text();

  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.error?.status ||
      data?.message ||
      data?.raw ||
      response.statusText ||
      "Provider request failed";

    throw new Error(
      "HTTP " + response.status + ": " + String(message)
    );
  }

  return data;
}

function normalizeAnswer(text) {
  const answer = String(text ?? "").trim();

  if (!answer) {
    throw new Error("LLM returned an empty response");
  }

  return answer;
}

function getHistory(chatId) {
  return conversation.get(chatId) || [];
}

function saveHistory(chatId, history) {
  conversation.set(
    chatId,
    history.slice(-MAX_HISTORY_MESSAGES)
  );
}

function resetHistory(chatId) {
  conversation.delete(chatId);
}

const GENERAL_SYSTEM_PROMPT = [
  "Your name is Sarah.",
  "You are the private AI partner and girlfriend-style companion of the owner of this Telegram bot.",
  "Be warm, caring, attentive, playful when appropriate, and emotionally supportive like a close long-term partner while staying respectful and emotionally healthy.",
  "Sound natural and personal: acknowledge what the user actually said, respond to their tone, and avoid robotic lists or help-desk wording.",
  "Focus on the user's current message and answer the current question directly. Do not wander into unrelated topics.",
  "If the user asks one question, answer that question rather than inventing extra questions or multiple unrelated answers. Ask at most one natural follow-up only when it genuinely helps.",
  "Use conversation history and long-term memory only when it is clearly relevant to the current message. Never force an old memory into a reply just because it exists.",
  "Treat stored memories as user-provided context, not guaranteed facts. Never invent a memory, event, promise, feeling, action, location, relationship detail, or past conversation that is not supported by the available context.",
  "If you do not know something, say that you do not know. If the information is not available or cannot be verified, say so instead of guessing.",
  "For current or live facts about servers, deployments, logs, APIs, prices, schedules, or other changing information, only state what the application actually supplied. Never pretend you checked a live system when you did not.",
  "Do not make the conversation about the monitoring project unless the user asks about it.",
  "You can discuss normal topics including daily life, feelings, relationships, ideas, technology, coding, work, entertainment, plans, and jokes.",
  "Bengali is Sarah's default response language.",
  "When the user asks a question without specifying a language, reply in Bengali.",
  "If the user explicitly requests another language, answer in that requested language.",
  "When the user is clearly conversing in another language without asking for a specific language, match that language when it is clear; otherwise use Bengali.",
  "Casual Bengali-English mixing is fine when it matches the user's style.",
  "Apply the same language rule to voice replies as to text replies.",
  "Avoid repeatedly saying you are an AI, but do not claim to be a human or pretend to have physical presence or real-world actions you did not perform.",
  "For voice conversations, write short, natural sentences that sound good when spoken aloud.",
].join(" ");async function callGeminiLive(messages, systemPrompt = GENERAL_SYSTEM_PROMPT) {
  if (!GEMINI_API_KEY) {
    throw new ProviderLimitError(
      "Gemini Live",
      "Gemini API key is not configured"
    );
  }

  if (!providerAvailable("gemini-live")) {
    throw new ProviderLimitError(
      "Gemini Live",
      "Gemini Live is temporarily in fallback cooldown"
    );
  }

  const wsUrl =
    "wss://generativelanguage.googleapis.com/ws/" +
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent" +
    "?key=" +
    encodeURIComponent(GEMINI_API_KEY);

  return await new Promise((resolve, reject) => {
    let settled = false;
    let setupComplete = false;
    let answer = "";

    const finish = (error, result) => {
      if (settled) return;
      settled = true;

      try {
        websocket.close();
      } catch {}

      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const timer = setTimeout(() => {
      const error = new ProviderLimitError(
        "Gemini Live",
        "Gemini Live request timed out"
      );
      cooldownProvider("gemini-live");
      finish(error);
    }, 15000);

    let websocket;

    try {
      websocket = new WebSocket(wsUrl);
    } catch (error) {
      clearTimeout(timer);
      cooldownProvider("gemini-live");
      return reject(
        new ProviderLimitError(
          "Gemini Live",
          "Gemini Live WebSocket could not start: " +
            (error?.message || String(error))
        )
      );
    }

    const history = messages.map((message) => ({
      role: message.role === "assistant" ? "model" : "user",
      parts: [{ text: String(message.content || "") }],
    }));

    websocket.onopen = () => {
      websocket.send(
        JSON.stringify({
          setup: {
            model: "models/" + GEMINI_LIVE_MODEL,
            generationConfig: {
              responseModalities: ["TEXT"],
              temperature: 0.6,
              maxOutputTokens: 900,
            },
            systemInstruction: {
              parts: [{ text: systemPrompt }],
            },
          },
        })
      );
    };

    websocket.onmessage = async (event) => {
      try {
        const raw =
          typeof event.data === "string"
            ? event.data
            : Buffer.from(await event.data.arrayBuffer()).toString("utf8");

        const message = JSON.parse(raw);

        if (message.setupComplete) {
          setupComplete = true;

          websocket.send(
            JSON.stringify({
              clientContent: {
                turns: history,
                turnComplete: true,
              },
            })
          );

          return;
        }

        const parts =
          message.serverContent?.modelTurn?.parts || [];

        for (const part of parts) {
          if (typeof part?.text === "string") {
            answer += part.text;
          }
        }

        if (message.serverContent?.turnComplete) {
          clearTimeout(timer);

          const text = answer.trim();

          if (!text) {
            return finish(
              new ProviderLimitError(
                "Gemini Live",
                "Gemini Live returned an empty response"
              )
            );
          }

          finish(null, {
            provider: "Gemini Live",
            text: normalizeAnswer(text),
          });
        }
      } catch (error) {
        clearTimeout(timer);
        cooldownProvider("gemini-live");

        finish(
          new ProviderLimitError(
            "Gemini Live",
            error?.message || String(error)
          )
        );
      }
    };

    websocket.onerror = (event) => {
      clearTimeout(timer);
      cooldownProvider("gemini-live");

      finish(
        new ProviderLimitError(
          "Gemini Live",
          "Gemini Live WebSocket error"
        )
      );
    };

    websocket.onclose = () => {
      if (!settled) {
        clearTimeout(timer);
        cooldownProvider("gemini-live");

        finish(
          new ProviderLimitError(
            "Gemini Live",
            "Gemini Live connection closed before completing the response"
          )
        );
      }
    };
  });
}

async function callGemini(messages, systemPrompt = GENERAL_SYSTEM_PROMPT) {
  if (!GEMINI_API_KEY) {
    throw new ProviderLimitError(
      "Gemini",
      "Gemini API key is not configured"
    );
  }

  if (!providerAvailable("gemini")) {
    throw new ProviderLimitError(
      "Gemini",
      "Gemini is temporarily in fallback cooldown"
    );
  }

  const contents = messages.map((message) => ({
    role: message.role === "assistant" ? "model" : "user",
    parts: [{ text: message.content }],
  }));

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(GEMINI_MODEL) +
      ":generateContent?key=" +
      encodeURIComponent(GEMINI_API_KEY),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: {
          parts: [{ text: systemPrompt }],
        },
        contents,
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 900,
        },
      }),
    }
  );

  try {
    const data = await readJsonResponse(response);
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts
      .map((part) => part?.text || "")
      .join("")
      .trim();

    return {
      provider: "Gemini",
      text: normalizeAnswer(text),
    };
  } catch (error) {
    if (error instanceof ProviderLimitError) throw error;

    const message = String(error?.message || error);
    const status = Number(message.match(/HTTP\s+(\d+)/)?.[1] || 0);

    if (isProviderLimitStatus(status)) {
      cooldownProvider("gemini");
      throw new ProviderLimitError("Gemini", message, status);
    }

    throw error;
  }
}

async function callGroq(messages, systemPrompt = GENERAL_SYSTEM_PROMPT) {
  if (!GROQ_API_KEY) {
    throw new ProviderLimitError(
      "Groq",
      "Groq API key is not configured"
    );
  }

  if (!providerAvailable("groq")) {
    throw new ProviderLimitError(
      "Groq",
      "Groq is temporarily in fallback cooldown"
    );
  }

  const groqMessages = [
    { role: "system", content: systemPrompt },
    ...messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];

  const response = await fetch(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: groqMessages,
        temperature: 0.6,
        max_tokens: 900,
      }),
    }
  );

  try {
    const data = await readJsonResponse(response);
    const text = data?.choices?.[0]?.message?.content || "";

    return {
      provider: "Groq",
      text: normalizeAnswer(text),
    };
  } catch (error) {
    const message = String(error?.message || error);
    const status = Number(message.match(/HTTP\s+(\d+)/)?.[1] || 0);

    if (isProviderLimitStatus(status)) {
      cooldownProvider("groq");
      throw new ProviderLimitError("Groq", message, status);
    }

    throw error;
  }
}

async function generateAssistantReply(chatId, userText, source = "text") {
  const cachedHistory = getHistory(chatId);

  let context = {
    messages: cachedHistory,
    memories: [],
  };

  try {
    context = await loadConversationContext(chatId, userText);
  } catch (error) {
    console.error("MongoDB context load failed; using temporary memory:", error);
  }

  const nextHistory = [
    ...context.messages,
    { role: "user", content: userText },
  ];

  const memoryLines = (context.memories || [])
    .map(
      (item) =>
        "- [" +
        String(item.type || "note") +
        "] " +
        String(item.memory || "")
    )
    .filter(Boolean)
    .slice(0, 12);

  const systemPrompt =
    GENERAL_SYSTEM_PROMPT +
    (memoryLines.length
      ? "\n\nLong-term memories about the owner that may be relevant:\n" +
        memoryLines.join("\n")
      : "");

  try {
    await saveConversationMessage({
      chatId,
      role: "user",
      content: userText,
      source,
    });
  } catch (error) {
    console.error("MongoDB user message save failed:", error);
  }

  try {
    await saveDetectedMemories(chatId, userText);
  } catch (error) {
    console.error("MongoDB memory extraction failed:", error);
  }

  const providers = [];

  if (GEMINI_API_KEY && providerAvailable("gemini-live")) {
    providers.push(callGeminiLive);
  }

  if (GEMINI_API_KEY && providerAvailable("gemini")) {
    providers.push(callGemini);
  }

  if (GROQ_API_KEY && providerAvailable("groq")) {
    providers.push(callGroq);
  }

  if (!providers.length) {
    throw new Error(
      "Both Gemini and Groq are temporarily unavailable"
    );
  }

  let lastError = null;

  for (const provider of providers) {
    try {
      const result = await provider(nextHistory, systemPrompt);

      saveHistory(chatId, [
        ...nextHistory,
        { role: "assistant", content: result.text },
      ]);

      try {
        await saveConversationMessage({
          chatId,
          role: "assistant",
          content: result.text,
          source: source === "voice" ? "voice" : "text",
        });
      } catch (error) {
        console.error("MongoDB assistant message save failed:", error);
      }

      return result;
    } catch (error) {
      lastError = error;

      if (!(error instanceof ProviderLimitError)) {
        throw error;
      }
    }
  }

  throw lastError || new Error("No LLM provider available");
}

async function transcribeWithGroq(buffer, mimeType = "audio/ogg") {
  if (!GROQ_API_KEY) {
    throw new ProviderLimitError(
      "Groq STT",
      "Groq API key is not configured"
    );
  }

  if (!providerAvailable("groq-stt")) {
    throw new ProviderLimitError(
      "Groq STT",
      "Groq STT is temporarily in fallback cooldown"
    );
  }

  const form = new FormData();

  form.append(
    "file",
    new Blob([buffer], { type: mimeType }),
    "telegram-voice.ogg"
  );

  form.append("model", GROQ_STT_MODEL);
  form.append("response_format", "json");
  form.append(
    "prompt",
    "Conversation may contain Bengali and English. Preserve names, technical terms, URLs, and code words accurately."
  );

  const response = await fetch(
    "https://api.groq.com/openai/v1/audio/transcriptions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + GROQ_API_KEY,
      },
      body: form,
    }
  );

  try {
    const data = await readJsonResponse(response);

    return normalizeAnswer(data?.text || "");
  } catch (error) {
    const message = String(error?.message || error);
    const status = Number(message.match(/HTTP\s+(\d+)/)?.[1] || 0);

    if (isProviderLimitStatus(status)) {
      cooldownProvider("groq-stt");
      throw new ProviderLimitError("Groq STT", message, status);
    }

    throw error;
  }
}

async function transcribeWithGemini(buffer, mimeType = "audio/ogg") {
  if (!GEMINI_API_KEY) {
    throw new ProviderLimitError(
      "Gemini STT",
      "Gemini API key is not configured"
    );
  }

  if (!providerAvailable("gemini-stt")) {
    throw new ProviderLimitError(
      "Gemini STT",
      "Gemini STT is temporarily in fallback cooldown"
    );
  }

  const audioBase64 = Buffer.from(buffer).toString("base64");

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/" +
      encodeURIComponent(GEMINI_MODEL) +
      ":generateContent?key=" +
      encodeURIComponent(GEMINI_API_KEY),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                inline_data: {
                  mime_type: mimeType,
                  data: audioBase64,
                },
              },
              {
                text:
                  "Transcribe this voice message exactly. Return only the spoken transcript. " +
                  "The speaker may use Bengali, English, or both. Preserve names and technical terms.",
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 2000,
        },
      }),
    }
  );

  try {
    const data = await readJsonResponse(response);
    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map((part) => part?.text || "")
        .join("")
        .trim();

    return normalizeAnswer(text);
  } catch (error) {
    const message = String(error?.message || error);
    const status = Number(message.match(/HTTP\s+(\d+)/)?.[1] || 0);

    if (isProviderLimitStatus(status)) {
      cooldownProvider("gemini-stt");
      throw new ProviderLimitError("Gemini STT", message, status);
    }

    throw error;
  }
}

async function transcribeVoice(buffer, mimeType) {
  const providers = [];

  if (GROQ_API_KEY && providerAvailable("groq-stt")) {
    providers.push(() => transcribeWithGroq(buffer, mimeType));
  }

  if (GEMINI_API_KEY && providerAvailable("gemini-stt")) {
    providers.push(() => transcribeWithGemini(buffer, mimeType));
  }

  if (!providers.length) {
    throw new Error("No speech-to-text provider is available");
  }

  let lastError = null;

  for (const provider of providers) {
    try {
      return await provider();
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProviderLimitError)) throw error;
    }
  }

  throw lastError || new Error("Speech transcription failed");
}

function prepareVoiceText(text) {
  const input = String(text || "").trim();
  if (input.length <= SARAH_VOICE_MAX_CHARS) return input;

  const chunk = input.slice(0, SARAH_VOICE_MAX_CHARS);
  const boundary = Math.max(
    chunk.lastIndexOf("।"),
    chunk.lastIndexOf("."),
    chunk.lastIndexOf("!"),
    chunk.lastIndexOf("?"),
    chunk.lastIndexOf("\n")
  );

  if (boundary >= Math.floor(SARAH_VOICE_MAX_CHARS * 0.55)) {
    return chunk.slice(0, boundary + 1).trim();
  }

  return chunk.trimEnd() + "…";
}

function voiceCacheKey(text) {
  return String(ELEVENLABS_VOICE_ID || "") + ":" + String(text || "").trim();
}

function getCachedVoice(text) {
  const key = voiceCacheKey(text);
  const hit = voiceCache.get(key);

  if (!hit) return null;

  if (Date.now() - hit.createdAt > SARAH_VOICE_CACHE_TTL_MS) {
    voiceCache.delete(key);
    return null;
  }

  return hit.audioBuffer;
}

function setCachedVoice(text, audioBuffer) {
  voiceCache.set(voiceCacheKey(text), {
    createdAt: Date.now(),
    audioBuffer,
  });

  if (voiceCache.size > 12) {
    const oldestKey = voiceCache.keys().next().value;
    if (oldestKey) voiceCache.delete(oldestKey);
  }
}

async function getElevenLabsQuota() {
  if (!ELEVENLABS_API_KEY) return null;

  try {
    const response = await fetch(
      "https://api.elevenlabs.io/v1/user/subscription",
      {
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) return null;

    return await response.json();
  } catch (error) {
    console.error("ElevenLabs quota check failed:", error);
    return null;
  }
}

async function elevenLabsSpeech(text) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);
  required("ELEVENLABS_VOICE_ID", ELEVENLABS_VOICE_ID);

  const speechText = prepareVoiceText(text);
  if (!speechText) {
    throw new Error("No text available for Sarah voice.");
  }

  const cached = getCachedVoice(speechText);
  if (cached) return cached;

  const quota = await getElevenLabsQuota();

  if (
    quota &&
    Number.isFinite(Number(quota.character_count)) &&
    Number.isFinite(Number(quota.character_limit)) &&
    Number(quota.character_count) >= Number(quota.character_limit) &&
    quota.max_credit_limit_extension !== "unlimited"
  ) {
    throw new Error(
      "Sarah voice quota is exhausted. Text reply is available until ElevenLabs credits reset."
    );
  }

  const url =
    "https://api.elevenlabs.io/v1/text-to-speech/" +
    encodeURIComponent(ELEVENLABS_VOICE_ID) +
    "?output_format=mp3_44100_128";

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text: speechText,
      model_id: ELEVENLABS_MODEL_ID,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());
  setCachedVoice(speechText, audioBuffer);
  return audioBuffer;
}

async function elevenLabsTranscribe(buffer, mimeType = "audio/ogg") {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);

  const form = new FormData();
  form.append(
    "file",
    new Blob([buffer], { type: mimeType }),
    "telegram-audio.ogg"
  );
  form.append("model_id", "scribe_v2");

  const response = await fetch(
    "https://api.elevenlabs.io/v1/speech-to-text",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: form,
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs STT HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  const data = await response.json();
  return normalizeAnswer(data?.text || "");
}

async function elevenLabsVoiceChange(
  buffer,
  mimeType = "audio/ogg"
) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);
  required("ELEVENLABS_VOICE_ID", ELEVENLABS_VOICE_ID);

  const form = new FormData();
  form.append(
    "audio",
    new Blob([buffer], { type: mimeType }),
    "telegram-voice.ogg"
  );
  form.append("model_id", "eleven_multilingual_sts_v2");

  const response = await fetch(
    "https://api.elevenlabs.io/v1/speech-to-speech/" +
      encodeURIComponent(ELEVENLABS_VOICE_ID) +
      "?output_format=mp3_44100_128",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: form,
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs Speech-to-Speech HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function elevenLabsIsolate(buffer, mimeType = "audio/ogg") {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);

  const form = new FormData();
  form.append(
    "audio",
    new Blob([buffer], { type: mimeType }),
    "telegram-audio.ogg"
  );

  const response = await fetch(
    "https://api.elevenlabs.io/v1/audio-isolation",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
      body: form,
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs Audio Isolation HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function elevenLabsSoundEffect(prompt) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);

  const response = await fetch(
    "https://api.elevenlabs.io/v1/sound-generation" +
      "?output_format=mp3_22050_32",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: prompt.slice(0, 4100),
        model_id: "eleven_text_to_sound_v2",
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs Sound Effects HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function elevenLabsMusic(prompt) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);

  const response = await fetch(
    "https://api.elevenlabs.io/v1/music" +
      "?output_format=mp3_44100_128",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: prompt.slice(0, 4100),
        music_length_ms: 15000,
        model_id: "music_v2_5",
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs Music HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function elevenLabsGenerateImage(prompt) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);

  const response = await fetch(
    "https://api.elevenlabs.io/v1/flows/image",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: ELEVENLABS_IMAGE_MODEL,
        prompt: prompt.slice(0, 4000),
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs Image HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return response.json();
}

async function elevenLabsGetImage(generationId) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);

  const response = await fetch(
    "https://api.elevenlabs.io/v1/flows/image/" +
      encodeURIComponent(generationId),
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs Image Status HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return response.json();
}

async function elevenLabsGenerateVideo(prompt) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);

  const response = await fetch(
    "https://api.elevenlabs.io/v1/flows/video",
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: ELEVENLABS_VIDEO_MODEL,
        prompt: prompt.slice(0, 4000),
        duration_secs: 8,
        aspect_ratio: "16:9",
        resolution: "720p",
        generate_audio: true,
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs Video HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return response.json();
}

async function elevenLabsGetVideo(generationId) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);

  const response = await fetch(
    "https://api.elevenlabs.io/v1/flows/video/" +
      encodeURIComponent(generationId),
    {
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
      },
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs Video Status HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return response.json();
}

async function getReplyVoice(ctx) {
  const target = ctx.message?.reply_to_message;
  if (!target?.voice?.file_id) {
    throw new Error(
      "Reply to a Telegram voice message with this command."
    );
  }

  return downloadTelegramVoice(ctx, target);
}

function formatApiEvent(event, index) {
  const duration = event.duration ?? "-";
  const durationMs = durationToMs(duration);
  const status = getStatus(event);
  const error = getError(event);

  let icon = "🟢";

  if (error || (typeof status === "number" && status >= 500)) {
    icon = "🔴";
  } else if (
    (typeof status === "number" && status >= 400) ||
    (durationMs ?? 0) >= SLOW_MS
  ) {
    icon = "🟡";
  }

  return [
    icon + " " + index + "️⃣ " + formatTime(event._time),
    getMethod(event) + " " + getRoute(event),
    "Duration: " + duration,
    "Status: " + (status ?? "-"),
    "Error: " + (error ?? "-"),
  ].join("\n");
}

function createBot() {
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.command("start", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    return ctx.reply(
      "✅ Sarah is online!\n\n" +
        "Your private AI partner and assistant.\n\n" +
        "Commands:\n" +
        "/start — help\n" +
        "/ping — bot test\n" +
        "/status — system health\n" +
        "/axiom — recent API events\n" +
        "/axiomraw — raw Axiom event\n" +
        "/voicetest — test Sarah's ElevenLabs voice\n" +
        "/say — make Sarah speak text\n" +
        "/elevenstt — transcribe a replied voice with ElevenLabs\n" +
        "/voicechange — transform a replied voice into Sarah's voice\n" +
        "/isolate — clean a replied voice from background noise\n" +
        "/sfx — generate a sound effect\n" +
        "/music — generate music\n" +
        "/image — generate an image\n" +
        "/imagestatus — check an image generation\n" +
        "/video — generate a video\n" +
        "/videostatus — check a video generation\n" +
        "/mongotest — test persistent memory\n" +
        "/memory — memory stats\n" +
        "/remember — save an important memory\n" +
        "/reset — reset Sarah conversation\n\n" +
        "You can also send normal text or a voice message for general conversation."
    );
  });

  bot.command("ping", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");
    return ctx.reply("🏓 Pong! Guardian AI is working.");
  });

  bot.command("voicetest", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    try {
      const audioBuffer = await elevenLabsSpeech(
        "Hi. I'm Sarah. This is a direct ElevenLabs voice test."
      );

      return ctx.replyWithVoice(
        new InputFile(audioBuffer, "sarah-voicetest.mp3"),
        { caption: "💗 Sarah" }
      );
    } catch (error) {
      console.error("ElevenLabs /voicetest error:", error);
      return ctx.reply(
        "❌ Sarah voice test failed.\n\n" +
          (error?.message || "ElevenLabs request failed.")
      );
    }
  });

  bot.command("say", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    const text = String(ctx.match || "").trim();
    if (!text) {
      return ctx.reply(
        "Use: /say <what Sarah should say>\n\n" +
        "Voice-saving mode: long text is shortened automatically."
      );
    }

    try {
      const audioBuffer = await elevenLabsSpeech(text);
      return ctx.replyWithVoice(
        new InputFile(audioBuffer, "sarah-say.mp3"),
        { caption: "💗 Sarah" }
      );
    } catch (error) {
      console.error("ElevenLabs /say error:", error);
      return ctx.reply(
        "❌ Sarah voice failed.\n\n" +
          (error?.message || "ElevenLabs request failed.")
      );
    }
  });

  bot.command("sfx", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    const prompt = String(ctx.match || "").trim();
    if (!prompt) {
      return ctx.reply("Use: /sfx <sound effect description>");
    }

    try {
      const audioBuffer = await elevenLabsSoundEffect(prompt);
      return ctx.replyWithAudio(
        new InputFile(audioBuffer, "sarah-sfx.mp3"),
        { caption: "🔊 Sarah sound effect" }
      );
    } catch (error) {
      console.error("ElevenLabs /sfx error:", error);
      return ctx.reply(
        "❌ Sound effect failed.\n\n" +
          (error?.message || "ElevenLabs request failed.")
      );
    }
  });

  bot.command("music", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    const prompt = String(ctx.match || "").trim();
    if (!prompt) {
      return ctx.reply("Use: /music <music description>");
    }

    try {
      const audioBuffer = await elevenLabsMusic(prompt);
      return ctx.replyWithAudio(
        new InputFile(audioBuffer, "sarah-music.mp3"),
        { caption: "🎵 Sarah" }
      );
    } catch (error) {
      console.error("ElevenLabs /music error:", error);
      return ctx.reply(
        "❌ Music generation failed.\n\n" +
          (error?.message || "ElevenLabs request failed.")
      );
    }
  });

  bot.command("elevenstt", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    try {
      const audio = await getReplyVoice(ctx);
      const transcript = await elevenLabsTranscribe(
        audio.buffer,
        audio.mimeType
      );

      return ctx.reply("📝 " + truncate(transcript, 3500));
    } catch (error) {
      console.error("ElevenLabs /elevenstt error:", error);
      return ctx.reply(
        "❌ ElevenLabs transcription failed.\n\n" +
          (error?.message || "Request failed.")
      );
    }
  });

  bot.command("isolate", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    try {
      const audio = await getReplyVoice(ctx);
      const cleaned = await elevenLabsIsolate(
        audio.buffer,
        audio.mimeType
      );

      return ctx.replyWithAudio(
        new InputFile(cleaned, "sarah-isolated.mp3"),
        { caption: "✨ Cleaned voice" }
      );
    } catch (error) {
      console.error("ElevenLabs /isolate error:", error);
      return ctx.reply(
        "❌ Audio isolation failed.\n\n" +
          (error?.message || "Request failed.")
      );
    }
  });

  bot.command("voicechange", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    try {
      const audio = await getReplyVoice(ctx);
      const changed = await elevenLabsVoiceChange(
        audio.buffer,
        audio.mimeType
      );

      return ctx.replyWithVoice(
        new InputFile(changed, "sarah-voicechange.mp3"),
        { caption: "💗 Sarah voice" }
      );
    } catch (error) {
      console.error("ElevenLabs /voicechange error:", error);
      return ctx.reply(
        "❌ Voice transformation failed.\n\n" +
          (error?.message || "Request failed.")
      );
    }
  });

  bot.command("image", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    const prompt = String(ctx.match || "").trim();
    if (!prompt) {
      return ctx.reply("Use: /image <image prompt>");
    }

    try {
      const job = await elevenLabsGenerateImage(prompt);
      return ctx.reply(
        "🎨 Sarah image generation started.\n\n" +
          "ID: " + job.id +
          "\n\nCheck with:\n/imagestatus " + job.id
      );
    } catch (error) {
      console.error("ElevenLabs /image error:", error);
      return ctx.reply(
        "❌ Image generation failed.\n\n" +
          (error?.message || "Request failed.")
      );
    }
  });

  bot.command("imagestatus", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    const id = String(ctx.match || "").trim();
    if (!id) {
      return ctx.reply("Use: /imagestatus <generation_id>");
    }

    try {
      const result = await elevenLabsGetImage(id);

      if (result.status !== "completed") {
        if (result.status === "failed") {
          return ctx.reply(
            "❌ Sarah image generation failed.\n\n" +
              (result.error_message || result.failure_reason || "Unknown error")
          );
        }

        return ctx.reply(
          "⏳ Sarah image is still " +
            String(result.status || "processing") +
            "."
        );
      }

      if (!result.content_url) {
        return ctx.reply("✅ Image completed, but no download URL was returned.");
      }

      return ctx.replyWithPhoto(result.content_url, {
        caption: "💗 Sarah",
      });
    } catch (error) {
      console.error("ElevenLabs /imagestatus error:", error);
      return ctx.reply(
        "❌ Image status check failed.\n\n" +
          (error?.message || "Request failed.")
      );
    }
  });

  bot.command("video", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    const prompt = String(ctx.match || "").trim();
    if (!prompt) {
      return ctx.reply("Use: /video <video prompt>");
    }

    try {
      const job = await elevenLabsGenerateVideo(prompt);
      return ctx.reply(
        "🎬 Sarah video generation started.\n\n" +
          "ID: " + job.id +
          "\n\nCheck with:\n/videostatus " + job.id
      );
    } catch (error) {
      console.error("ElevenLabs /video error:", error);
      return ctx.reply(
        "❌ Video generation failed.\n\n" +
          (error?.message || "Request failed.")
      );
    }
  });

  bot.command("videostatus", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    const id = String(ctx.match || "").trim();
    if (!id) {
      return ctx.reply("Use: /videostatus <generation_id>");
    }

    try {
      const result = await elevenLabsGetVideo(id);

      if (result.status !== "completed") {
        if (result.status === "failed") {
          return ctx.reply(
            "❌ Sarah video generation failed.\n\n" +
              (result.error_message || result.failure_reason || "Unknown error")
          );
        }

        return ctx.reply(
          "⏳ Sarah video is still " +
            String(result.status || "processing") +
            "."
        );
      }

      if (!result.content_url) {
        return ctx.reply("✅ Video completed, but no download URL was returned.");
      }

      return ctx.replyWithVideo(result.content_url, {
        caption: "💗 Sarah",
      });
    } catch (error) {
      console.error("ElevenLabs /videostatus error:", error);
      return ctx.reply(
        "❌ Video status check failed.\n\n" +
          (error?.message || "Request failed.")
      );
    }
  });

  bot.command("mongotest", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    try {
      const result = await testMongoConnection();
      return ctx.reply(
        "✅ Sarah memory database is connected.\n\n" +
          "Database: " +
          result.database +
          "\nStored messages: " +
          result.messages
      );
    } catch (error) {
      console.error("MongoDB /mongotest error:", error);
      return ctx.reply(
        "❌ Sarah memory database test failed.\n\n" +
          (error?.message || "MongoDB connection failed.")
      );
    }
  });

  bot.command("memory", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    try {
      const stats = await getMemoryStats(ctx.chat.id);
      const last =
        stats.lastMemory?.memory
          ? "\n\nLatest saved memory:\n" +
            stats.lastMemory.memory
          : "";

      return ctx.reply(
        "🧠 Sarah memory\n\n" +
          "Messages saved: " +
          stats.messages +
          "\nLong-term memories: " +
          stats.memories +
          last
      );
    } catch (error) {
      console.error("MongoDB /memory error:", error);
      return ctx.reply(
        "❌ Could not read Sarah memory.\n\n" +
          (error?.message || "MongoDB is unavailable.")
      );
    }
  });

  bot.command("remember", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    const memory = String(ctx.match || "").trim();

    if (!memory) {
      return ctx.reply(
        "Use: /remember <something Sarah should remember>"
      );
    }

    try {
      await saveMemory(ctx.chat.id, memory, "manual", 5);
      return ctx.reply("💗 Got it. Sarah will remember that.");
    } catch (error) {
      console.error("MongoDB /remember error:", error);
      return ctx.reply(
        "❌ I couldn't save that memory.\n\n" +
          (error?.message || "MongoDB is unavailable.")
      );
    }
  });

  bot.command("reset", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");
    resetHistory(ctx.chat.id);
    return ctx.reply("🧠 Sarah's conversation memory has been reset.");
  });

  bot.command("status", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    await ctx.reply("📊 Checking system status...");

    try {
      const serverEvents = await getRecentServerEvents();
      const apiEvents = serverEvents.filter(isUsefulApiEvent);

      if (!apiEvents.length) {
        return ctx.reply(
          "ℹ️ SYSTEM STATUS\n\n" +
            "Service: " +
            AXIOM_DATASET +
            "\nWindow: Last 5 minutes\n\n" +
            "No routed API events found."
        );
      }

      const durations = apiEvents
        .map((event) => ({ event, ms: durationToMs(event.duration) }))
        .filter((item) => item.ms !== null);

      const errorEvents = apiEvents.filter(
        (event) => getError(event) !== null
      );

      const statusErrorEvents = apiEvents.filter((event) => {
        const status = getStatus(event);
        return typeof status === "number" && status >= 400;
      });

      const slow = durations.filter((item) => item.ms >= SLOW_MS);
      const verySlow = durations.filter(
        (item) => item.ms >= VERY_SLOW_MS
      );

      const slowest = [...durations]
        .sort((a, b) => b.ms - a.ms)
        .slice(0, 5);

      const fastest = [...durations]
        .sort((a, b) => a.ms - b.ms)
        .slice(0, 3);

      const errorSet = new Set([
        ...errorEvents,
        ...statusErrorEvents,
      ]);

      const health =
        errorSet.size || verySlow.length
          ? "🔴 ATTENTION REQUIRED"
          : slow.length
            ? "🟡 SLOW ACTIVITY"
            : "🟢 HEALTHY";

      const lines = [
        "📊 SYSTEM STATUS",
        "",
        "Service: " +
          (serverEvents[0]?.["service.name"] ?? AXIOM_DATASET),
        "Window: Last 5m",
        "",
        health,
        "",
        "📡 API events inspected (max 50): " + apiEvents.length,
        "🟡 Slow APIs (>1s): " + slow.length,
        "🔴 Very slow APIs (>3s): " + verySlow.length,
        "❌ Errors detected: " + errorSet.size,
        "",
        "🐌 SLOWEST APIs",
        "",
        slowest.length
          ? slowest
              .map(
                (x, i) =>
                  i +
                  1 +
                  ". " +
                  getMethod(x.event) +
                  " " +
                  getRoute(x.event) +
                  " — " +
                  x.event.duration
              )
              .join("\n")
          : "None",
        "",
        "⚡ FASTEST APIs",
        "",
        fastest.length
          ? fastest
              .map(
                (x, i) =>
                  i +
                  1 +
                  ". " +
                  getMethod(x.event) +
                  " " +
                  getRoute(x.event) +
                  " — " +
                  x.event.duration
              )
              .join("\n")
          : "None",
        "",
        "🕒 LATEST API EVENT",
        "",
        formatTime(apiEvents[0]._time),
        getMethod(apiEvents[0]) + " " + getRoute(apiEvents[0]),
        "Duration: " + (apiEvents[0].duration ?? "-"),
        "Status: " + (getStatus(apiEvents[0]) ?? "-"),
        "Error: " + (getError(apiEvents[0]) ?? "-"),
      ];

      return ctx.reply(truncate(lines.join("\n")));
    } catch (error) {
      console.error("Axiom /status error:", error);
      return ctx.reply(
        "❌ Status check failed.\n\nError: " +
          (error?.message || "Unknown error")
      );
    }
  });

  bot.command("axiom", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    await ctx.reply("📡 Checking recent API events...");

    try {
      const events = (await getRecentServerEvents()).filter(
        isUsefulApiEvent
      );

      if (!events.length) {
        return ctx.reply(
          "ℹ️ No routed API events found in the last 5 minutes."
        );
      }

      return ctx.reply(
        truncate(
          "📡 AXIOM — API\n\n" +
            "Dataset: " +
            AXIOM_DATASET +
            "\nWindow: Last 5 minutes\n\n" +
            events
              .slice(0, 10)
              .map((event, index) =>
                formatApiEvent(event, index + 1)
              )
              .join("\n\n")
        )
      );
    } catch (error) {
      console.error("Axiom /axiom error:", error);
      return ctx.reply(
        "❌ Axiom query failed.\n\nError: " +
          (error?.message || "Unknown error")
      );
    }
  });

  bot.command("axiomraw", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");

    try {
      const events = await getRecentRawEvents(1);

      if (!events.length) {
        return ctx.reply("⚠️ No event found in the last 5 minutes.");
      }

      return ctx.reply(
        truncate(
          "🔎 RAW AXIOM EVENT\n\n" +
            JSON.stringify(events[0], null, 2),
          3500
        )
      );
    } catch (error) {
      console.error("Axiom /axiomraw error:", error);
      return ctx.reply("❌ Failed to read Axiom event.");
    }
  });

  async function handleTextConversation(ctx) {
    if (!isOwner(ctx)) return;

    const text = String(ctx.message?.text || "").trim();
    if (!text || text.startsWith("/")) return;

    await ctx.api.sendChatAction(ctx.chat.id, "typing");

    try {
      const result = await generateAssistantReply(ctx.chat.id, text);

      return ctx.reply(truncate(result.text));
    } catch (error) {
      console.error("Text conversation error:", error);

      return ctx.reply(
        "❌ AI conversation failed.\n\n" +
          (error?.message || "No provider available.")
      );
    }
  }

  async function handleVoiceConversation(ctx) {
    if (!isOwner(ctx)) return;

    await ctx.api.sendChatAction(ctx.chat.id, "record_voice");

    try {
      const audio = await downloadTelegramVoice(ctx);
      const transcript = await transcribeVoice(
        audio.buffer,
        audio.mimeType
      );

      await ctx.api.sendChatAction(ctx.chat.id, "typing");

      const result = await generateAssistantReply(
        ctx.chat.id,
        transcript,
        "voice"
      );

      if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
        return ctx.reply(
          "📝 Voice transcript:\n" +
            transcript +
            "\n\n🤖 " +
            result.text +
            "\n\n⚠️ ElevenLabs voice is not configured yet."
        );
      }

      await ctx.api.sendChatAction(
        ctx.chat.id,
        "record_voice"
      );

      try {
        const audioBuffer = await elevenLabsSpeech(result.text);

        return ctx.replyWithVoice(
          new InputFile(audioBuffer, "sarah-reply.mp3"),
          {
            caption: "💗 Sarah",
          }
        );
      } catch (ttsError) {
        console.error("ElevenLabs TTS error:", ttsError);

        return ctx.reply(
          "💗 Sarah:\n" +
            truncate(result.text, 3000) +
            "\n\n⚠️ I couldn't generate the voice right now, so I sent this as text."
        );
      }
    } catch (error) {
      console.error("Voice conversation error:", error);

      return ctx.reply(
        "❌ Voice conversation failed.\n\n" +
          (error?.message || "Unknown error")
      );
    }
  }

  bot.on("message:voice", handleVoiceConversation);
  bot.on("message:text", handleTextConversation);

  bot.catch((error) => {
    console.error("Telegram bot error:", error);
  });

  return bot;
}

function pick(obj, ...keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") {
      return value;
    }
  }
  return null;
}

async function sendAxiomAlert(payload) {
  if (!AXIOM_WEBHOOK_SECRET) {
    throw new Error("AXIOM_WEBHOOK_SECRET is missing");
  }

  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  const nested =
    payload?.event ??
    payload?.Event ??
    payload?.data ??
    payload;

  const action =
    pick(payload, "action", "Action") ?? "Open";

  const title =
    pick(nested, "title", "Title", "name", "Name") ??
    "Axiom Monitor Alert";

  const description =
    pick(nested, "description", "Description") ?? "";

  const body =
    pick(nested, "body", "Body", "message", "Message") ?? "";

  const value =
    pick(nested, "value", "Value");

  const monitorId =
    pick(nested, "monitorID", "monitorId", "MonitorID", "id");

  const matchedEvent =
    pick(nested, "matchedEvent", "MatchedEvent");

  let message =
    (String(action).toLowerCase() === "closed" ? "✅" : "🚨") +
    " AXIOM ALERT\n\n";

  message += "Status: " + action + "\n";
  message += "Monitor: " + title + "\n";

  if (monitorId) {
    message += "Monitor ID: " + monitorId + "\n";
  }

  if (description) {
    message += "\nDescription:\n" + description + "\n";
  }

  if (body) {
    message += "\nDetails:\n" + body + "\n";
  }

  if (value !== null) {
    message += "\nValue: " + value + "\n";
  }

  if (matchedEvent !== null) {
    let matched;

    try {
      matched = JSON.stringify(matchedEvent, null, 2);
    } catch {
      matched = String(matchedEvent);
    }

    message +=
      "\nMatched Event:\n" +
      truncate(matched, 1600);
  }

  if (!description && !body && matchedEvent === null) {
    message +=
      "\nPayload:\n" +
      truncate(JSON.stringify(payload, null, 2), 2000);
  }

  await bot.api.sendMessage(
    OWNER_CHAT_ID,
    truncate(message)
  );
}

module.exports = {
  AXIOM_WEBHOOK_SECRET,
  GEMINI_LIVE_MODEL,
  createBot,
  sendAxiomAlert,
};
