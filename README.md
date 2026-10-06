# Telegram Guardian

Private Telegram-only monitoring service for the WorkRCS backend.

## Runtime

Node.js 24.x, Vercel Serverless Functions, grammY, and Axiom.

## Endpoints

- `/api/telegram` — Telegram webhook
- `/api/axiom-alert` — Axiom monitor webhook
- `/api/health` — health endpoint

## Environment variables

Set these in Vercel and never commit their values:

- `TELEGRAM_BOT_TOKEN`
- `OWNER_CHAT_ID`
- `AXIOM_TOKEN`
- `AXIOM_DATASET` (current dataset: `test`)
- `AXIOM_WEBHOOK_SECRET`

The bot only responds to `OWNER_CHAT_ID`.

## Commands

`/start`, `/ping`, `/status`, `/axiom`, `/axiomraw`

## Axiom → Telegram alert setup

The Vercel endpoint is ready for an Axiom Custom Webhook notifier:

`https://telegram-guardian.vercel.app/api/axiom-alert`

In Axiom:

1. Monitors → Manage notifiers → New notifier → Custom webhook.
2. Webhook URL: the endpoint above.
3. Add a secret header:
   - Name: `x-guardian-secret`
   - Value: the same `AXIOM_WEBHOOK_SECRET` stored in Vercel.
4. Keep Axiom's default JSON webhook body template.
5. Create the notifier, then attach it to your monitors.

Recommended monitor rules for the current `test` dataset:

### Slow API warning

Use a Threshold monitor with:

- Query range: 5 minutes
- Frequency: 1 minute (or 5 minutes for lower monitor activity)
- Operator: Above or equal
- Threshold: 1
- Notifier: Guardian webhook
- Resolvable: enabled

APL:

```apl
['test']
| where _time >= ago(5m)
| where kind == 'server'
| where name matches regex "^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) "
| where duration >= 1s
| summarize count()
```

### Very slow API critical

Use a Threshold monitor with:

- Query range: 5 minutes
- Frequency: 1 minute
- Operator: Above or equal
- Threshold: 1
- Notifier: Guardian webhook
- Resolvable: enabled

APL:

```apl
['test']
| where _time >= ago(5m)
| where kind == 'server'
| where name matches regex "^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) "
| where duration >= 3s
| summarize count()
```

### Error event monitor

Use a Match monitor to notify when a real error event is emitted. Start with:

```apl
['test']
| where _time >= ago(5m)
| where kind == 'server'
| where error != ''
| project _time, name, duration, error, ['service.name']
```

Because the current telemetry sometimes has null HTTP status fields, treat `Errors: 0` in `/status` as "no error field / >=400 event detected in the inspected sample", not proof that every request succeeded.

Axiom custom webhook notifications are JSON POSTs and support custom headers. Their default payload includes `Action`, monitor information, body, timestamp, value, and matched event data, which the Guardian endpoint parses into Telegram alerts.

## Deployment

Push to `main` and deploy the repository with Vercel.

Telegram webhook:

`https://telegram-guardian.vercel.app/api/telegram`

Axiom webhook:

`https://telegram-guardian.vercel.app/api/axiom-alert`
