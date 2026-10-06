const {
  createBot,
} = require("../../lib/guardian");

const {
  webhookCallback,
} = require("grammy");

const bot =
  createBot();

module.exports =
  webhookCallback(
    bot,
    "https"
  );