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
        ? "✅ Guardian AI is online!\n\n" +
          "Private owner-only assistant.\n\n" +
          "Commands:\n" +
          "/start — help\n" +
          "/ping — bot test\n" +
          "/status — system health\n" +
          "/axiom — recent API events\n" +
          "/axiomraw — raw Axiom event\n" +
          "/reset — reset AI conversation\n\n" +
          "You can also send normal text or a voice message for general conversation."
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
