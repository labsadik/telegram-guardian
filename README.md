# Telegram Guardian — Sarah

Private, Telegram-only AI partner and server guardian for a full-stack application.

Telegram Guardian is designed around one simple idea: **Telegram is the control surface**. Conversation, voice, memory, system monitoring, alerts, testing, and future automation can all be operated from one private Telegram bot without requiring a separate frontend dashboard.

> **Current status:** Production-ready core with Telegram webhook, owner-only access, Axiom monitoring, persistent MongoDB memory, text conversation, voice conversation, ElevenLabs voice, Gemini/Groq fallback, and Telegram command controls.

---

## 1. Project purpose

This project combines two roles inside one private Telegram bot:

### Sarah — personal AI partner

Sarah can have general conversations rather than being limited to server monitoring.

She supports:

- Natural text conversation
- Bengali as the default response language
- Explicit language switching when requested
- Warm, caring, partner-style conversation
- Long-term memory stored in MongoDB
- Text-to-text conversation
- Voice-to-voice conversation
- Voice-to-text transcription
- Text-to-voice generation
- Provider fallback when an AI provider is temporarily unavailable
- Current-message-focused answers
- Hallucination-resistant behavior and explicit uncertainty when information is unavailable

### Guardian — private server monitor

The same Telegram bot can also:

- Read recent Axiom server telemetry
- Show recent API activity
- Detect slow and very slow API requests
- Surface detected errors/status failures
- Receive Axiom webhook alerts
- Deliver alerts directly to the owner in Telegram
- Keep monitoring data separate from Sarah's personal conversation database

---

## 2. Core architecture

~~~text
                         ┌──────────────────────┐
                         │      Telegram        │
                         │  Private bot/chat    │
                         └──────────┬───────────┘
                                    │
                                    ▼
                       ┌────────────────────────┐
                       │   Vercel Serverless    │
                       │   /api/telegram        │
                       └──────────┬─────────────┘
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
        Sarah conversation     Monitoring         Media/Voice
              │                   │                   │
              ▼                   ▼                   ▼
          MongoDB               Axiom             ElevenLabs
              │                                       │
              │                                       │
              └───────────────┐       ┌───────────────┘
                              ▼       ▼
                           AI Providers
                              │
                     ┌────────┴────────┐
                     │                 │
                     ▼                 ▼
                 Gemini            Groq fallback
~~~

### Data separation

Personal Sarah conversation:

~~~text
Telegram → Sarah → MongoDB
~~~

Full-stack telemetry:

~~~text
Full-stack app → Axiom → Guardian → Telegram
~~~

**Axiom telemetry is not written into Sarah's MongoDB conversation store.**

---

## 3. Current capabilities

### Telegram interface

Available endpoints:

- \`/api/telegram\` — Telegram webhook
- \`/api/axiom-alert\` — authenticated Axiom webhook
- \`/api/health\` — health check

Production webhook:

~~~text
https://bottelegram-guardian.vercel.app/api/telegram
~~~

Axiom webhook:

~~~text
https://bottelegram-guardian.vercel.app/api/axiom-alert
~~~

Health check:

~~~text
https://bottelegram-guardian.vercel.app/api/health
~~~

### Owner-only access

The bot checks \`OWNER_CHAT_ID\` before allowing private assistant and monitoring actions.

Unauthorized users receive an \`Unauthorized\` response instead of accessing Sarah or monitoring data.

---

## 4. Sarah conversation features

### Text → Text

Send any normal text message.

~~~text
You → Telegram text
   ↓
Sarah conversation engine
   ↓
Gemini Live
   ↓ fallback
Gemini
   ↓ fallback
Groq
   ↓
Sarah text response
~~~

Provider implementation details are intentionally kept internal to the user-facing conversation. Sarah does not expose backend provider names as normal response labels.

### Voice → Voice

Send a Telegram voice message.

~~~text
Voice message
   ↓
Speech-to-text
   ↓
Sarah conversation
   ↓
ElevenLabs text-to-speech
   ↓
Telegram voice reply
~~~

Current speech-to-text path:

~~~text
Groq Whisper
   ↓ fallback
Gemini audio transcription
~~~

### Voice → Text

Reply to a voice message with:

~~~text
/elevenstt
~~~

This uses ElevenLabs speech-to-text for that audio and returns a transcript.

### Text → Voice

Use:

~~~text
/say <what Sarah should say>
~~~

Example:

~~~text
/say আজ তোমার সাথে কথা বলতে ভালো লাগছে।
~~~

### Direct voice test

Use:

~~~text
/voicetest
~~~

This tests the ElevenLabs voice path directly.

---

## 5. Sarah personality and response behavior

Sarah is configured as a warm, attentive, partner-style companion.

Current behavior goals:

- Bengali is the default response language.
- If the user explicitly asks for another language, Sarah uses that language.
- If the user clearly speaks another language without specifying, Sarah can match it.
- One question should receive one focused answer.
- Sarah should not wander into unrelated subjects.
- At most one natural follow-up should be asked when it genuinely helps.
- Conversation history is used only when relevant.
- Stored memories are treated as user-provided context, not absolute truth.
- Sarah should never invent memories, events, actions, locations, or past conversations.
- When information is unavailable, Sarah should say so instead of guessing.
- Sarah should not claim to have checked a live system unless the application actually supplied that data.
- Voice responses are written to sound natural when spoken.
- Sarah should not claim to be a real human or claim physical actions that were not performed.

---

## 6. Persistent MongoDB memory

MongoDB is used only for Sarah's personal conversation memory.

### Stored data

The memory system stores:

- Text messages
- Voice transcripts
- Sarah's replies
- Message timestamps
- Message source (text/voice)
- Long-term memories
- Manually saved memories

Collections:

~~~text
sarah_messages
sarah_memories
~~~

### Long conversations

The database keeps the full stored history, but Sarah does not send the entire history to the model on every request.

Instead, the system combines:

- Recent conversation context
- Relevant older messages
- Relevant long-term memories
- The current user message

This keeps long conversations usable without blindly sending the entire database to every AI request.

### Automatic and manual memory

Manual:

~~~text
/remember <important thing>
~~~

Memory status:

~~~text
/memory
~~~

Database test:

~~~text
/mongotest
~~~

Current memory extraction also detects several simple user-provided facts/preferences automatically. This can be expanded later into model-assisted structured memory.

---

## 7. Axiom monitoring

Axiom is used for full-stack server telemetry.

Current monitoring window:

~~~text
5 minutes
~~~

Current inspection limit:

~~~text
50 server events
~~~

Slow request thresholds:

~~~text
> 1 second  → slow
≥ 3 seconds → very slow
~~~

Commands:

~~~text
/status
/axiom
/axiomraw
~~~

### \`/status\`

Shows:

- System health classification
- API events inspected
- Slow API count
- Very slow API count
- Detected errors
- Slowest APIs
- Fastest APIs
- Latest API event

### \`/axiom\`

Shows a compact list of recent routed API events.

### \`/axiomraw\`

Shows a recent raw Axiom event for debugging/schema inspection.

### Axiom alerts

Axiom can POST to:

~~~text
/api/axiom-alert
~~~

Header:

~~~text
x-guardian-secret
~~~

The secret must match \`AXIOM_WEBHOOK_SECRET\`.

---

## 8. ElevenLabs capabilities

The bot exposes Telegram controls for multiple ElevenLabs capabilities.

### Voice

~~~text
/voicetest
/say <text>
~~~

### Speech-to-text

Reply to a Telegram voice message:

~~~text
/elevenstt
~~~

### Speech transformation

Reply to a voice message:

~~~text
/voicechange
~~~

This transforms the replied audio into the configured Sarah voice.

### Audio cleanup

Reply to a voice message:

~~~text
/isolate
~~~

### Sound effects

~~~text
/sfx <description>
~~~

Example:

~~~text
/sfx gentle rain with distant thunder
~~~

### Music

~~~text
/music <description>
~~~

Example:

~~~text
/music soft romantic piano for a calm evening
~~~

### Image generation

~~~text
/image <prompt>
~~~

Then check the async result with:

~~~text
/imagestatus <generation_id>
~~~

### Video generation

~~~text
/video <prompt>
~~~

Then check:

~~~text
/videostatus <generation_id>
~~~

Image/video generation may depend on the provider account, model availability, and plan permissions.

---

## 9. AI provider strategy

### Conversation

Current preferred order:

~~~text
Gemini Live
   ↓
Gemini
   ↓
Groq
~~~

The application automatically skips providers that are unavailable and temporarily cools down providers after selected transient/rate-limit failures.

### Speech-to-text

Current order:

~~~text
Groq Whisper
   ↓
Gemini audio transcription
~~~

### Text-to-speech

Sarah's spoken output is generated through ElevenLabs.

ElevenLabs is intentionally treated as the voice layer rather than exposing provider names to the user.

---

## 10. Credit-saving voice mode

The voice path includes safeguards to reduce unnecessary TTS usage.

Current behavior:

- Sarah voice output is capped by \`SARAH_VOICE_MAX_CHARS\`.
- Default voice cap: \`550\` characters.
- Repeated identical short TTS requests can be served from a short in-memory cache.
- The app checks ElevenLabs subscription/quota information before TTS generation when available.
- When voice generation is unavailable, Sarah can fall back to a text response instead of pretending that voice was generated.
- Long replies are shortened for voice so conversations stay natural and economical.

Recommended setting:

~~~env
SARAH_VOICE_MAX_CHARS=550
~~~

---

## 11. Latency and performance design

The project includes deliberate latency optimizations.

### Fast \`/start\`

\`/start\` has a dedicated fast path in \`api/telegram.js\`.

The fast path avoids:

- Axiom SDK loading
- AI provider requests
- ElevenLabs requests
- Full conversation initialization

This keeps a simple Telegram command fast.

### Lazy Axiom initialization

The Axiom SDK is loaded only when an Axiom operation is actually requested.

### Cached MongoDB connection

MongoDB uses a reusable/cached \`MongoClient\` so Vercel serverless requests do not create a new database connection unnecessarily.

### Voice reply limits

Shorter voice responses reduce:

- TTS characters
- Request size
- Generation time
- ElevenLabs credit usage

---

## 12. Environment variables

Create a local file:

~~~text
.env
~~~

**Never commit it.** The repository already ignores \`.env\` and \`.env*.local\`.

### Required

~~~env
TELEGRAM_BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
OWNER_CHAT_ID=YOUR_TELEGRAM_OWNER_CHAT_ID

AXIOM_TOKEN=YOUR_AXIOM_TOKEN
AXIOM_DATASET=test
AXIOM_WEBHOOK_SECRET=YOUR_AXIOM_WEBHOOK_SECRET

GEMINI_API_KEY=YOUR_GEMINI_API_KEY
GROQ_API_KEY=YOUR_GROQ_API_KEY

ELEVENLABS_API_KEY=YOUR_ELEVENLABS_API_KEY
ELEVENLABS_VOICE_ID=YOUR_SARAH_VOICE_ID

MONGODB_URI=YOUR_MONGODB_ATLAS_URI
MONGODB_DB=sarah
~~~

### Optional/current configuration

~~~env
GEMINI_MODEL=gemini-3.8-flash
GEMINI_LIVE_MODEL=gemini-3.8-live

GROQ_MODEL=openai/gpt-oss-120b
GROQ_STT_MODEL=whisper-large-v3-turbo

ELEVENLABS_MODEL_ID=eleven_multilingual_v2
ELEVENLABS_IMAGE_MODEL=gpt-image-2
ELEVENLABS_VIDEO_MODEL=veo-3.1-fast-generate-001

SARAH_VOICE_MAX_CHARS=550
SARAH_VOICE_CACHE_TTL_MS=60000
~~~

### Variable classification

Keep secrets protected:

~~~text
TELEGRAM_BOT_TOKEN       → Secret
AXIOM_TOKEN              → Secret
AXIOM_WEBHOOK_SECRET     → Secret
GEMINI_API_KEY           → Secret
GROQ_API_KEY             → Secret
ELEVENLABS_API_KEY       → Secret
MONGODB_URI              → Secret
~~~

Normal configuration:

~~~text
OWNER_CHAT_ID
AXIOM_DATASET
GEMINI_MODEL
GEMINI_LIVE_MODEL
GROQ_MODEL
GROQ_STT_MODEL
ELEVENLABS_VOICE_ID
ELEVENLABS_MODEL_ID
ELEVENLABS_IMAGE_MODEL
ELEVENLABS_VIDEO_MODEL
SARAH_VOICE_MAX_CHARS
SARAH_VOICE_CACHE_TTL_MS
MONGODB_DB
~~~

---

## 13. Local setup

### 1. Clone the repository

~~~bash
git clone https://github.com/labsadik/telegram-guardian.git
cd telegram-guardian
~~~

### 2. Install dependencies

~~~bash
npm install
~~~

### 3. Create \`.env\`

Add the variables described above.

### 4. Start locally

~~~bash
npm start
~~~

This starts the Vercel development server.

### 5. Check syntax

~~~bash
node --check lib/guardian.js
node --check lib/memory.js
node --check api/telegram.js
~~~

---

## 14. Vercel deployment

Link the local directory to the production Vercel project:

~~~bash
vercel link --yes --scope workrcs-projects --project bot_telegram-guardian
~~~

Deploy:

~~~bash
vercel deploy --prod --scope workrcs-projects --project bot_telegram-guardian
~~~

Production alias:

~~~text
https://bottelegram-guardian.vercel.app
~~~

### Uploading environment variables

Example:

~~~bash
vercel env add MONGODB_URI production --scope workrcs-projects --project bot_telegram-guardian
~~~

For a normal configuration value:

~~~bash
vercel env add SARAH_VOICE_MAX_CHARS production --scope workrcs-projects --project bot_telegram-guardian
~~~

Enter:

~~~text
550
~~~

Verify variable names:

~~~bash
vercel env ls production --scope workrcs-projects --project bot_telegram-guardian
~~~

Do not print or paste secret values into public documentation, GitHub issues, or chat.

---

## 15. Telegram webhook setup

The production webhook should point to:

~~~text
https://bottelegram-guardian.vercel.app/api/telegram
~~~

After changing deployment or webhook settings, check Telegram webhook information.

Useful fields include:

- webhook URL
- pending update count
- last error date
- last error message

A growing pending update count combined with a webhook 500 means the Telegram request is reaching the server but the function is failing.

---

## 16. Basic testing checklist

### Telegram

~~~text
/start
/ping
~~~

### Sarah text

~~~text
Hello Sarah
~~~

### Sarah Bengali

~~~text
Sarah, আজ আমার সাথে একটু কথা বলো।
~~~

### Voice

~~~text
/voicetest
~~~

Then send a voice message.

### Voice to text

Reply to a voice message:

~~~text
/elevenstt
~~~

### Text to voice

~~~text
/say Hello, I'm Sarah.
~~~

### Memory

~~~text
/mongotest
/memory
/remember I prefer Bengali for normal conversations.
~~~

### Monitoring

~~~text
/status
/axiom
/axiomraw
~~~

### Media

~~~text
/sfx gentle rain
/music soft piano
/image cozy rainy evening room
/video cinematic rainy evening city
~~~

---

## 17. Troubleshooting

### \`ElevenLabs HTTP 401\`

Check:

- API key is valid
- \`text_to_speech\` permission is enabled
- The configured voice is allowed for API use on the current plan

### \`ElevenLabs HTTP 402\`

This can indicate a plan/voice access restriction or exhausted quota.

Check ElevenLabs Billing and the selected voice.

### \`Telegram webhook 500\`

Check Vercel production logs:

~~~bash
vercel logs --environment production --status-code 500 --since 10m --expand --limit 50 --scope workrcs-projects --project bot_telegram-guardian
~~~

A syntax error or import/runtime exception will usually appear in the log.

### \`/start\` is slow

Verify that:

- the latest deployment is active
- \`api/telegram.js\` contains the fast path
- there is no startup exception in \`lib/guardian.js\`

### MongoDB memory errors

Check:

~~~text
/mongotest
~~~

Then verify:

- \`MONGODB_URI\`
- \`MONGODB_DB=sarah\`
- MongoDB Atlas network access
- database user permissions

### Pending Telegram updates

Check the webhook information and look at:

~~~text
pending_update_count
last_error_message
~~~

If Telegram reports a repeated \`500 Internal Server Error\`, inspect Vercel runtime logs before changing the webhook.

---

## 18. Security model

This project is intended to remain private even though the repository may be publicly viewable.

Security controls currently include:

- Owner-only Telegram access through \`OWNER_CHAT_ID\`
- Secret-protected Axiom webhook
- Secret API keys stored in environment variables
- \`.env\` ignored from Git
- No API credentials hard-coded into source
- Personal conversation data separated from Axiom telemetry
- No user-facing provider credential disclosure

Recommended production practice:

- Rotate keys that are ever exposed
- Use the minimum provider permissions required
- Keep the MongoDB connection string secret
- Restrict MongoDB network access where practical
- Review Vercel deployment protection settings
- Keep the Telegram bot token private

---

## 19. What can be upgraded next

The core is intentionally simple enough to maintain, but it can be extended substantially.

### Advanced memory

Potential next layer:

- Semantic/vector memory
- Memory importance scoring
- Memory confidence
- Memory expiration
- Duplicate-memory merging
- User-approved memory deletion
- “Forget this” command
- Conversation summaries for very long sessions
- Topic-based memory retrieval
- Structured preferences and relationship context

### Better realtime voice

A more advanced voice mode could provide:

- True low-latency streaming voice
- Streaming speech recognition
- Barge-in/interruption support
- Voice activity detection
- Realtime turn-taking
- Live session state
- Lower end-to-end voice latency

### AI tool calling

Sarah could be extended with controlled tools for:

- Server status
- Deployment status
- Axiom queries
- GitHub operations
- Database lookups
- Scheduled reminders
- Notifications
- Controlled external actions

Tool execution should always have explicit permissions and clear boundaries so Sarah does not claim an action happened unless it actually executed.

### Monitoring upgrades

Possible additions:

- More Axiom monitor types
- API error-rate thresholds
- Latency percentiles (p50/p95/p99)
- Endpoint-specific thresholds
- Deployment regression detection
- Service health scoring
- Incident grouping
- Alert deduplication
- Cooldown windows
- Escalation policies
- Uptime checks when the monitored application is completely down

### Reliability upgrades

Possible additions:

- Persistent provider cooldown state
- Retry/backoff policies
- Idempotent webhook handling
- Request correlation IDs
- Structured logs
- Health probes for every provider
- Circuit breakers
- Queue-based long-running work
- Background jobs for media generation
- Better webhook replay protection

### Privacy upgrades

Possible additions:

- Memory redaction
- Retention policies
- Per-memory consent flags
- Automatic deletion windows
- Data export/delete commands

---

## 20. Design principles

The project follows these principles:

1. **Telegram first** — the bot is the primary interface.
2. **Private by default** — owner-only control.
3. **Separate concerns** — personal memory in MongoDB, telemetry in Axiom.
4. **Fallback over failure** — provider failure should degrade gracefully where possible.
5. **No fake actions** — Sarah should never claim work that was not actually performed.
6. **Focused conversation** — answer the user's current question instead of producing unnecessary multi-topic responses.
7. **Voice should sound natural** — short, conversational voice responses are preferred.
8. **Keep expensive operations bounded** — especially TTS and long model contexts.
9. **Serverless compatible** — avoid unnecessary long-lived server assumptions.
10. **Upgradeable architecture** — memory, tools, realtime voice, monitoring, and automation can evolve independently.

---

## 21. Repository structure

~~~text
bot_telegram-guardian/
├── api/
│   ├── telegram.js
│   ├── axiom-alert.js
│   └── health.js
│
├── lib/
│   ├── guardian.js
│   └── memory.js
│
├── package.json
├── package-lock.json
├── vercel.json
├── README.md
└── LICENSE
~~~

### \`api/telegram.js\`

Telegram webhook entry point and fast \`/start\` path.

### \`api/axiom-alert.js\`

Authenticated Axiom → Telegram alert endpoint.

### \`api/health.js\`

Simple service health endpoint.

### \`lib/guardian.js\`

Sarah conversation logic, provider fallback, voice/media commands, Axiom monitoring, and Telegram command handling.

### \`lib/memory.js\`

MongoDB connection management, conversation persistence, memory retrieval, and memory storage.

---

## 22. License

This repository is **not open source**.

It is distributed under the proprietary commercial source-available license in [LICENSE](./LICENSE).

Viewing the source in a public repository does not grant permission to use, copy, execute, modify, redistribute, fork, sell, sublicense, or create derivative works unless expressly permitted by the copyright holder.

For commercial licensing or written permission, contact the copyright holder listed in the LICENSE.

---

## 23. Author

**Sadik Laskar**

For commercial licensing, enterprise acquisition, or written permission, see [LICENSE](./LICENSE).
