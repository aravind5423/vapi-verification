# CLAUDE.md

Guidance for working in this repo.

## What this is
A **browser-based AI voice identity-verification** app. A visitor enters their name, clicks Start, and has a live voice conversation with an AI agent ("Freya") **in the browser** via the Vapi Web SDK (`@vapi-ai/web`). Freya's primary job is to **verify identity** ("am I speaking with {{name}}?"); a one-question "pulse check" survey is secondary. After the call the page shows ONE clean, **definite** outcome — exactly one of `P1`–`P8`. No phone calls, no Twilio — the call is WebRTC mic/speakers.

**Design philosophy for the outcome:** every completed call resolves to one definite code via a **deterministic resolver** (not an LLM guess). There is **no abstention / "needs review" state** — each rule maps to the honest determinable outcome (e.g. a confirmed caller with an unclear survey answer is **P8 "Identity Confirmed"**, never a guessed P1).

## Architecture (read this first)
- **Vite SPA + one tiny serverless function.** The UI is a static Vite SPA. There is **no database** and **no phone-calling backend**. The one server-side piece is `api/outcome.js` (a Vercel function): after the call it computes the **authoritative** outcome and the browser renders it.
- **The agent lives in the Vapi dashboard, not in this code.** The frontend only starts a dashboard assistant *by ID*. The system prompt, voice, tools, and functions are all configured on the Vapi assistant. To change agent behavior: edit the dashboard assistant or re-run `scripts/configure-assistant.mjs`. **Do not look for the prompt in the frontend** — it isn't there.
- **The outcome is RESOLVED server-side, not guessed.** The agent records facts during the call (and emits a `set_outcome` hint); `api/resolve.js` derives exactly one definite code (P1–P8) from atomic facts + `endedReason`. The DeepSeek/Vapi classifiers are NOT consulted for the decision — they remain only as the side-by-side compare panel.

```
Browser SPA  ──>  new Vapi(VITE_VAPI_PUBLIC_KEY)
             ──>  vapi.start(VITE_VAPI_ASSISTANT_ID, { variableValues: { name } })
             ──>  live WebRTC conversation; the agent silently records facts/outcome
             ──>  vapi.on('call-end')  → card shows "Wrapping up…" (NEVER the raw live outcome)
             ──>  GET /api/outcome?callId=…  (poll, ~10s ceiling, bails fast on 5xx)
                       └─ api/outcome.js: fetch call → resolve() → ONE definite code (P1–P8)
                                          (+ a 3-way "compare" debug panel)
             ──>  render the single authoritative result — no flip, clean human label
```

The **outcome pipeline** (in `api/outcome.js`):
1. **`resolve()` (authoritative, `api/resolve.js`)** — atomic facts (explicit fact tool calls, else derived from the transcript) + `endedReason` → exactly one definite P-code (P1–P8). Pure, deterministic, no LLM, no abstention.
2. **Compare panel** — three independent signals for debugging only (they never affect the result): `gpt4o` (live `set_outcome`), `vapi` (`analysis.structuredData`), `deepseek` (a full-prompt pick).

Needs **`VAPI_PRIVATE_KEY`** (fetch the call) and **`DEEPSEEK_API_KEY`** (cross-check) as Vercel **server** env vars (never `VITE_`-prefixed). Local full-stack test: `vercel dev` (plain `vite dev` returns 404 for `/api/outcome`; the client then falls back to the live capture or a neutral card).

## Commands
```bash
npm install           # deps (@vapi-ai/web, vite, vitest)
npm run dev           # Vite dev server → http://localhost:5173
npm run build         # production build → dist/
npm test              # Vitest — 100 unit tests (utils + classify + resolve), fully offline
npm run replay        # replay fixtures through the classifier (DeepSeek if key set, else heuristic)
npm run diagnose      # pull recent real calls + print transcript, tools, analysis, resolver verdict

# (Re)configure the dashboard assistant — HIGH STAKES: PATCHes the LIVE assistant, real calls cost money.
#   PowerShell: $env:VAPI_PRIVATE_KEY="..."; $env:VAPI_ASSISTANT_ID="..."; node scripts/configure-assistant.mjs
node scripts/configure-assistant.mjs
```

## Environment variables
`VITE_*` are **browser-safe** (public), inlined by Vite at build time, with hardcoded fallbacks in `src/main.js` (so it deploys with zero config; env vars override).

| Var | Scope | What |
|---|---|---|
| `VITE_VAPI_PUBLIC_KEY` | public | Vapi **public** key |
| `VITE_VAPI_ASSISTANT_ID` | public | the dashboard assistant's ID |
| `VAPI_PRIVATE_KEY` | **server-only** | fetch the call in `api/outcome.js`; PATCH the assistant in the scripts. Must be set in **Vercel** env. |
| `DEEPSEEK_API_KEY` | **server-only** | the DeepSeek cross-check + the compare panel. Without it the resolver still works (it's deterministic); only the LLM cross-check is skipped. |

## Outcome model
| Code | Meaning | UI badge |
|---|---|---|
| `P1_SUCCESS` | Confirmed the right person **and** they answered the survey | ✅ Verified & Surveyed |
| `P2_VOICEMAIL` | Voicemail / answering machine | 📬 Voicemail |
| `P3_UNREACHABLE` | No connection / dead air / no caller audio | 📵 No Answer |
| `P4_DECLINED` | Reached them, declined / hostile / DNC (before confirming) | 🚫 Declined |
| `P5_WRONG_PERSON` | Explicit "no" / wrong number / target unavailable | 🙅 Wrong Person |
| `P6_UNCLEAR` | Reached someone but identity never confirmed (evasive/garbled) | 🤔 Couldn't Confirm |
| `P7_HUNGUP_EARLY` | Hung up before confirming identity | 📴 Ended Early |
| `P8_VERIFIED_NO_SURVEY` | Identity confirmed but survey not clearly completed (incl. an unclear/garbled survey answer) | ☑️ Identity Confirmed |

Every completed call resolves to exactly one of these 8. There is **no** "needs review" / abstention state (it was removed — the product requires a definite, determinable outcome on every call).

## File map
- `index.html` — Vite entry. **`data-state` machine** on `#app` (`idle`/`calling`/`result`). Inline scripts shim `window.global`/`window.process` (Daily.co) and the on-page error banner. Holds the collapsible **"Compare classifiers"** debug panel.
- `src/main.js` — all SDK logic: resolve the Vapi constructor (see gotchas); pre-warm the mic; ~20s connect timeout; double-submit guard; capture the live `set_outcome` only as a **degradation fallback**; on `call-end` → `finalizeResult()` shows **"Wrapping up…"** then polls `/api/outcome` and renders the ONE authoritative result (no flip) + the compare panel; volume-reactive orb; `data-state` machine.
- `src/outcomes.js` — **single source of truth for the taxonomy**: `OUTCOME_CODES` (P1–P8), `OUTCOME_SET`, `OUTCOME_CONFIG` (with a clean `badge` label shown instead of the P-code), `isValidOutcome`, `isDisplayable`. Imported by frontend, `api/*`, and the config script so codes never drift.
- `src/utils.js` — DOM-free helpers: `normalizeFirstName()`, `parseArgs`, `describeError`; re-exports the taxonomy. Tested in `src/utils.test.js`.
- `src/style.css` — styles (orb states, 8 outcome accents + `.REVIEW`, the compare panel, no-flip card).
- `api/resolve.js` — **THE AUTHORITATIVE RESOLVER** (pure, unit-tested). Two fact sources: explicit fact tool calls (`extractFacts`), else derived deterministically from the transcript. Maps facts + `endedReason` → exactly one definite P-code (P1–P8). A confirmed caller with a clean sentiment → P1; confirmed with anything else (busy/declined/unclear/garbled) → P8; contradictory confirm+deny → P6. `crossCheck()` is a no-op pass-through (kept for the import surface).
- `api/outcome.js` — Vercel serverless orchestrator. Validates the id (no SSRF), fetches the call, runs `resolve()` (authoritative) + `classify()` cross-check + the compare signals concurrently, returns `{outcome, source, confidence, reason, compare}` (only codes — no PII). `{pending:true}` while the transcript populates.
- `api/classify.js` — the **DeepSeek classifier**, now a **cross-check** (not authoritative). Layers: deterministic terminals → 3-sample ensemble (temp 0) with an identity-gate guard (P1/P8 require a confirmation token, else P6) → keyword heuristic floor. Also `classifyWithFullPrompt()` (the full-agent-prompt pick for the compare panel). Only scans the **user's** transcript turns.
- `scripts/configure-assistant.mjs` — agent config source of truth. PATCHes the assistant: identity-verification-first system prompt (identity gate, persistence loop, real-world catalogue, 8 absolute rules incl. *suspicion-is-never-a-decline* and *never-echo-a-mis-heard-name*), `temperature:0.3`, `maxTokens:200`, `set_outcome` (P1–P8) + `endCall` + the **staged atomic fact tools** (`confirm_identity`, `wrong_person`, `record_survey`, `survey_declined`, `decline_call`, `mark_voicemail`), Cartesia voice, Deepgram nova-3 + **keyterm boosting**, `endCallPhrases`, silence/idle plan, `analysisPlan.structuredDataPlan` (schema-only). gpt-4o model-candidate fallback loop.
- `scripts/diagnose-last-call.mjs` (`npm run diagnose`) — pulls recent calls and prints transcript + tool calls + `analysis.structuredData` + the verdict the pipeline would produce. The main debugging tool.
- `scripts/dump-calls.mjs` / `scripts/replay-classify.mjs` (`npm run replay`) — write real calls to `test/fixtures/calls/*.json` (gitignored) and replay the fixture corpus.
- `test/classify.test.js`, `test/resolve.test.js`, `src/utils.test.js` — 100 offline unit tests (`npm test`). `test/fixtures/synthetic.json` — the asserted classifier replay corpus.
- `vite.config.js` (`global: globalThis`), `vercel.json` (`framework: vite` → `dist/`), `.env.example`.

## Deploy (Vercel)
`vercel.json` pins `framework: vite`. Push to `main` auto-deploys. Set `VAPI_PRIVATE_KEY` + `DEEPSEEK_API_KEY` as **server** env vars in Vercel for the outcome pipeline to work in prod.

## Gotchas
- **`@vapi-ai/web` is CommonJS** (`module.exports = { default: VapiClass }`). A plain default import double-unwraps in the production bundle → `"X.default is not a constructor"`. `src/main.js` imports the namespace and walks to the real constructor. **Don't revert to the default import.**
- **Daily.co (under the SDK) needs Node globals.** `index.html` shims `window.global`/`window.process` and `vite.config.js` defines `global: globalThis`. Without these the call errors at start.
- **`clientMessages` must include `tool-calls`** on the assistant, or the browser never receives tool calls (the live `set_outcome` fallback + compare panel break).
- **The result card is RESOLVED, not the live outcome.** `finalizeResult()` shows "Wrapping up…" then renders ONLY `/api/outcome`'s result. The live `set_outcome` is captured only as a fallback if the server is unreachable. (Earlier the live outcome was shown instantly and visibly *flipped* to the corrected one — that's why we wait for the authoritative result now.)
- **The resolver always returns a definite code (no abstention).** A confirmed caller whose survey reply is unclear/garbled (e.g. "make up something", "not really sure", garbled "Local.") → **P8 "Identity Confirmed"** (identity was verified; the survey just wasn't clearly completed). **P1 still requires a clean sentiment**, so an unintelligible reply never becomes a false "Verified & Surveyed". (A previous version abstained to a "needs review" state here — that was removed; the product requires a determinable outcome on every call.)
- **Resolver fact detection is strict on purpose.** "speaking" inside *"who is this speaking?"* is NOT a confirmation; a mid-turn "no" ("Yeah. No.") is a contradiction, not a yes. See `isConfirmTurn`/`hasNegation` in `api/resolve.js`. `surveyResponse()` keys off the survey question's wording — update it if the survey text changes.
- **Atomic fact tools are STAGED, not live.** They're in `configure-assistant.mjs` and parsed by `extractFacts`, but the live assistant only gets them when the script is run — which needs a **supervised live test** (real calls cost money). The resolver works fine without them via transcript-derivation, so they're an additive upgrade.
- **Never name-match the caller by ear.** STT mangles names; any "yes/speaking/this is me" is a confirmation even if the spoken name differs from `{{name}}`; only an explicit "no"/wrong number → P5. Rule 8 also forbids the agent from **echoing a mis-heard name** back.
- **`set_outcome` must be its OWN silent step BEFORE the spoken closing line.** gpt-4o is unreliable at emitting a tool call *and* spoken content in one completion; the closing line contains an `endCallPhrase` that hangs up immediately. (The resolver's transcript-derivation is the safety net for when the live tool is dropped — confirmed common in real calls.)
- **Two-mode call ending (don't merge them).** Spoken goodbyes end via `endCallPhrases`; the `endCall` **tool** is reserved for silent ends (voicemail/dead-air). Calling `endCall` right after a closing line cuts off the final TTS.
- **Model `temperature` is `0.3`, `maxTokens` is `200`.** Higher temp made gpt-4o improvise and skip tools; the token cap stops monologues (which correlate with dropped tool calls) while leaving room for a reassurance + re-ask.
- **Identity gate.** Never survey or record P1/P8 without an explicit, direct yes. A "yeah" buried in another question is not a yes. Once confirmed, never re-ask identity.
- **Silence** is handled by `messagePlan.idleMessages` (nudge ~twice, then end at `silenceTimeoutSeconds`); a no-audio/silence terminal → P3 deterministically.
- **Audio smoothness:** `voice.chunkPlan.minCharacters` at 40 keeps TTS smooth; get snappiness from `startSpeakingPlan.waitSeconds` (0.2), not by lowering it.
- **Voice is Cartesia `sonic-3.5`.** The active assistant is **`28fe3455…`**; `VITE_VAPI_ASSISTANT_ID` must point at a valid assistant or every call 400s.
- **Mic needs a secure context** (localhost or HTTPS). The public key lets anyone on the page start (paid) calls — restrict allowed origins to your domain for production.
- A real end-to-end test needs a **mic + a human** — the voice call can't be driven headlessly. The *outcome resolver*, however, is fully testable offline (`npm test`, `npm run diagnose`).
