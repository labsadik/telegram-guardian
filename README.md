# Telegram Guardian

Private Telegram-only monitoring and personal AI conversation bot for the WorkRCS backend.

## What it does

- Axiom monitoring commands
- Axiom webhook → Telegram alerts
- Owner-only Telegram access
- General text conversation
- Voice message → speech-to-text → LLM → ElevenLabs voice reply
- Gemini + Groq LLM fallback
- Groq Whisper + Gemini audio transcription fallback
- `/reset` conversation memory

## AI provider order

LLM:
1. Gemini `GEMINI_MODEL` (default: `gemini-3.8-flash`)
2. Groq `GROQ_MODEL` (default: `openai/gpt-oss-120b`)

Speech-to-text:
1. Groq `GROQ_STT_MODEL` (default: `whisper-large-v3-turbo`)
2. Gemini `GEMINI_MODEL`

When a provider returns a transient/rate-limit style response, Guardian temporarily cools that provider down and tries the next available provider.

## Environment variables

Required:
- `TELEGRAM_BOT_TOKEN`
- `OWNER_CHAT_ID`
- `AXIOM_TOKEN`
- `AXIOM_DATASET`
- `AXIOM_WEBHOOK_SECRET`

AI:
- `GEMINI_API_KEY`
- `GROQ_API_KEY`
- `ELEVENLABS_API_KEY`
- `ELEVENLABS_VOICE_ID`

Optional:
- `GEMINI_MODEL`
- `GROQ_MODEL`
- `GROQ_STT_MODEL`
- `ELEVENLABS_MODEL_ID`

Current dataset: `test`.

## Endpoints

- `/api/telegram`
- `/api/axiom-alert`
- `/api/health`

## Telegram

Send normal text for AI chat.

Send a Telegram voice message for a spoken AI reply.

Use `/reset` to clear the current in-memory conversation context.

## Axiom webhook

`https://bottelegram-guardian.vercel.app/api/axiom-alert`

Header:

`x-guardian-secret: YOUR_AXIOM_WEBHOOK_SECRET`

Telegram webhook:

`https://bottelegram-guardian.vercel.app/api/telegram`

