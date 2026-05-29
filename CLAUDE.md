# CLAUDE.md

Guidance for working in this repo.

## What this is
A **browser-based AI voice verification** app. A visitor enters their name, clicks Start, and has a live voice conversation with an AI agent ("Freya") **in the browser** via the Vapi Web SDK (`@vapi-ai/web`). Freya runs a short "pulse check" survey and records an outcome (`P1`–`P6`) that the page shows in real time. No phone calls, no Twilio — the call is WebRTC mic/speakers.

## Architecture (read this first)
- **Vite SPA + one tiny serverless function.** The UI is a static Vite SPA. There is **no database** and **no phone-calling backend** (the old one was removed — see git history). The **one** server-side piece is `api/outcome.js` (a Vercel function): a fallback that fetches a call's authoritative outcome from Vapi when the in-call `set_outcome` is missed. The happy path never touches it.
- **The agent lives in the Vapi dashboard, not in this code.** The frontend only starts a dashboard assistant *by ID*. The system prompt, voice, tools, and `set_outcome` function are all configured on the Vapi assistant.
  - To change agent behavior (prompt/voice/tools): edit the dashboard assistant, or re-run `scripts/configure-assistant.mjs`. **Do not look for the prompt in the frontend** — it isn't there.
- **Outcome capture is client-side.** The dashboard assistant calls an **async** `set_outcome` tool; with the assistant's **clientMessages including `tool-calls`**, that arrives in the browser via `vapi.on('message')` and is read in `src/main.js`.

```
Browser SPA  ──>  new Vapi(VITE_VAPI_PUBLIC_KEY)
             ──>  vapi.start(VITE_VAPI_ASSISTANT_ID, { variableValues: { name } })
             ──>  vapi.on('message')  → set_outcome (P1–P6) captured
             ──>  vapi.on('speech-end') → reveal the result card (when Freya finishes the goodbye)
             ──>  vapi.on('volume-level' / 'call-start' / 'call-end' / 'error') → UI/state
             ──>  call-end with NO set_outcome → GET /api/outcome?callId=… (server reads
                  the call's set_outcome / analysis.structuredData) → render the P-code
```

The **safety net** has two layers: (1) `analysisPlan.structuredDataPlan` on the assistant classifies every call from its transcript server-side (`call.analysis.structuredData.outcome`, 30s timeout); (2) `api/outcome.js` lets the browser read that (or a late `set_outcome`) when the live tool call is missed, so the on-screen result is robust without a model retry. Needs **`VAPI_PRIVATE_KEY`** as a Vercel **server** env var (never `VITE_`-prefixed). Local full-stack test: `vercel dev` (plain `vite dev` returns 404 for `/api/outcome`, and the client falls back to the neutral card).

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

The **private** key (`VAPI_PRIVATE_KEY`) is **server-side only** — never bundled, never committed. Three consumers: `scripts/configure-assistant.mjs` (PATCH the assistant), `scripts/diagnose-last-call.mjs` (reads it from `.env.local`), and the **`api/outcome.js`** serverless function (must be set in **Vercel** env for the live-UI fallback to work in prod).

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
- `index.html` — Vite entry. **Split-console layout** driven by `data-state` on `#app` (`idle`/`calling`/`result`): *idle* = two panes (hero + "how it works" steps | start-card form); *calling/result* = a single centered card (voice orb + status + Mute/End → outcome badge + retry). No live transcript (removed). Inline scripts **shim `window.global`/`window.process`** (for Daily.co) and provide the **on-page error banner** (`window.__showBootError` / `window.__clearBootError`).
- `src/main.js` — all SDK logic: resolve the Vapi constructor (see gotchas); imports pure helpers from `src/utils.js`; **pre-warms the mic** (getUserMedia) before `vapi.start`; ~20s **connect timeout**; **double-submit guard** (`connecting` flag); captures `set_outcome` and reveals the result on the assistant's **`speech-end`** (so the UI doesn't flip before the goodbye finishes); on **`call-end` with no captured outcome** it calls **`/api/outcome`** (server-side fallback) and shows "Finalizing…" before the neutral card; volume-reactive orb (rAF-throttled); mute/end/retry; `data-state` machine; mic & error handling. Passes the **first name** as `{{name}}` and remembers the **call id** for the fallback.
- `src/utils.js` — DOM-free, unit-tested helpers: `normalizeFirstName()` (strips titles like "Mr.Ara", Title-cases ALL-CAPS so TTS doesn't spell it, **keeps Unicode/accented/non-Latin names**, caps length), `parseArgs`, `describeError`, and `OUTCOME_CONFIG`. Tested in `src/utils.test.js` (Vitest, `npm test`).
- `src/style.css` — styles (split-console grid, orb states, 6 outcome accents, responsive stack, reduced-motion).
- `api/outcome.js` — **Vercel serverless function** (the only backend). Given a `callId`, returns that call's authoritative outcome — first any `set_outcome` in the transcript, else `analysis.structuredData.outcome` — so the live UI is robust when the in-call tool call is missed. Validates the id (no SSRF), 8s upstream timeout, returns only a P-code, private key stays server-side.
- `scripts/configure-assistant.mjs` — source of truth for the agent in code. PATCHes (or, with `VAPI_CREATE=1`, POSTs a new) assistant: system prompt (scenarios A–H + "extra nuances" incl. scam/identity-gate/state-aware re-confirm, + 6 absolute rules), **`temperature: 0.3`** (reliable tool-calling), `set_outcome` async tool (P1–P6) + `endCall` tool, `clientMessages`, voice (Cartesia `sonic-3.5` + `chunkPlan`, `backgroundSound:"off"`), `endCallPhrases`, silence handling, speaking plans, and **`analysisPlan.structuredDataPlan`** (30s — server-side transcript classification backstop). Has a **model-candidate fallback loop** (prefers **`gpt-4o`** for reliable *native* tool-calling; chat-tuned snapshots like `gpt-5.2-chat-latest` sometimes *speak* the `set_outcome` call as gibberish, so they're last) + a `fetchWithTimeout` wrapper.
- `scripts/diagnose-last-call.mjs` — pulls recent calls from the Vapi API (private key from `.env.local`) and prints each call's transcript, tool calls (incl. `set_outcome`), `endedReason`, and `analysis.structuredData` — the tool for debugging outcome capture.
- `vite.config.js` — defines `global: globalThis` for the SDK. `vercel.json` — pins `framework: vite`, build → `dist/`.
- `.env.example`.

## Deploy (Vercel)
`vercel.json` pins `framework: vite` (`vite build` → `dist/`), so Vercel builds correctly **without** touching the project's Framework Preset. Thanks to the fallbacks in `src/main.js` it deploys with **no env vars**; set `VITE_*` env vars only to override the baked-in values. A push to `main` auto-deploys (Git-connected).

## Gotchas
- **`@vapi-ai/web` is CommonJS** (`module.exports = { default: VapiClass }`). A plain `import Vapi from '@vapi-ai/web'` double-unwraps in the production bundle → `"X.default is not a constructor"`. `src/main.js` therefore imports the namespace and walks to the real constructor. **Don't revert to the default import.**
- **Daily.co (under the SDK) needs Node globals.** `index.html` shims `window.global`/`window.process` and `vite.config.js` defines `global: globalThis`. Without these the call errors when it starts.
- **`clientMessages` must include `tool-calls`** on the assistant, or the browser never receives the outcome (the page then shows a neutral "Call Ended" with no P-code).
- **`set_outcome` is async** (fire-and-forget) so the model doesn't block waiting for a server response that doesn't exist in this client-only setup.
- **The result card renders on `speech-end`, not on `set_outcome`.** Capturing `set_outcome` only *stores* the outcome; `main.js` reveals it when Freya finishes the goodbye (`speech-end`), with a fallback timer + `call-end` as backstops. Rendering instantly on `set_outcome` made the UI flip before she stopped talking — don't do that.
- **Never name-match the caller by ear.** Speech-to-text mangles names, so the prompt treats any "yes/speaking/this is me" as confirmed (P1) even if the spoken name differs from `{{name}}`; only an explicit denial → P5. (A past bug marked a confirmed person P5 because STT heard "Aravind" as "Taravan".)
- **ALL-CAPS names get spelled out by TTS** ("N‑E‑E‑L…"). `main.js` `normalizeFirstName()` Title-cases the name before sending it; keep that.
- **Two-mode call ending (don't merge them).** Scenarios with a spoken goodbye end via `endCallPhrases` (the agent says the line, which ends with a phrase like "have a good day", and Vapi hangs up *after* the utterance). The `endCall` **tool** is reserved for silent ends (voicemail/dead-air). Letting the model call the `endCall` tool right after a closing line **cuts off the final TTS** — that was the "voice glitches at the end" bug. The prompt in `configure-assistant.mjs` enforces this; keep it.
- **`set_outcome` must be its OWN silent step BEFORE the spoken closing line — never combined into one reply.** gpt-4o is unreliable at emitting a tool call *and* spoken content in the same completion: when it produces the closing line it often **drops the tool call**, and because the line contains an `endCallPhrase` the call hangs up before `set_outcome` can fire → the browser shows the neutral "Call Ended" with no P-code. Real calls confirmed this (two confirmed/declined calls ended cleanly with **no** `set_outcome`). The spoken-ending instruction therefore orders it as: **Step 1 record the outcome silently, Step 2 speak the closing line** — mirroring the already-reliable silent-ending (set_outcome → endCall). Don't revert it to "say the outcome and the goodbye in one reply." To check live: `node scripts/diagnose-last-call.mjs` prints recent calls' transcript + tool calls + end reason (reads the **private** key from `.env.local`, never bundled).
- **Two-layer outcome safety net (live tool call can never be 100%).** Primary = the in-call `set_outcome` (shows live). Backups: (1) `analysisPlan.structuredDataPlan` classifies *every* call from its transcript server-side into `call.analysis.structuredData.outcome` (its `timeoutSeconds` was **5s by default → bumped to 30s**, or it silently returns empty); (2) `api/outcome.js` lets the browser read that authoritative result on `call-end` when the live tool call was missed. The server-side analysis runs *after* the call and does **not** reach the live UI on its own — `api/outcome.js` is the bridge, and it needs `VAPI_PRIVATE_KEY` in Vercel.
- **Model `temperature` is `0.3` on purpose.** Higher (the ~0.7+ default) made gpt-4o improvise goodbyes and skip the `set_outcome` tool. Keep it low for reliable scenario routing + tool-calling. (`maxTokens` is still unset — a known TODO if monologues appear.)
- **Identity gate + state-aware re-confirm.** The prompt must NOT ask the survey question until an explicit "yes" (Rule 6), and once confirmed it must NEVER re-ask "is this {{name}}" (Rule 2 / Scenario B branch). A past bug surveyed before confirming and re-confirmed identity after a mid-call question — keep both guards.
- **Silence is handled by `messagePlan.idleMessages`** (a varied pool) — after ~7s of quiet Freya nudges ("you still there?") up to twice, then the call ends at `silenceTimeoutSeconds`. Pure silence never invokes the model, so it ends with **no `set_outcome`** → neutral "Call Ended" (expected).
- **Audio smoothness vs. latency:** `voice.chunkPlan.minCharacters` at **40** keeps TTS smooth. Lowering it (e.g. 20) shaves start-latency but causes **stutter/gaps on marginal networks** — get snappiness from `startSpeakingPlan.waitSeconds` (0.2) instead, and leave chunkPlan at 40.
- **Voice is Cartesia `sonic-3.5`** (ElevenLabs was tried and reverted — it needed provider wiring and caused deploy/env churn). The active assistant is **`28fe3455…`**; the deployed `VITE_VAPI_ASSISTANT_ID` must point at a valid assistant or every call 400s ("assistant does not exist").
- **Mic needs a secure context** — works on `localhost` and HTTPS (Vercel), not plain HTTP. If a user denied the mic, the browser won't re-prompt; they must re-allow it in site settings and reload.
- **Debugging a failed call (server vs browser):** `POST https://api.vapi.ai/call/web` with the **public** key + `{ assistantId }` should return **201** with a `webCallUrl`. If that works, your key/assistant are fine and the failure is browser-side (mic/WebRTC). The on-page error banner shows the exact runtime error.
- The **public key lets anyone on the page start (paid) calls** — restrict allowed origins to your domain in the Vapi dashboard for production.
- A real end-to-end test needs a **mic + a human** — the voice call can't be driven headlessly; verify in a browser.
