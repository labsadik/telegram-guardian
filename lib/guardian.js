const { Bot } = require("grammy");
const { Axiom } = require("@axiomhq/js");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID);
const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET || "test";
const AXIOM_WEBHOOK_SECRET = process.env.AXIOM_WEBHOOK_SECRET;

const TIME_WINDOW = "5m";
const MAX_EVENTS = 50;
const SLOW_MS = 1000;
const VERY_SLOW_MS = 3000;

if (!TELEGRAM_BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN is missing");
if (!Number.isSafeInteger(OWNER_CHAT_ID) || OWNER_CHAT_ID <= 0) throw new Error("OWNER_CHAT_ID is invalid");
if (!AXIOM_TOKEN) throw new Error("AXIOM_TOKEN is missing");
if (!AXIOM_DATASET) throw new Error("AXIOM_DATASET is missing");

const axiom = new Axiom({ token: AXIOM_TOKEN });

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
  return date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

function durationToMs(duration) {
  if (duration === null || duration === undefined) return null;
  const match = String(duration).trim().match(/^([\d.]+)\s*(ns|µs|us|ms|s|m)$/i);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  switch (match[2].toLowerCase()) {
    case "ns": return number / 1_000_000;
    case "µs":
    case "us": return number / 1_000;
    case "ms": return number;
    case "s": return number * 1_000;
    case "m": return number * 60_000;
    default: return null;
  }
}

function getMethod(event) {
  const direct = event["attributes.http.request.method"] ?? event["attributes.http.request.method_original"];
  if (direct) return String(direct).toUpperCase();
  const match = String(event.name ?? "").trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i);
  return match ? match[1].toUpperCase() : "-";
}

function getRoute(event) {
  const direct = event["attributes.http.route"] ?? event["attributes.url.path"];
  if (direct) return String(direct);
  const match = String(event.name ?? "").trim().match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i);
  return match ? match[2] : "-";
}

function getStatus(event) {
  const value = event["attributes.http.response.status_code"] ?? event["status.code"];
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : String(value);
}

function getError(event) {
  if (event.error !== null && event.error !== undefined && String(event.error).trim()) return String(event.error);
  if (event["status.message"]) return String(event["status.message"]);
  if (event["attributes.error.type"]) return String(event["attributes.error.type"]);
  return null;
}

function isUsefulApiEvent(event) {
  return getMethod(event) !== "-" && getRoute(event) !== "-";
}

async function queryRows(apl, limit) {
  const result = await axiom.query(apl);
  const table = result.tables?.[0];
  if (!table || typeof table.events !== "function") return [];
  const rows = [];
  for await (const event of table.events()) {
    rows.push(event);
    if (rows.length >= limit) break;
  }
  return rows;
}

async function getRecentServerEvents(limit = MAX_EVENTS) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || MAX_EVENTS, MAX_EVENTS));
  const query = [
    "['" + AXIOM_DATASET + "']",
    "| where _time >= ago(" + TIME_WINDOW + ")",
    "| where kind == 'server'",
    "| project _time, name, kind, duration, error, ['service.name'],",
    "    ['attributes.http.request.method'], ['attributes.http.request.method_original'],",
    "    ['attributes.http.response.status_code'], ['attributes.http.route'],",
    "    ['attributes.url.path'], ['attributes.error.type'], ['status.code'], ['status.message']",
    "| sort by _time desc",
    "| take " + safeLimit
  ].join("\n");
  return queryRows(query, safeLimit);
}

async function getRecentRawEvents(limit = 1) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 1, 5));
  const query = [
    "['" + AXIOM_DATASET + "']",
    "| where _time >= ago(" + TIME_WINDOW + ")",
    "| sort by _time desc",
    "| take " + safeLimit
  ].join("\n");
  return queryRows(query, safeLimit);
}

function formatApiEvent(event, index) {
  const duration = event.duration ?? "-";
  const durationMs = durationToMs(duration);
  const status = getStatus(event);
  const error = getError(event);
  let icon = "🟢";
  if (error || (typeof status === "number" && status >= 500)) icon = "🔴";
  else if ((typeof status === "number" && status >= 400) || (durationMs ?? 0) >= SLOW_MS) icon = "🟡";
  return [
    icon + " " + index + "️⃣ " + formatTime(event._time),
    getMethod(event) + " " + getRoute(event),
    "Duration: " + duration,
    "Status: " + (status ?? "-"),
    "Error: " + (error ?? "-")
  ].join("\n");
}

function createBot() {
  const bot = new Bot(TELEGRAM_BOT_TOKEN);

  bot.command("start", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");
    return ctx.reply(
      "✅ Guardian Bot is online!\n\n" +
      "Telegram ID: " + ctx.chat.id + "\n" +
      "You are authorized.\n\n" +
      "Commands:\n/start\n/ping\n/status\n/axiom\n/axiomraw"
    );
  });

  bot.command("ping", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");
    return ctx.reply("🏓 Pong! Bot is working.");
  });

  bot.command("status", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");
    await ctx.reply("📊 Checking system status...");
    try {
      const serverEvents = await getRecentServerEvents();
      const apiEvents = serverEvents.filter(isUsefulApiEvent);
      if (!apiEvents.length) {
        return ctx.reply(
          "ℹ️ SYSTEM STATUS\n\nService: " + AXIOM_DATASET +
          "\nWindow: Last 5 minutes\n\nNo routed API events found."
        );
      }

      const durations = apiEvents.map(event => ({ event, ms: durationToMs(event.duration) })).filter(x => x.ms !== null);
      const errorEvents = apiEvents.filter(event => getError(event) !== null);
      const statusErrorEvents = apiEvents.filter(event => {
        const status = getStatus(event);
        return typeof status === "number" && status >= 400;
      });
      const slow = durations.filter(x => x.ms >= SLOW_MS);
      const verySlow = durations.filter(x => x.ms >= VERY_SLOW_MS);
      const slowest = [...durations].sort((a,b) => b.ms-a.ms).slice(0,5);
      const fastest = [...durations].sort((a,b) => a.ms-b.ms).slice(0,3);
      const errorSet = new Set([...errorEvents, ...statusErrorEvents]);

      const health =
        errorSet.size || verySlow.length ? "🔴 ATTENTION REQUIRED" :
        slow.length ? "🟡 SLOW ACTIVITY" : "🟢 HEALTHY";

      const lines = [
        "📊 SYSTEM STATUS",
        "",
        "Service: " + (serverEvents[0]?.["service.name"] ?? AXIOM_DATASET),
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
        slowest.length ? slowest.map((x,i) => (i+1)+". "+getMethod(x.event)+" "+getRoute(x.event)+" — "+x.event.duration).join("\n") : "None",
        "",
        "⚡ FASTEST APIs",
        "",
        fastest.length ? fastest.map((x,i) => (i+1)+". "+getMethod(x.event)+" "+getRoute(x.event)+" — "+x.event.duration).join("\n") : "None",
        "",
        "🕒 LATEST API EVENT",
        "",
        formatTime(apiEvents[0]._time),
        getMethod(apiEvents[0])+" "+getRoute(apiEvents[0]),
        "Duration: "+(apiEvents[0].duration ?? "-"),
        "Status: "+(getStatus(apiEvents[0]) ?? "-"),
        "Error: "+(getError(apiEvents[0]) ?? "-")
      ];

      return ctx.reply(truncate(lines.join("\n")));
    } catch (error) {
      console.error("Axiom /status error:", error);
      return ctx.reply("❌ Status check failed.\n\nError: " + (error?.message || "Unknown error"));
    }
  });

  bot.command("axiom", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");
    await ctx.reply("📡 Checking recent API events...");
    try {
      const events = (await getRecentServerEvents()).filter(isUsefulApiEvent);
      if (!events.length) return ctx.reply("ℹ️ No routed API events found in the last 5 minutes.");
      return ctx.reply(truncate(
        "📡 AXIOM — API\n\nDataset: " + AXIOM_DATASET +
        "\nWindow: Last 5 minutes\nEvents displayed: " + Math.min(events.length,10) +
        "\n\n" + events.slice(0,10).map((e,i)=>formatApiEvent(e,i+1)).join("\n\n")
      ));
    } catch (error) {
      console.error("Axiom /axiom error:", error);
      return ctx.reply("❌ Axiom query failed.\n\nError: " + (error?.message || "Unknown error"));
    }
  });

  bot.command("axiomraw", async (ctx) => {
    if (!isOwner(ctx)) return ctx.reply("⛔ Unauthorized.");
    try {
      const events = await getRecentRawEvents(1);
      if (!events.length) return ctx.reply("⚠️ No event found in the last 5 minutes.");
      return ctx.reply(truncate("🔎 RAW AXIOM EVENT\n\n" + JSON.stringify(events[0], null, 2), 3500));
    } catch (error) {
      console.error("Axiom /axiomraw error:", error);
      return ctx.reply("❌ Failed to read Axiom event.");
    }
  });

  bot.on("message:text", async (ctx) => {
    if (!isOwner(ctx) || !ctx.message.text.startsWith("/")) return;
    return ctx.reply("❓ Unknown command.\n\n/start\n/ping\n/status\n/axiom\n/axiomraw");
  });

  bot.catch(error => console.error("Telegram bot error:", error));
  return bot;
}

function pick(obj, ...keys) {
  for (const key of keys) {
    const value = obj?.[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return null;
}

async function sendAxiomAlert(payload) {
  if (!AXIOM_WEBHOOK_SECRET) throw new Error("AXIOM_WEBHOOK_SECRET is missing");

  const bot = new Bot(TELEGRAM_BOT_TOKEN);
  const nested = payload?.event ?? payload?.Event ?? payload?.data ?? payload;
  const action = pick(payload, "action", "Action") ?? "Open";
  const title = pick(nested, "title", "Title", "name", "Name") ?? "Axiom Monitor Alert";
  const description = pick(nested, "description", "Description") ?? "";
  const body = pick(nested, "body", "Body", "message", "Message") ?? "";
  const value = pick(nested, "value", "Value");
  const monitorId = pick(nested, "monitorID", "monitorId", "MonitorID", "id");
  const matchedEvent = pick(nested, "matchedEvent", "MatchedEvent");

  let message = (String(action).toLowerCase() === "closed" ? "✅" : "🚨") + " AXIOM ALERT\n\n";
  message += "Status: " + action + "\nMonitor: " + title + "\n";
  if (monitorId) message += "Monitor ID: " + monitorId + "\n";
  if (description) message += "\nDescription:\n" + description + "\n";
  if (body) message += "\nDetails:\n" + body + "\n";
  if (value !== null) message += "\nValue: " + value + "\n";
  if (matchedEvent !== null) {
    let matched;
    try { matched = JSON.stringify(matchedEvent, null, 2); }
    catch { matched = String(matchedEvent); }
    message += "\nMatched Event:\n" + truncate(matched, 1600);
  }
  if (!description && !body && matchedEvent === null) {
    message += "\nPayload:\n" + truncate(JSON.stringify(payload, null, 2), 2000);
  }
  await bot.api.sendMessage(OWNER_CHAT_ID, truncate(message));
}

module.exports = { AXIOM_WEBHOOK_SECRET, createBot, sendAxiomAlert };
