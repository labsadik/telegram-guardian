const { webhookCallback } = require("grammy");
const { createBot } = require("../lib/guardian");

const bot = createBot();

module.exports = webhookCallback(bot, "https");
