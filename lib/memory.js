const { MongoClient } = require("mongodb");

const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB = process.env.MONGODB_DB || "sarah";

let client;
let dbPromise;
let indexesPromise;

function requiredMongo() {
  if (!MONGODB_URI) {
    throw new Error("MONGODB_URI is missing");
  }
}

async function getDb() {
  requiredMongo();

  if (!dbPromise) {
    client = new MongoClient(MONGODB_URI, {
      appName: "telegram-guardian-sarah",
      maxPoolSize: 10,
      maxIdleTimeMS: 60_000,
      serverSelectionTimeoutMS: 3_000,
      connectTimeoutMS: 3_000,
    });

    dbPromise = client.connect().then(() => client.db(MONGODB_DB));
  }

  const db = await dbPromise;

  if (!indexesPromise) {
    indexesPromise = Promise.all([
      db.collection("sarah_messages").createIndex(
        { chatId: 1, createdAt: -1 },
        { name: "chat_recent" }
      ),
      db.collection("sarah_messages").createIndex(
        { chatId: 1, content: "text" },
        { name: "chat_content_text" }
      ),
      db.collection("sarah_memories").createIndex(
        { chatId: 1, createdAt: -1 },
        { name: "memory_recent" }
      ),
      db.collection("sarah_memories").createIndex(
        { chatId: 1, memory: "text" },
        { name: "memory_text" }
      ),
    ]).catch((error) => {
      indexesPromise = null;
      throw error;
    });
  }

  await indexesPromise;
  return db;
}

async function saveConversationMessage({
  chatId,
  role,
  content,
  source = "text",
}) {
  const db = await getDb();

  await db.collection("sarah_messages").insertOne({
    chatId: Number(chatId),
    role,
    content: String(content || "").trim(),
    source,
    createdAt: new Date(),
  });
}

async function findRelevantMessages(chatId, queryText) {
  const db = await getDb();
  const query = String(queryText || "").trim();

  if (!query) return [];

  const words = query
    .replace(/[^p{L}p{N}_s-]/gu, " ")
    .split(/s+/)
    .filter((word) => word.length >= 2)
    .slice(0, 10);

  if (!words.length) return [];

  try {
    const textQuery = words.join(" ");

    return await db
      .collection("sarah_messages")
      .find(
        {
          chatId: Number(chatId),
          $text: { $search: textQuery },
        },
        {
          projection: {
            role: 1,
            content: 1,
            source: 1,
            createdAt: 1,
            score: { $meta: "textScore" },
          },
        }
      )
      .sort({ score: { $meta: "textScore" } })
      .limit(8)
      .toArray();
  } catch (error) {
    console.error("MongoDB message search error:", error);
    return [];
  }
}

async function findRelevantMemories(chatId, queryText) {
  const db = await getDb();
  const query = String(queryText || "").trim();

  if (!query) return [];

  try {
    return await db
      .collection("sarah_memories")
      .find(
        {
          chatId: Number(chatId),
          $text: { $search: query },
        },
        {
          projection: {
            memory: 1,
            type: 1,
            importance: 1,
            createdAt: 1,
            score: { $meta: "textScore" },
          },
        }
      )
      .sort({ score: { $meta: "textScore" }, importance: -1 })
      .limit(8)
      .toArray();
  } catch (error) {
    console.error("MongoDB memory search error:", error);
    return [];
  }
}

async function loadConversationContext(chatId, queryText, limit = 32) {
  const db = await getDb();

  const recent = await db
    .collection("sarah_messages")
    .find(
      { chatId: Number(chatId) },
      {
        projection: {
          role: 1,
          content: 1,
          source: 1,
          createdAt: 1,
        },
      }
    )
    .sort({ createdAt: -1 })
    .limit(Math.max(8, Math.min(Number(limit) || 32, 50)))
    .toArray();

  const relevant = await findRelevantMessages(chatId, queryText);
  const memories = await findRelevantMemories(chatId, queryText);

  const byId = new Map();

  for (const item of [...relevant, ...recent]) {
    byId.set(String(item._id), item);
  }

  const messages = [...byId.values()]
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(-Math.max(8, Math.min(Number(limit) || 32, 50)))
    .map((item) => ({
      role: item.role === "assistant" ? "assistant" : "user",
      content: item.content,
    }));

  return {
    messages,
    memories: memories.map((item) => ({
      memory: item.memory,
      type: item.type || "note",
      importance: item.importance || 1,
    })),
  };
}

async function saveMemory(chatId, memory, type = "note", importance = 2) {
  const text = String(memory || "").trim();
  if (!text) return;

  const db = await getDb();

  await db.collection("sarah_memories").updateOne(
    {
      chatId: Number(chatId),
      memory: text,
    },
    {
      $set: {
        type,
        importance: Number(importance) || 2,
        updatedAt: new Date(),
      },
      $setOnInsert: {
        chatId: Number(chatId),
        memory: text,
        createdAt: new Date(),
      },
    },
    { upsert: true }
  );
}

function extractMemoryCandidates(text) {
  const input = String(text || "").trim();
  if (!input) return [];

  const candidates = [];
  const patterns = [
    {
      type: "fact",
      re: /\bmy name is\s+([^.!?\n]{1,80})/i,
    },
    {
      type: "preference",
      re: /\b(?:i like|i love|i prefer|my favorite (?:thing|food|movie|music|game)? is)\s+([^.!?\n]{1,120})/i,
    },
    {
      type: "preference",
      re: /\b(?:i don't like|i dislike|i hate)\s+([^.!?\n]{1,120})/i,
    },
    {
      type: "fact",
      re: /\bcall me\s+([^.!?\n]{1,80})/i,
    },
    {
      type: "fact",
      re: /(?:আমার নাম)\s+([^.!?\n]{1,80})/i,
    },
    {
      type: "preference",
      re: /(?:আমি)\s+([^.!?\n]{1,120})\s+(?:পছন্দ করি|ভালোবাসি|পছন্দ করি না)/i,
    },
    {
      type: "fact",
      re: /(?:আমাকে)\s+([^.!?\n]{1,80})\s+(?:বলে ডাকবে|ডাকো)/i,
    },
    {
      type: "note",
      re: /(?:মনে রেখো|মনে রাখবে|মনে রাখ)\s*[:：-]?\s*([^.!?\n]{1,160})/i,
    },
    {
      type: "note",
      re: /\bremember(?: that)?\s*[:：-]?\s*([^.!?\n]{1,160})/i,
    },
  ];

  for (const { type, re } of patterns) {
    const match = input.match(re);
    if (!match) continue;

    const value = match[1].trim();
    if (value) {
      candidates.push({ type, value });
    }
  }

  return candidates.slice(0, 3);
}

async function saveDetectedMemories(chatId, text) {
  const candidates = extractMemoryCandidates(text);

  for (const candidate of candidates) {
    await saveMemory(chatId, candidate.value, candidate.type, 3);
  }

  return candidates.length;
}

async function getMemoryStats(chatId) {
  const db = await getDb();
  const [messages, memories, lastMemory] = await Promise.all([
    db.collection("sarah_messages").countDocuments({
      chatId: Number(chatId),
    }),
    db.collection("sarah_memories").countDocuments({
      chatId: Number(chatId),
    }),
    db
      .collection("sarah_memories")
      .findOne(
        { chatId: Number(chatId) },
        {
          sort: { createdAt: -1 },
          projection: { memory: 1, type: 1, createdAt: 1 },
        }
      ),
  ]);

  return {
    messages,
    memories,
    lastMemory,
  };
}

async function testMongoConnection() {
  const db = await getDb();
  await db.command({ ping: 1 });

  const stats = await db
    .collection("sarah_messages")
    .estimatedDocumentCount();

  return {
    database: db.databaseName,
    messages: stats,
  };
}

module.exports = {
  loadConversationContext,
  saveConversationMessage,
  saveDetectedMemories,
  saveMemory,
  getMemoryStats,
  testMongoConnection,
};