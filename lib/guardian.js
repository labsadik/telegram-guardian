const { Bot } = require("grammy");
const { Axiom } = require("@axiomhq/js");

// ============================================================
// ENV
// ============================================================

const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN;

const OWNER_CHAT_ID =
  Number(process.env.OWNER_CHAT_ID);

const AXIOM_TOKEN =
  process.env.AXIOM_TOKEN;

const AXIOM_DATASET =
  process.env.AXIOM_DATASET;

const AXIOM_WEBHOOK_SECRET =
  process.env.AXIOM_WEBHOOK_SECRET;

const TIME_WINDOW = "5m";
const MAX_EVENTS = 50;

const SLOW_MS = 1000;
const VERY_SLOW_MS = 3000;

// ============================================================
// VALIDATION
// ============================================================

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error(
    "TELEGRAM_BOT_TOKEN is missing"
  );
}

if (!OWNER_CHAT_ID) {
  throw new Error(
    "OWNER_CHAT_ID is missing"
  );
}

if (!AXIOM_TOKEN) {
  throw new Error(
    "AXIOM_TOKEN is missing"
  );
}

if (!AXIOM_DATASET) {
  throw new Error(
    "AXIOM_DATASET is missing"
  );
}

// ============================================================
// CLIENTS
// ============================================================

const axiom = new Axiom({
  token: AXIOM_TOKEN,
});

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
    return new Date(value).toLocaleString(
      "en-IN",
      {
        timeZone: "Asia/Kolkata",
        hour12: false,
      }
    );
  } catch {
    return String(value);
  }
}

function truncate(
  text,
  maxLength = 3900
) {
  if (!text) {
    return "";
  }

  if (text.length <= maxLength) {
    return text;
  }

  return (
    text.slice(0, maxLength) +
    "\n..."
  );
}

function durationToMs(duration) {
  if (
    duration === null ||
    duration === undefined
  ) {
    return null;
  }

  const text =
    String(duration).trim();

  const match =
    text.match(
      /^([\d.]+)\s*(ns|µs|us|ms|s|m)$/i
    );

  if (!match) {
    return null;
  }

  const number =
    Number(match[1]);

  if (!Number.isFinite(number)) {
    return null;
  }

  const unit =
    match[2].toLowerCase();

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

function getMethod(event) {
  const method =
    event[
      "attributes.http.request.method"
    ] ??
    event[
      "attributes.http.request.method_original"
    ];

  if (method) {
    return String(
      method
    ).toUpperCase();
  }

  const name =
    event.name;

  if (!name) {
    return "-";
  }

  const match =
    String(name)
      .trim()
      .match(
        /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i
      );

  return match
    ? match[1].toUpperCase()
    : "-";
}

function getRoute(event) {
  const route =
    event[
      "attributes.http.route"
    ] ??
    event[
      "attributes.url.path"
    ];

  if (route) {
    return String(route);
  }

  const name =
    event.name;

  if (!name) {
    return "-";
  }

  const match =
    String(name)
      .trim()
      .match(
        /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i
      );

  return match
    ? match[2]
    : "-";
}

function getStatus(event) {
  const status =
    event[
      "attributes.http.response.status_code"
    ] ??
    event[
      "status.code"
    ];

  if (
    status === null ||
    status === undefined ||
    status === ""
  ) {
    return null;
  }

  const number =
    Number(status);

  return Number.isFinite(number)
    ? number
    : String(status);
}

function getError(event) {
  if (
    event.error !== null &&
    event.error !== undefined &&
    String(event.error).trim() !== ""
  ) {
    return String(event.error);
  }

  if (event["status.message"]) {
    return String(
      event["status.message"]
    );
  }

  if (
    event[
      "attributes.error.type"
    ]
  ) {
    return String(
      event[
        "attributes.error.type"
      ]
    );
  }

  return null;
}

function isUsefulApiEvent(event) {
  return (
    getMethod(event) !== "-" &&
    getRoute(event) !== "-"
  );
}

// ============================================================
// AXIOM QUERIES
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

  const result =
    await axiom.query(query);

  const table =
    result.tables?.[0];

  if (
    !table ||
    typeof table.events !==
      "function"
  ) {
    return [];
  }

  const events = [];

  for await (
    const event of table.events()
  ) {
    events.push(event);

    if (
      events.length >= limit
    ) {
      break;
    }
  }

  return events;
}

async function getRecentRawEvents(
  limit = 1
) {
  const query = `
    ['${AXIOM_DATASET}']
    | where _time >= ago(${TIME_WINDOW})
    | sort by _time desc
    | take ${limit}
  `;

  const result =
    await axiom.query(query);

  const table =
    result.tables?.[0];

  if (
    !table ||
    typeof table.events !==
      "function"
  ) {
    return [];
  }

  const events = [];

  for await (
    const event of table.events()
  ) {
    events.push(event);

    if (
      events.length >= limit
    ) {
      break;
    }
  }

  return events;
}

// ============================================================
// BOT
// ============================================================

function createBot() {
  const bot =
    new Bot(
      TELEGRAM_BOT_TOKEN
    );

  // ----------------------------------------------------------
  // /start
  // ----------------------------------------------------------

  bot.command(
    "start",
    async (ctx) => {
      if (!isOwner(ctx)) {
        return ctx.reply(
          "⛔ Unauthorized."
        );
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
    }
  );

  // ----------------------------------------------------------
  // /ping
  // ----------------------------------------------------------

  bot.command(
    "ping",
    async (ctx) => {
      if (!isOwner(ctx)) {
        return ctx.reply(
          "⛔ Unauthorized."
        );
      }

      await ctx.reply(
        "🏓 Pong! Bot is working."
      );
    }
  );

  // ----------------------------------------------------------
  // /status
  // ----------------------------------------------------------

  bot.command(
    "status",
    async (ctx) => {
      if (!isOwner(ctx)) {
        return ctx.reply(
          "⛔ Unauthorized."
        );
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

        const errorEvents =
          apiEvents.filter(
            (event) =>
              getError(event) !== null
          );

        const statusErrorEvents =
          apiEvents.filter(
            (event) => {
              const status =
                getStatus(event);

              return (
                typeof status ===
                  "number" &&
                status >= 400
              );
            }
          );

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
              item.ms >=
              VERY_SLOW_MS
          );

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

        const combinedErrors =
          [
            ...errorEvents,
            ...statusErrorEvents,
          ].filter(
            (event, index, arr) =>
              arr.indexOf(event) ===
              index
          );

        let health =
          "🟢 HEALTHY";

        if (
          combinedErrors.length >
            0 ||
          verySlowEvents.length >
            0
        ) {
          health =
            "🔴 ATTENTION REQUIRED";
        } else if (
          slowEvents.length >
          0
        ) {
          health =
            "🟡 SLOW ACTIVITY";
        }

        let slowText =
          "\n\n🐌 SLOWEST APIs\n\n";

        slowText +=
          slowest
            .map(
              (item, index) =>
                `${index + 1}. ` +
                `${getMethod(item.event)} ` +
                `${getRoute(item.event)}\n` +
                `   ${item.event.duration}`
            )
            .join("\n\n");

        let fastestText =
          "\n\n⚡ FASTEST APIs\n\n";

        fastestText +=
          fastest
            .map(
              (item, index) =>
                `${index + 1}. ` +
                `${getMethod(item.event)} ` +
                `${getRoute(item.event)} — ` +
                `${item.event.duration}`
            )
            .join("\n");

        let errorText = "";

        if (
          combinedErrors.length >
          0
        ) {
          errorText =
            "\n\n🔴 ERRORS\n\n" +
            combinedErrors
              .slice(0, 5)
              .map(
                (event, index) =>
                  `${index + 1}. ` +
                  `${getMethod(event)} ` +
                  `${getRoute(event)}\n` +
                  `Status: ${getStatus(event) ?? "-"}\n` +
                  `Error: ${getError(event) ?? "-"}`
              )
              .join("\n\n");
        }

        const latest =
          apiEvents[0];

        const message =
          "📊 SYSTEM STATUS\n\n" +
          `Service: ${
            serverEvents[0]?.[
              "service.name"
            ] ??
            AXIOM_DATASET
          }\n` +
          `Window: Last ${TIME_WINDOW}\n\n` +
          `${health}\n\n` +
          `📡 API events inspected: ${apiEvents.length}\n` +
          `🟡 Slow APIs (>1s): ${slowEvents.length}\n` +
          `🔴 Very slow APIs (>3s): ${verySlowEvents.length}\n` +
          `❌ Errors: ${combinedErrors.length}` +
          slowText +
          errorText +
          fastestText +
          "\n\n🕒 LATEST API EVENT\n\n" +
          `${formatTime(latest._time)}\n` +
          `${getMethod(latest)} ${getRoute(latest)}\n` +
          `Duration: ${latest.duration ?? "-"}\n` +
          `Status: ${getStatus(latest) ?? "-"}\n` +
          `Error: ${getError(latest) ?? "-"}`;

        await ctx.reply(
          truncate(message)
        );

      } catch (error) {
        console.error(
          "Status error:",
          error
        );

        await ctx.reply(
          "❌ Status check failed.\n\n" +
          `Error: ${
            error?.message ??
            "Unknown error"
          }`
        );
      }
    }
  );

  // ----------------------------------------------------------
  // /axiom
  // ----------------------------------------------------------

  bot.command(
    "axiom",
    async (ctx) => {
      if (!isOwner(ctx)) {
        return ctx.reply(
          "⛔ Unauthorized."
        );
      }

      await ctx.reply(
        "📡 Checking recent API events..."
      );

      try {
        const events =
          (
            await getRecentServerEvents(
              50
            )
          ).filter(
            isUsefulApiEvent
          );

        if (events.length === 0) {
          return ctx.reply(
            "ℹ️ No routed API events found."
          );
        }

        const output =
          events
            .slice(0, 10)
            .map(
              (event, index) => {
                const durationMs =
                  durationToMs(
                    event.duration
                  );

                let icon =
                  "🟢";

                if (
                  getError(event)
                ) {
                  icon =
                    "🔴";
                } else if (
                  durationMs !== null &&
                  durationMs >=
                    VERY_SLOW_MS
                ) {
                  icon =
                    "🔴";
                } else if (
                  durationMs !== null &&
                  durationMs >=
                    SLOW_MS
                ) {
                  icon =
                    "🟡";
                }

                return (
                  `${icon} ${index + 1}️⃣ ` +
                  `${formatTime(event._time)}\n` +
                  `${getMethod(event)} ${getRoute(event)}\n` +
                  `Duration: ${event.duration ?? "-"}\n` +
                  `Status: ${getStatus(event) ?? "-"}\n` +
                  `Error: ${getError(event) ?? "-"}`
                );
              }
            )
            .join("\n\n");

        await ctx.reply(
          truncate(
            "📡 AXIOM — API\n\n" +
            `Dataset: ${AXIOM_DATASET}\n` +
            "Window: Last 5 minutes\n\n" +
            output
          )
        );

      } catch (error) {
        console.error(
          "Axiom error:",
          error
        );

        await ctx.reply(
          "❌ Axiom query failed.\n\n" +
          `Error: ${
            error?.message ??
            "Unknown error"
          }`
        );
      }
    }
  );

  // ----------------------------------------------------------
  // /axiomraw
  // ----------------------------------------------------------

  bot.command(
    "axiomraw",
    async (ctx) => {
      if (!isOwner(ctx)) {
        return ctx.reply(
          "⛔ Unauthorized."
        );
      }

      try {
        const events =
          await getRecentRawEvents(
            1
          );

        if (!events.length) {
          return ctx.reply(
            "⚠️ No event found."
          );
        }

        const json =
          JSON.stringify(
            events[0],
            null,
            2
          );

        await ctx.reply(
          truncate(
            "🔎 RAW AXIOM EVENT\n\n" +
            json,
            3500
          )
        );

      } catch (error) {
        console.error(
          "Axiom raw error:",
          error
        );

        await ctx.reply(
          "❌ Failed to read Axiom event."
        );
      }
    }
  );

  // ----------------------------------------------------------
  // Unknown command
  // ----------------------------------------------------------

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
        "/start\n" +
        "/ping\n" +
        "/status\n" +
        "/axiom\n" +
        "/axiomraw"
      );
    }
  );

  bot.catch((error) => {
    console.error(
      "Telegram bot error:",
      error
    );
  });

  return bot;
}

// ============================================================
// AXIOM ALERT → TELEGRAM
// ============================================================

async function sendAxiomAlert(
  payload
) {
  const bot = new Bot(
    TELEGRAM_BOT_TOKEN
  );

  const action =
    payload?.action ??
    payload?.Action ??
    "Open";

  const event =
    payload?.event ??
    payload?.Event ??
    payload;

  const title =
    event?.title ??
    event?.Title ??
    "Axiom Monitor Alert";

  const description =
    event?.description ??
    event?.Description ??
    "";

  const body =
    event?.body ??
    event?.Body ??
    "";

  const value =
    event?.value ??
    event?.Value;

  const matchedEvent =
    event?.matchedEvent ??
    event?.MatchedEvent;

  const isClosed =
    String(action)
      .toLowerCase() ===
    "closed";

  let message =
    `${isClosed ? "✅" : "🚨"} AXIOM ALERT\n\n`;

  message +=
    `Status: ${action}\n`;

  message +=
    `Monitor: ${title}\n`;

  if (description) {
    message +=
      `\nDescription:\n${description}\n`;
  }

  if (body) {
    message +=
      `\nDetails:\n${body}\n`;
  }

  if (
    value !== undefined &&
    value !== null
  ) {
    message +=
      `\nValue: ${value}\n`;
  }

  if (matchedEvent) {
    let matched;

    try {
      matched =
        JSON.stringify(
          matchedEvent,
          null,
          2
        );
    } catch {
      matched =
        String(matchedEvent);
    }

    message +=
      "\nMatched event:\n" +
      truncate(
        matched,
        1600
      );
  }

  message +=
    "\n\n📡 Source: Axiom";

  await bot.api.sendMessage(
    OWNER_CHAT_ID,
    truncate(message)
  );
}

module.exports = {
  createBot,
  sendAxiomAlert,
  getRecentServerEvents,
  getRecentRawEvents,
  formatTime,
  truncate,
  AXIOM_WEBHOOK_SECRET,
};