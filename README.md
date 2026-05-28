# Vapi AI Voice Verification (Web Call)

A browser-based identity "pulse check" — the visitor enters their name, clicks **Start**, and has a live voice conversation with an AI agent ("Freya") **directly in the browser** via the [Vapi Web SDK](https://docs.vapi.ai/quickstart/web). No phone number, no Twilio, no per-number verification. The agent records a `set_outcome` result that the page reads in real time and shows as **P1–P4**.

---

## How it works

```
Browser (static SPA, built with Vite)
  │
  ├─ new Vapi(VITE_VAPI_PUBLIC_KEY)
  ├─ user enters name → vapi.start(VITE_VAPI_ASSISTANT_ID, { variableValues: { name } })
  │        └── WebRTC voice call runs in the browser (mic + speakers)
  │
  ├─ vapi.on('message')  → captures the set_outcome tool call → outcome code
  ├─ vapi.on('call-end') → renders the P1–P4 result card
  └─ vapi.on('error')    → mic / connection error UI
```

The assistant's behavior (prompt, voice, tools) is managed **in the Vapi dashboard**, not in this repo. The frontend just starts it by ID.

### Outcome codes

| Code | Meaning | Shown as |
|---|---|---|
| `P1_SUCCESS` | Confirmed they reached the right person | ✅ success |
| `P2_VOICEMAIL` | Voicemail / answering machine | 📬 voicemail |
| `P3_UNREACHABLE` | Could not connect | 📵 fail |
| `P4_UNCLEAR` | Reached a human but couldn't confirm / refused | ❓ fail |

---

## ⚠️ One-time dashboard setup (required)

The agent lives in the Vapi dashboard. Configure the **Freya** assistant once:

1. **System Prompt** — the pulse-check Freya script (persona + scenarios A–G + the `set_outcome` rule). Use `{{name}}` where the caller's name should appear.
2. **First Message** — `Hi, um, is this {{name}}?`, mode **Assistant speaks first**.
3. **Voice** — Cartesia (e.g. "Callie"); **Transcriber** — Deepgram `nova-3`.
4. **Tool** — create a **function tool named `set_outcome`** with one parameter `outcome` (enum: `P1_SUCCESS`, `P2_VOICEMAIL`, `P3_UNREACHABLE`, `P4_UNCLEAR`). Mark it **async / fire-and-forget** so the model doesn't block waiting for a result.
5. **Advanced → Client Messages** — make sure **`tool-calls`** (and `function-call`) is enabled. This is what delivers the outcome to the browser.
6. **End Call Phrases** — e.g. `have a great rest of your day`, `have a good day`, so the call hangs up cleanly.
7. **Publish**, then copy the **Assistant ID** and your **Public API Key** (Dashboard → API Keys → **Public**, *not* the private key).

---

## Environment variables

Both are browser-safe and inlined by Vite at build time (see `.env.example`):

| Variable | Description |
|---|---|
| `VITE_VAPI_PUBLIC_KEY` | Vapi **public** API key |
| `VITE_VAPI_ASSISTANT_ID` | The dashboard assistant's ID |

---

## Local development

```bash
npm install
cp .env.example .env.local   # fill in your two VITE_ values
npm run dev                  # → http://localhost:5173
```

Open the page, enter a name, click **Start**, and **allow microphone access**. Talk to Freya; the result card appears when the call ends.

> Mic access needs a secure context — `http://localhost` is allowed by browsers; any other host must be HTTPS.

---

## Build & deploy (Vercel)

```bash
npm run build     # outputs to dist/
npm run preview   # preview the production build locally
```

Vercel auto-detects Vite (build `vite build`, output `dist/`). Deploy steps:

1. Set **`VITE_VAPI_PUBLIC_KEY`** and **`VITE_VAPI_ASSISTANT_ID`** in Vercel → Settings → Environment Variables (Production). They're read at **build time**, so redeploy after changing them.
2. If the Vercel project's Framework Preset is still "Other" from a previous setup, set it to **Vite**.
3. Deploy (push to `main` if Git-connected, or `vercel --prod`).

---

## Production hardening

- **Restrict the public key** to your deployed domain in the Vapi dashboard (public-key settings → allowed origins). Otherwise anyone could use it from another site and run up paid calls.
- Consider a usage cap on the account, since web calls are initiated client-side.

---

## Project structure

```
vapi-verification/
├── index.html        # Vite entry — markup + call/result UI
├── src/
│   ├── main.js        # Vapi Web SDK logic (start, events, outcome capture, controls)
│   └── style.css      # styles
├── vite.config.js
├── .env.example
└── package.json
```
