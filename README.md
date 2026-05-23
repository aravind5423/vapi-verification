# Vapi AI Phone Verification Webhook

A production-ready Node.js serverless webhook that triggers outbound Vapi AI phone calls to verify a person's identity and returns a `success` or `fail` result.

---

## How It Works

```
Client
  │
  ├─► POST /api/trigger  { name, phone_number }
  │         └── Calls Vapi → starts outbound verification call
  │
  │    [Vapi dials the number, runs the AI script]
  │         │
  │         └── Vapi POSTs events → POST /api/webhook
  │                   ├── call-started   → mark in_progress
  │                   ├── function-call  → store outcome code (P1_SUCCESS / P4_UNCLEAR / …)
  │                   └── call-ended     → finalise result
  │
  └─► GET /api/result?call_id=xxx
            └── { status: "completed", result: "success" | "fail" }
```

---

## Outcome Codes

| Code | Meaning | Final Result |
|---|---|---|
| `P1_SUCCESS` | Person confirmed identity | ✅ `success` |
| `P2_VOICEMAIL` | Voicemail reached | ❌ `fail` |
| `P3_UNREACHABLE` | Could not connect | ❌ `fail` |
| `P4_UNCLEAR` | Connected but unconfirmed / hostile | ❌ `fail` |

---

## Project Structure

```
vapi-verification/
├── api/
│   ├── trigger.js      # POST /api/trigger  — initiate call
│   ├── webhook.js      # POST /api/webhook  — handle Vapi events
│   └── result.js       # GET  /api/result   — poll for outcome
├── lib/
│   └── outcomeStore.js # In-memory (dev) / Vercel KV (prod) state
├── .env.example        # Environment variable template
├── vercel.json         # Vercel config
└── package.json
```

---

## Local Development

### Prerequisites
- Node.js 18+
- [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
- [ngrok](https://ngrok.com/) for public webhook URL during local dev

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Copy env template and fill in your values
cp .env.example .env.local

# 3. Start ngrok to get a public URL (in a separate terminal)
ngrok http 3000

# 4. Set WEBHOOK_BASE_URL in .env.local to the ngrok https URL
#    e.g. WEBHOOK_BASE_URL=https://abc123.ngrok.io

# 5. Run the dev server
npm run dev
# → server runs on http://localhost:3000
```

### Test the flow

```bash
# Trigger a call
curl -X POST http://localhost:3000/api/trigger \
  -H "Content-Type: application/json" \
  -d '{"name": "John Doe", "phone_number": "+919876543210"}'

# Response:
# { "success": true, "call_id": "abc-123", "message": "Verification call initiated" }

# Poll for result (repeat until status = "completed")
curl "http://localhost:3000/api/result?call_id=abc-123"

# Response when done:
# { "status": "completed", "result": "success", "outcome": "P1_SUCCESS" }
```

---

## Deploying to Vercel

```bash
# 1. Login to Vercel
vercel login

# 2. Link project (first time only)
vercel link

# 3. Set environment variables in Vercel dashboard or via CLI:
vercel env add VAPI_API_KEY
vercel env add VAPI_PHONE_NUMBER_ID
vercel env add WEBHOOK_BASE_URL    # your Vercel app URL e.g. https://vapi-verification.vercel.app

# Optional: Vercel KV for persistent state
# Create a KV store in Vercel dashboard → Storage → Create KV
# Then add the auto-generated KV_REST_API_URL and KV_REST_API_TOKEN env vars

# 4. Deploy
npm run deploy
```

After deployment, set `WEBHOOK_BASE_URL` to your actual Vercel URL (e.g. `https://vapi-verification.vercel.app`).

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `VAPI_API_KEY` | ✅ | Your Vapi private API key |
| `VAPI_PHONE_NUMBER_ID` | ✅ | Vapi phone number ID to call from |
| `WEBHOOK_BASE_URL` | ✅ | Public URL of this server (no trailing slash) |
| `UPSTASH_REDIS_REST_URL` | Optional | Upstash Redis REST URL (enables persistent state) |
| `UPSTASH_REDIS_REST_TOKEN` | Optional | Upstash Redis REST token |

---

## State Management

- **Local dev**: uses an in-memory `Map` — state resets on server restart (fine for testing)
- **Production**: set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` to use **Upstash Redis** (persistent across serverless invocations, 1-hour TTL per call record)

> **Note**: Vercel KV (`@vercel/kv`) was deprecated in 2024. The replacement is [Upstash Redis](https://upstash.com). Create a free database, then add it to your Vercel project under **Integrations → Upstash** — the env vars are auto-injected.

---

## API Reference

### `POST /api/trigger`

Start a verification call.

**Request body:**
```json
{ "name": "John Doe", "phone_number": "+919876543210" }
```

**Success response:**
```json
{ "success": true, "call_id": "vapi-call-id", "message": "Verification call initiated" }
```

**Error response:**
```json
{ "success": false, "error": "Missing required fields: phone_number" }
```

---

### `POST /api/webhook`

Vapi posts events here automatically. No manual calls needed.

---

### `GET /api/result?call_id=<id>`

Poll for result.

**Pending:**
```json
{ "status": "pending", "call_id": "..." }
```

**Completed:**
```json
{ "status": "completed", "result": "success", "outcome": "P1_SUCCESS", "call_id": "..." }
```

**Not found:**
```json
{ "status": "not_found", "call_id": "..." }
```

---

## Notes

- Phone numbers must be in **E.164 format**: `+[country code][number]` (e.g. `+919876543210`)
- Vapi uses an **inline assistant** per call — no assistant pre-registration needed in the Vapi dashboard
- Vapi **requires a 200 response** with `{ result }` for `function-call` events — the webhook handles this correctly
- Check your Vapi plan's call limits at [dashboard.vapi.ai](https://dashboard.vapi.ai)
