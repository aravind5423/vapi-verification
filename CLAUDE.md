# CLAUDE.md

Guidance for working in this repo.

## What this is
A **browser-based AI voice verification** app. A visitor enters their name, clicks Start, and has a live voice conversation with an AI agent ("Freya") **in the browser** via the Vapi Web SDK (`@vapi-ai/web`). Freya runs a short "pulse check" survey and records an outcome (`P1`–`P4`) that the page shows in real time. No phone calls, no Twilio — the call is WebRTC mic/speakers.

## Architecture (read this first)
- **Pure static SPA built with Vite.** There is **no backend / no `api/` functions / no database.** (The old phone-calling serverless backend was removed — see git history if curious.)
- **The agent lives in the Vapi dashboard, not in this code.** The frontend only starts a dashboard assistant *by ID*. The system prompt, voice, tools, and `set_outcome` function are all configured on the Vapi assistant.
  - To change agent behavior (prompt/voice/tools): edit the dashboard assistant, or re-run `scripts/configure-assistant.mjs`. **Do not look for the prompt in the frontend** — it isn't there.
- **Outcome capture is client-side.** The dashboard assistant calls an **async** `set_outcome` tool; with the assistant's **clientMessages including `tool-calls`**, that arrives in the browser via `vapi.on('message')` and is read in `src/main.js`.

```
Browser SPA  ──>  new Vapi(VITE_VAPI_PUBLIC_KEY)
             ──>  vapi.start(VITE_VAPI_ASSISTANT_ID, { variableValues: { name } })
             ──>  vapi.on('message')  → set_outcome → P1–P4 result card
             ──>  vapi.on('volume-level' / 'call-end' / 'error') → UI
```

## Commands
```bash
npm install           # install deps (@vapi-ai/web, vite)
npm run dev           # Vite dev server → http://localhost:5173
npm run build         # production build → dist/
npm run preview       # preview the production build

# (Re)configure the dashboard assistant via the Vapi API — run with your PRIVATE key:
#   PowerShell: $env:VAPI_PRIVATE_KEY="..."; $env:VAPI_ASSISTANT_ID="..."; node scripts/configure-assistant.mjs
node scripts/configure-assistant.mjs
```

## Environment variables
Both are **browser-safe** (public) and inlined by Vite **at build time**. They're **optional** — `src/main.js` has hardcoded fallbacks so the app deploys with zero config — but env vars override them when set (`.env.local` for dev, Vercel env for prod; rebuild/redeploy to change).

| Var | What |
|---|---|
| `VITE_VAPI_PUBLIC_KEY` | Vapi **public** key (not the private key) |
| `VITE_VAPI_ASSISTANT_ID` | The dashboard assistant's ID |

The **private** key is used only by `scripts/configure-assistant.mjs` (never bundled, never committed).

**Two assistants (A/B):** the app defaults to **"Freya — Human"** `93580ccf-f49e-4749-8397-56ce3dfc9097` (ElevenLabs `eleven_turbo_v2_5` voice + casual register). A fallback **"Freya"** `28fe3455-e09e-4d09-bf74-6c7b0411a804` keeps the proven **Cartesia** voice — switch back by setting `VITE_VAPI_ASSISTANT_ID` to it (or editing the `src/main.js` fallback). `configure-assistant.mjs` updates an existing assistant (`VAPI_ASSISTANT_ID`) or creates a new one (`VAPI_CREATE=1 VAPI_ASSISTANT_NAME=…`), with model + voice fallbacks if Vapi rejects a choice.

## Outcome model
| Code | Meaning | UI |
|---|---|---|
| `P1_SUCCESS` | Confirmed the right person | ✅ success |
| `P2_VOICEMAIL` | Voicemail / machine | 📬 voicemail |
| `P3_UNREACHABLE` | Couldn't connect / dead air | 📵 error |
| `P4_DECLINED` | Reached the person but they declined / weren't interested / hostile | 🚫 warning |
| `P5_WRONG_PERSON` | Reached someone, but wrong person / target unavailable | 🙅 neutral |
| `P6_UNCLEAR` | Reached someone but couldn't determine (garbled / language / ambiguous) | 🤔 muted |

## File map
- `index.html` — Vite entry; markup for the form, voice orb, transcript, controls, result card. Also contains a small inline script that **shims `window.global`/`window.process`** (for Daily.co) and an **on-page error banner** (`window.__showBootError`).
- `src/main.js` — all SDK logic: resolve the Vapi constructor (see gotchas), start by assistant ID, capture `set_outcome` from messages, volume-reactive orb, mute/end, mic & error handling. Passes the caller's **first name** as `{{name}}`.
- `src/style.css` — styles.
- `scripts/configure-assistant.mjs` — one-shot Vapi API setup of the assistant (prompt, `set_outcome` async tool, `clientMessages: tool-calls`, voice, endCallPhrases). The source of truth for the agent config in code form.
- `vite.config.js` — defines `global: globalThis` for the SDK. `vercel.json` — pins `framework: vite`, build → `dist/`.
- `.env.example`.

## Deploy (Vercel)
`vercel.json` pins `framework: vite` (`vite build` → `dist/`), so Vercel builds correctly **without** touching the project's Framework Preset. Thanks to the fallbacks in `src/main.js` it deploys with **no env vars**; set `VITE_*` env vars only to override the baked-in values. A push to `main` auto-deploys (Git-connected).

## Gotchas
- **`@vapi-ai/web` is CommonJS** (`module.exports = { default: VapiClass }`). A plain `import Vapi from '@vapi-ai/web'` double-unwraps in the production bundle → `"X.default is not a constructor"`. `src/main.js` therefore imports the namespace and walks to the real constructor. **Don't revert to the default import.**
- **Daily.co (under the SDK) needs Node globals.** `index.html` shims `window.global`/`window.process` and `vite.config.js` defines `global: globalThis`. Without these the call errors when it starts.
- **`clientMessages` must include `tool-calls`** on the assistant, or the browser never receives the outcome (it'd default to `P4`).
- **`set_outcome` is async** (fire-and-forget) so the model doesn't block waiting for a server response that doesn't exist in this client-only setup.
- **Two-mode call ending (don't merge them).** Scenarios with a spoken goodbye end via `endCallPhrases` (the agent says the line, which ends with a phrase like "have a good day", and Vapi hangs up *after* the utterance). The `endCall` **tool** is reserved for silent ends (voicemail/dead-air). Letting the model call the `endCall` tool right after a closing line **cuts off the final TTS** — that was the "voice glitches at the end" bug. The prompt in `configure-assistant.mjs` enforces this; keep it.
- **Mic needs a secure context** — works on `localhost` and HTTPS (Vercel), not plain HTTP. If a user denied the mic, the browser won't re-prompt; they must re-allow it in site settings and reload.
- **Debugging a failed call (server vs browser):** `POST https://api.vapi.ai/call/web` with the **public** key + `{ assistantId }` should return **201** with a `webCallUrl`. If that works, your key/assistant are fine and the failure is browser-side (mic/WebRTC). The on-page error banner shows the exact runtime error.
- The **public key lets anyone on the page start (paid) calls** — restrict allowed origins to your domain in the Vapi dashboard for production.
- A real end-to-end test needs a **mic + a human** — the voice call can't be driven headlessly; verify in a browser.
