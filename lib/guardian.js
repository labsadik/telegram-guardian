const { Bot, InputFile } = require("grammy");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID);

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET || "test";
const AXIOM_WEBHOOK_SECRET = process.env.AXIOM_WEBHOOK_SECRET;

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const GROQ_STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL_ID =
  process.env.ELEVENLABS_MODEL_ID || "eleven_multilingual_v2";

const TIME_WINDOW = "5m";
const MAX_EVENTS = 50;
const SLOW_MS = 1000;
const VERY_SLOW_MS = 3000;

const MAX_HISTORY_MESSAGES = 16;
const PROVIDER_COOLDOWN_MS = 5 * 60 * 1000;
const MAX_TELEGRAM_VOICE_BYTES = 20 * 1024 * 1024;

const conversation = new Map();
const providerCooldown = new Map();

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
  "Have natural, warm, caring, playful, supportive conversation like a close long-term partner while staying respectful and emotionally healthy.",
  "You can discuss any normal topic: daily life, feelings, relationships, ideas, technology, coding, work, entertainment, plans, jokes, and casual conversation.",
  "Remember and naturally use relevant details from the conversation history during the current session.",
  "Do not make the conversation about the monitoring project unless the user asks about it.",
  "When the user asks about servers, logs, deployments, or monitoring, be accurate and never invent live data or claim to have checked something unless the application actually supplied that data.",
  "Match the user's language and style; Bengali is preferred when the user writes Bengali, and casual mixed Bengali-English is fine.",
  "Keep replies natural and conversational rather than sounding like a help desk. Avoid repeatedly saying you are an AI.",
  "Do not claim to be a human or pretend to have a physical presence or real-world actions that you did not perform.",
  "For voice conversations, write replies that sound natural when spoken aloud.",
].join(" ");async function callGemini(messages) {
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
          parts: [{ text: GENERAL_SYSTEM_PROMPT }],
        },
        contents,
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 1200,
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

async function callGroq(messages) {
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
    { role: "system", content: GENERAL_SYSTEM_PROMPT },
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
        temperature: 0.7,
        max_tokens: 1200,
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

async function generateAssistantReply(chatId, userText) {
  const history = getHistory(chatId);
  const nextHistory = [
    ...history,
    { role: "user", content: userText },
  ];

  const providers = [];

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
      const result = await provider(nextHistory);

      saveHistory(chatId, [
        ...nextHistory,
        { role: "assistant", content: result.text },
      ]);

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

async function elevenLabsSpeech(text) {
  required("ELEVENLABS_API_KEY", ELEVENLABS_API_KEY);
  required("ELEVENLABS_VOICE_ID", ELEVENLABS_VOICE_ID);

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
      text: text.slice(0, 4500),
      model_id: ELEVENLABS_MODEL_ID,
    }),
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      "ElevenLabs HTTP " +
        response.status +
        ": " +
        body.slice(0, 500)
    );
  }

  return Buffer.from(await response.arrayBuffer());
}

async function downloadTelegramVoice(ctx) {
  const voice = ctx.message?.voice;

  if (!voice?.file_id) {
    throw new Error("Telegram voice file is missing");
  }

  const file = await ctx.api.getFile(voice.file_id);
  const filePath = file?.file_path;

  if (!filePath) {
    throw new Error("Telegram did not return a file path");
  }

  const response = await fetch(
    "https://api.telegram.org/file/bot" +
      encodeURIComponent(TELEGRAM_BOT_TOKEN) +
      "/" +
      filePath
  );

  if (!response.ok) {
    throw new Error(
      "Telegram file download failed: HTTP " + response.status
    );
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.length > MAX_TELEGRAM_VOICE_BYTES) {
    throw new Error("Voice message is too large");
  }

  return {
    buffer,
    mimeType: voice.mime_type || "audio/ogg",
  };
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
        "/reset — reset AI conversation\n\n" +
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
        transcript
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
          "🗣️ " +
            truncate(transcript, 700) +
            "\n\n💗 Sarah:\n" +
            truncate(result.text, 3000) +
            "\n\n⚠️ Voice generation failed, so I sent the reply as text."
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
  createBot,
  sendAxiomAlert,
};
