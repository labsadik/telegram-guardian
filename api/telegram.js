module.exports = async function handler(req, res) {
  const body = req.body ?? {};

  const message = body?.message;
  const text = typeof message?.text === "string"
    ? message.text.trim()
    : "";

  // Fast-path /start: no grammY, Axiom, Gemini, Groq, or ElevenLabs
  // modules are loaded for this command.
  if (text === "/start" || text.startsWith("/start@")) {
    const ownerChatId = Number(process.env.OWNER_CHAT_ID);
    const chatId = message?.chat?.id;

    const reply =
      Number(chatId) === ownerChatId
        ? "✅ Sarah is online!\n\n" +
          "Your private AI partner and assistant.\n\n" +
          "Commands:\n" +
          "/start — help\n" +
          "/ping — bot test\n" +
          "/status — system health\n" +
          "/axiom — recent API events\n" +
          "/axiomraw — raw Axiom event\n" +
          "/voicetest — test Sarah voice\n" +
          "/say — text to voice\n" +
          "/elevenstt — voice to text\n" +
          "/voicechange — voice to Sarah voice\n" +
          "/isolate — clean replied voice\n" +
          "/sfx — generate sound effect\n" +
          "/music — generate music\n" +
          "/image — generate image\n" +
          "/imagestatus — check image\n" +
          "/video — generate video\n" +
          "/videostatus — check video\n" +
          "/mongotest — test memory database\n" +
          "/memory — memory stats\n" +
          "/remember — save important memory\n" +
          "/reset — reset Sarah conversation\n\n" +
          "Send text for text chat, or a voice message for voice conversation."
        : "⛔ Unauthorized.";

    return res.status(200).json({
      method: "sendMessage",
      chat_id: chatId,
      text: reply,
    });
  }

  const { webhookCallback } = require("grammy");
  const { createBot } = require("../lib/guardian");
  const bot = createBot();

  return webhookCallback(bot, "https")(req, res);
};
