require("dotenv").config();

const http = require("http");
const { Bot } = require("grammy");
const { Axiom } = require("@axiomhq/js");

// ============================================================
// ENVIRONMENT
// ============================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID);

const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
const AXIOM_DATASET = process.env.AXIOM_DATASET;

const GUARDIAN_PORT =
  Number(process.env.GUARDIAN_PORT) || 3000;

const AXIOM_WEBHOOK_SECRET =
  process.env.AXIOM_WEBHOOK_SECRET;

// ============================================================
// VALIDATION
// ============================================================

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("TELEGRAM_BOT_TOKEN is missing in .env");
}

if (!OWNER_CHAT_ID) {
  throw new Error("OWNER_CHAT_ID is missing in .env");
}

if (!AXIOM_TOKEN) {
  throw new Error("AXIOM_TOKEN is missing in .env");
}

if (!AXIOM_DATASET) {
  throw new Error("AXIOM_DATASET is missing in .env");
}

if (!AXIOM_WEBHOOK_SECRET) {
  throw new Error("AXIOM_WEBHOOK_SECRET is missing in .env");
}

// ============================================================
// CLIENTS
// ============================================================

const bot = new Bot(TELEGRAM_BOT_TOKEN);

const axiom = new Axiom({
  token: AXIOM_TOKEN,
});

// ============================================================
// CONFIG
// ============================================================

const TIME_WINDOW = "5m";

const MAX_EVENTS = 50;

const SLOW_MS = 1000;
const VERY_SLOW_MS = 3000;

// ============================================================
// HELPERS
// ============================================================

function isOwner(ctx) {
  return ctx.chat?.id === OWNER_CHAT_ID;
}

function formatTime(value) {
  if (!value) {
    return "-";
  }

  try {
    return new Date(value).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false,
    });
  } catch {
    return String(value);
  }
}

function truncate(text, maxLength = 3800) {
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return text.slice(0, maxLength) + "\n...";
}

// ============================================================
// DURATION PARSER
// ============================================================

function durationToMs(duration) {
  if (duration === null || duration === undefined) {
    return null;
  }

  const text = String(duration).trim();

  const match = text.match(
    /^([\d.]+)\s*(ns|µs|us|ms|s|m)$/i
  );

  if (!match) {
    return null;
  }

  const number = Number(match[1]);

  if (!Number.isFinite(number)) {
    return null;
  }

  const unit = match[2].toLowerCase();

  switch (unit) {
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

// ============================================================
// HTTP METHOD
// Uses fields confirmed in your Axiom dataset
// ============================================================

function getMethod(event) {
  const method =
    event["attributes.http.request.method"] ??
    event["attributes.http.request.method_original"];

  if (method) {
    return String(method).toUpperCase();
  }

  // Example span name:
  // GET /api/company
  const name = event.name;

  if (!name) {
    return "-";
  }

  const match = String(name)
    .trim()
    .match(
      /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i
    );

  if (match) {
    return match[1].toUpperCase();
  }

  return "-";
}

// ============================================================
// ROUTE
// ============================================================

function getRoute(event) {
  const route =
    event["attributes.http.route"] ??
    event["attributes.url.path"];

  if (route) {
    return String(route);
  }

  // Fallback from span name
  // Example:
  // GET /api/company
  const name = event.name;

  if (!name) {
    return "-";
  }

  const match = String(name)
    .trim()
    .match(
      /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i
    );

  if (match) {
    return match[2];
  }

  return "-";
}

// ============================================================
// HTTP STATUS
// ============================================================

function getStatus(event) {
  const status =
    event["attributes.http.response.status_code"] ??
    event["status.code"];

  if (
    status === null ||
    status === undefined ||
    status === ""
  ) {
    return null;
  }

  const number = Number(status);

  return Number.isFinite(number)
    ? number
    : String(status);
}

// ============================================================
// ERROR
// ============================================================

function getError(event) {
  if (
    event.error !== null &&
    event.error !== undefined &&
    String(event.error).trim() !== ""
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

// ============================================================
// CHECK WHETHER THIS IS A USEFUL API EVENT
// ============================================================

function isUsefulApiEvent(event) {
  const route = getRoute(event);
  const method = getMethod(event);

  if (!route || route === "-") {
    return false;
  }

  if (!method || method === "-") {
    return false;
  }

  return true;
}

// ============================================================
// AXIOM QUERY
// ============================================================

async function getRecentServerEvents(
  limit = MAX_EVENTS
) {
  const query = `
    ['${AXIOM_DATASET}']
    | where _time >= ago(${TIME_WINDOW})
    | where kind == 'server'
    | project
        _time,
        name,
        kind,
        duration,
        error,
        ['service.name'],
        ['attributes.http.request.method'],
        ['attributes.http.request.method_original'],
        ['attributes.http.response.status_code'],
        ['attributes.http.route'],
        ['attributes.url.path'],
        ['attributes.error.type'],
        ['status.code'],
        ['status.message']
    | sort by _time desc
    | take ${limit}
  `;

  const result = await axiom.query(query);

  const table = result.tables?.[0];

  if (
    !table ||
    typeof table.events !== "function"
  ) {
    return [];
  }

  const events = [];

  for await (const event of table.events()) {
    events.push(event);

    if (events.length >= limit) {
      break;
    }
  }

  return events;
}

// ============================================================
// RAW AXIOM QUERY
// ============================================================

async function getRecentRawEvents(limit = 1) {
  const query = `
    ['${AXIOM_DATASET}']
    | where _time >= ago(${TIME_WINDOW})
    | sort by _time desc
    | take ${limit}
  `;

  const result = await axiom.query(query);

  const table = result.tables?.[0];

  if (
    !table ||
    typeof table.events !== "function"
  ) {
    return [];
  }

  const events = [];

  for await (const event of table.events()) {
    events.push(event);

    if (events.length >= limit) {
      break;
    }
  }

  return events;
}

// ============================================================
// FORMAT API EVENT
// ============================================================

function formatApiEvent(event, index) {
  const method = getMethod(event);
  const route = getRoute(event);
  const status = getStatus(event);
  const error = getError(event);
  const duration = event.duration ?? "-";

  const durationMs = durationToMs(duration);

  let icon = "🟢";

  if (error) {
    icon = "🔴";
  }

  if (typeof status === "number") {
    if (status >= 500) {
      icon = "🔴";
    } else if (status >= 400) {
      icon = "🟡";
    }
  }

  if (
    durationMs !== null &&
    durationMs >= VERY_SLOW_MS
  ) {
    icon = "🔴";
  } else if (
    durationMs !== null &&
    durationMs >= SLOW_MS &&
    !error
  ) {
    icon = "🟡";
  }

  return (
    `${icon} ${index}️⃣ ${formatTime(event._time)}\n` +
    `${method} ${route}\n` +
    `Duration: ${duration}\n` +
    `Status: ${status ?? "-"}\n` +
    `Error: ${error ?? "-"}`
  );
}

// ============================================================
// TELEGRAM /START
// ============================================================

bot.command("start", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Unauthorized.");
  }

  await ctx.reply(
    "✅ Guardian Bot is online!\n\n" +
    `Telegram ID: ${ctx.chat.id}\n` +
    "You are authorized.\n\n" +
    "Commands:\n" +
    "/start - Bot status\n" +
    "/ping - Test bot\n" +
    "/status - System health\n" +
    "/axiom - Recent API events\n" +
    "/axiomraw - Raw Axiom event"
  );
});

// ============================================================
// /PING
// ============================================================

bot.command("ping", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Unauthorized.");
  }

  await ctx.reply(
    "🏓 Pong! Bot is working."
  );
});

// ============================================================
// /STATUS
// ============================================================

bot.command("status", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Unauthorized.");
  }

  await ctx.reply(
    "📊 Checking system status..."
  );

  try {
    const serverEvents =
      await getRecentServerEvents();

    const apiEvents =
      serverEvents.filter(
        isUsefulApiEvent
      );

    if (apiEvents.length === 0) {
      return ctx.reply(
        "ℹ️ SYSTEM STATUS\n\n" +
        `Service: ${AXIOM_DATASET}\n` +
        "Window: Last 5 minutes\n\n" +
        "No routed API events found."
      );
    }

    // --------------------------------------------------------
    // COUNTS
    // --------------------------------------------------------

    const totalEvents =
      apiEvents.length;

    const errorEvents =
      apiEvents.filter(
        (event) =>
          getError(event) !== null
      );

    const statusErrorEvents =
      apiEvents.filter((event) => {
        const status =
          getStatus(event);

        return (
          typeof status === "number" &&
          status >= 400
        );
      });

    // --------------------------------------------------------
    // DURATIONS
    // --------------------------------------------------------

    const durations =
      apiEvents
        .map((event) => ({
          event,
          ms: durationToMs(
            event.duration
          ),
        }))
        .filter(
          (item) =>
            item.ms !== null
        );

    const slowEvents =
      durations.filter(
        (item) =>
          item.ms >= SLOW_MS
      );

    const verySlowEvents =
      durations.filter(
        (item) =>
          item.ms >= VERY_SLOW_MS
      );

    // --------------------------------------------------------
    // SORTING
    // --------------------------------------------------------

    const slowest =
      [...durations]
        .sort(
          (a, b) =>
            b.ms - a.ms
        )
        .slice(0, 5);

    const fastest =
      [...durations]
        .sort(
          (a, b) =>
            a.ms - b.ms
        )
        .slice(0, 3);

    // --------------------------------------------------------
    // HEALTH
    // --------------------------------------------------------

    let health =
      "🟢 HEALTHY";

    if (
      errorEvents.length > 0 ||
      statusErrorEvents.length > 0 ||
      verySlowEvents.length > 0
    ) {
      health =
        "🔴 ATTENTION REQUIRED";
    } else if (
      slowEvents.length > 0
    ) {
      health =
        "🟡 SLOW ACTIVITY";
    }

    // --------------------------------------------------------
    // SLOWEST APIs
    // --------------------------------------------------------

    let slowText = "";

    if (slowest.length > 0) {
      slowText =
        "\n\n🐌 SLOWEST APIs\n\n" +
        slowest
          .map((item, index) => {
            const event =
              item.event;

            return (
              `${index + 1}. ` +
              `${getMethod(event)} ` +
              `${getRoute(event)}\n` +
              `   ${event.duration}`
            );
          })
          .join("\n\n");
    }

    // --------------------------------------------------------
    // ERRORS
    // --------------------------------------------------------

    const combinedErrors = [];

    for (const event of errorEvents) {
      if (!combinedErrors.includes(event)) {
        combinedErrors.push(event);
      }
    }

    for (
      const event of statusErrorEvents
    ) {
      if (!combinedErrors.includes(event)) {
        combinedErrors.push(event);
      }
    }

    let errorText = "";

    if (
      combinedErrors.length > 0
    ) {
      errorText =
        "\n\n🔴 ERRORS\n\n" +
        combinedErrors
          .slice(0, 5)
          .map((event, index) => {
            return (
              `${index + 1}. ` +
              `${getMethod(event)} ` +
              `${getRoute(event)}\n` +
              `   Status: ` +
              `${getStatus(event) ?? "-"}\n` +
              `   Error: ` +
              `${getError(event) ?? "-"}`
            );
          })
          .join("\n\n");
    }

    // --------------------------------------------------------
    // FASTEST APIs
    // --------------------------------------------------------

    let fastestText = "";

    if (fastest.length > 0) {
      fastestText =
        "\n\n⚡ FASTEST APIs\n\n" +
        fastest
          .map((item, index) => {
            const event =
              item.event;

            return (
              `${index + 1}. ` +
              `${getMethod(event)} ` +
              `${getRoute(event)} — ` +
              `${event.duration}`
            );
          })
          .join("\n");
    }

    // --------------------------------------------------------
    // LATEST EVENT
    // --------------------------------------------------------

    const latest =
      apiEvents[0];

    const latestText =
      "\n\n🕒 LATEST API EVENT\n\n" +
      `${formatTime(latest._time)}\n` +
      `${getMethod(latest)} ` +
      `${getRoute(latest)}\n` +
      `Duration: ` +
      `${latest.duration ?? "-"}\n` +
      `Status: ` +
      `${getStatus(latest) ?? "-"}\n` +
      `Error: ` +
      `${getError(latest) ?? "-"}`;

    // --------------------------------------------------------
    // FINAL STATUS MESSAGE
    // --------------------------------------------------------

    const message =
      "📊 SYSTEM STATUS\n\n" +
      `Service: ${
        serverEvents[0]?.["service.name"] ??
        AXIOM_DATASET
      }\n` +
      `Window: Last ${TIME_WINDOW}\n\n` +
      `${health}\n\n` +
      `📡 API events inspected: ` +
      `${totalEvents}\n` +
      `🟡 Slow APIs (>1s): ` +
      `${slowEvents.length}\n` +
      `🔴 Very slow APIs (>3s): ` +
      `${verySlowEvents.length}\n` +
      `❌ Errors: ` +
      `${combinedErrors.length}` +
      slowText +
      errorText +
      fastestText +
      latestText;

    await ctx.reply(
      truncate(message)
    );
  } catch (error) {
    console.error(
      "Axiom /status error:"
    );

    console.error(error);

    await ctx.reply(
      "❌ Status check failed.\n\n" +
      `Error: ${
        error?.message ||
        "Unknown error"
      }`
    );
  }
});

// ============================================================
// /AXIOM
// ============================================================

bot.command("axiom", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Unauthorized.");
  }

  await ctx.reply(
    "📡 Checking recent API events..."
  );

  try {
    const serverEvents =
      await getRecentServerEvents(50);

    const apiEvents =
      serverEvents.filter(
        isUsefulApiEvent
      );

    if (apiEvents.length === 0) {
      return ctx.reply(
        "ℹ️ No routed API events found " +
        "in the last 5 minutes.\n\n" +
        `Dataset: ${AXIOM_DATASET}`
      );
    }

    const displayEvents =
      apiEvents.slice(0, 10);

    const output =
      displayEvents
        .map((event, index) =>
          formatApiEvent(
            event,
            index + 1
          )
        )
        .join("\n\n");

    const message =
      "📡 AXIOM — API\n\n" +
      `Dataset: ${AXIOM_DATASET}\n` +
      "Window: Last 5 minutes\n" +
      `Events displayed: ` +
      `${displayEvents.length}\n\n` +
      output;

    await ctx.reply(
      truncate(message)
    );
  } catch (error) {
    console.error(
      "Axiom /axiom error:"
    );

    console.error(error);

    await ctx.reply(
      "❌ Axiom query failed.\n\n" +
      `Error: ${
        error?.message ||
        "Unknown error"
      }`
    );
  }
});

// ============================================================
// /AXIOMRAW
// ============================================================

bot.command("axiomraw", async (ctx) => {
  if (!isOwner(ctx)) {
    return ctx.reply("⛔ Unauthorized.");
  }

  await ctx.reply(
    "🔎 Reading one raw Axiom event..."
  );

  try {
    const events =
      await getRecentRawEvents(1);

    if (events.length === 0) {
      return ctx.reply(
        "⚠️ No event found " +
        "in the last 5 minutes."
      );
    }

    const event =
      events[0];

    console.log(
      "\n=============================="
    );

    console.log(
      "RAW AXIOM EVENT"
    );

    console.log(
      "=============================="
    );

    console.dir(event, {
      depth: null,
    });

    console.log(
      "==============================\n"
    );

    let json;

    try {
      json = JSON.stringify(
        event,
        null,
        2
      );
    } catch {
      json = String(event);
    }

    await ctx.reply(
      "🔎 RAW AXIOM EVENT\n\n" +
      truncate(json, 3500)
    );
  } catch (error) {
    console.error(
      "Axiom /axiomraw error:"
    );

    console.error(error);

    await ctx.reply(
      "❌ Failed to read raw Axiom event.\n\n" +
      `Error: ${
        error?.message ||
        "Unknown error"
      }`
    );
  }
});

// ============================================================
// HTTP SERVER
// ============================================================

const webhookServer =
  http.createServer(
    async (req, res) => {

      // ------------------------------------------------------
      // HEALTH ENDPOINT
      // ------------------------------------------------------

      if (
        req.method === "GET" &&
        req.url === "/health"
      ) {
        res.writeHead(200, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify({
            ok: true,
            service: "telegram-guardian",
            telegram: true,
            axiom: true,
            time: new Date().toISOString(),
          })
        );

        return;
      }

      // ------------------------------------------------------
      // AXIOM WEBHOOK
      // ------------------------------------------------------

      if (
        req.method !== "POST" ||
        req.url !== "/axiom-alert"
      ) {
        res.writeHead(404, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify({
            ok: false,
            error: "Not found",
          })
        );

        return;
      }

      // ------------------------------------------------------
      // SECRET CHECK
      // ------------------------------------------------------

      const providedSecret =
        req.headers[
          "x-guardian-secret"
        ];

      if (
        providedSecret !==
        AXIOM_WEBHOOK_SECRET
      ) {
        res.writeHead(401, {
          "Content-Type":
            "application/json",
        });

        res.end(
          JSON.stringify({
            ok: false,
            error: "Unauthorized",
          })
        );

        return;
      }

      // ------------------------------------------------------
      // READ REQUEST BODY
      // ------------------------------------------------------

      let body = "";

      req.on("data", (chunk) => {
        body += chunk.toString();

        if (body.length > 1_000_000) {
          req.destroy();
        }
      });

      req.on("end", async () => {
        try {
          const payload =
            JSON.parse(body);

          console.log(
            "\n=============================="
          );

          console.log(
            "AXIOM WEBHOOK RECEIVED"
          );

          console.log(
            "=============================="
          );

          console.dir(payload, {
            depth: null,
          });

          console.log(
            "==============================\n"
          );

          // --------------------------------------------------
          // Axiom default/custom webhook structure
          // --------------------------------------------------

          const action =
            payload.action ??
            "Open";

          const event =
            payload.event ??
            {};

          const title =
            event.title ??
            "Axiom Monitor Alert";

          const description =
            event.description ??
            "";

          const bodyText =
            event.body ??
            "";

          const monitorId =
            event.monitorID ??
            "-";

          const value =
            event.value;

          const timestamp =
            event.timestamp ??
            new Date().toISOString();

          // --------------------------------------------------
          // Determine icon
          // --------------------------------------------------

          const actionLower =
            String(action).toLowerCase();

          const icon =
            actionLower === "closed"
              ? "✅"
              : "🚨";

          // --------------------------------------------------
          // Telegram message
          // --------------------------------------------------

          let telegramMessage =
            `${icon} AXIOM ALERT\n\n`;

          telegramMessage +=
            `Status: ${action}\n`;

          telegramMessage +=
            `Monitor: ${title}\n`;

          if (monitorId !== "-") {
            telegramMessage +=
              `Monitor ID: ${monitorId}\n`;
          }

          if (timestamp) {
            telegramMessage +=
              `Time: ${timestamp}\n`;
          }

          if (description) {
            telegramMessage +=
              `\nDescription:\n${description}\n`;
          }

          if (bodyText) {
            telegramMessage +=
              `\nDetails:\n${bodyText}\n`;
          }

          if (
            value !== undefined &&
            value !== null &&
            value !== ""
          ) {
            telegramMessage +=
              `\nValue: ${value}\n`;
          }

          // --------------------------------------------------
          // Matched event
          // --------------------------------------------------

          if (
            event.matchedEvent !==
              null &&
            event.matchedEvent !==
              undefined
          ) {
            let matchedText;

            try {
              matchedText =
                JSON.stringify(
                  event.matchedEvent,
                  null,
                  2
                );
            } catch {
              matchedText =
                String(
                  event.matchedEvent
                );
            }

            telegramMessage +=
              "\nMatched Event:\n" +
              truncate(
                matchedText,
                1800
              );
          }

          telegramMessage +=
            "\n\n📡 Source: Axiom";

          // --------------------------------------------------
          // Send to your private Telegram
          // --------------------------------------------------

          await bot.api.sendMessage(
            OWNER_CHAT_ID,
            truncate(
              telegramMessage
            )
          );

          // --------------------------------------------------
          // Respond to Axiom
          // --------------------------------------------------

          res.writeHead(200, {
            "Content-Type":
              "application/json",
          });

          res.end(
            JSON.stringify({
              ok: true,
            })
          );

        } catch (error) {
          console.error(
            "Webhook processing error:"
          );

          console.error(error);

          res.writeHead(400, {
            "Content-Type":
              "application/json",
          });

          res.end(
            JSON.stringify({
              ok: false,
              error:
                "Invalid webhook payload",
            })
          );
        }
      });
    }
  );

// ============================================================
// UNKNOWN COMMANDS
// ============================================================

bot.on(
  "message:text",
  async (ctx) => {
    if (!isOwner(ctx)) {
      return;
    }

    const text =
      ctx.message.text;

    if (
      !text.startsWith("/")
    ) {
      return;
    }

    await ctx.reply(
      "❓ Unknown command.\n\n" +
      "Available commands:\n" +
      "/start\n" +
      "/ping\n" +
      "/status\n" +
      "/axiom\n" +
      "/axiomraw"
    );
  }
);

// ============================================================
// GLOBAL TELEGRAM ERROR HANDLER
// ============================================================

bot.catch((err) => {
  console.error(
    "Telegram bot error:"
  );

  console.error(err);
});

// ============================================================
// START
// ============================================================

console.log(
  "🤖 Guardian Bot starting..."
);

webhookServer.listen(
  GUARDIAN_PORT,
  "0.0.0.0",
  () => {
    console.log(
      `🌐 Guardian HTTP server listening on port ${GUARDIAN_PORT}`
    );

    console.log(
      `❤️ Health: http://localhost:${GUARDIAN_PORT}/health`
    );

    console.log(
      `🔔 Webhook: http://localhost:${GUARDIAN_PORT}/axiom-alert`
    );
  }
);

bot.start();