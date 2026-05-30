# AI Voice Verification — Architecture & Technical Overview

*A browser-based AI voice agent that verifies a person's identity through a short, natural voice conversation — no phone calls, no database, no downloads.*

---

## 1. Executive Summary

This application lets a visitor confirm their identity by **talking to an AI agent ("Freya") directly in their web browser**. The visitor enters their name, clicks **Start**, allows their microphone, and has a roughly 30-second voice conversation. The AI runs a short "pulse-check" survey, determines an outcome (one of six result codes), and the page displays that result live.

**What makes the design notable:**

- **No telephony and no database.** The conversation runs over the browser's microphone and speakers using real-time web audio (WebRTC). Nothing about the caller is stored by this application.
- **"Thick agent, thin app."** Almost all of the intelligence — the AI persona, the conversation rules, the voice, and the result logic — lives in a managed cloud service (Vapi), **not** in our code. Our application is a lightweight web page plus one small helper function.
- **A three-layer safety net** guarantees that we almost always capture a result, even when the AI occasionally misbehaves — including a **second, independent AI** that re-derives the result from the conversation transcript after the call ends.

**Business value:** identity verification with zero friction (no app install, no phone number to dial), low operational footprint (no servers or databases to maintain), and a robust result-capture mechanism that does not depend on any single component working perfectly.

---

## 2. System at a Glance

```
┌──────────────────────────────┐        ┌────────────────────────────────────┐
│  OUR APPLICATION              │        │  VAPI CLOUD  (the managed "backend") │
│  (a static web page +         │        │                                      │
│   one helper function)        │        │  • "Freya" — the AI agent            │
│                               │        │  • the conversation script           │
│  • the web page (UI)          │        │  • the AI's "record result" tool     │
│  • browser logic / state      │ ─ID──▶ │  • text-to-speech (the voice)        │
│  • one serverless function    │        │  • speech-to-text (hearing)          │
│    (result fallback)          │ ◀─result│  • a post-call result classifier     │
└──────────────────────────────┘        └────────────────────────────────────┘
            ▲                                            │
            │  microphone + speakers (live web audio)    │
            └────────────────  THE VISITOR  ─────────────┘
```

The two halves are connected by just **two identifiers and one "result" signal**:

- The web page starts the cloud agent **by ID** using a public key (safe to expose in a browser).
- When the agent finishes, it reports the result back to the page through a "record result" tool call.

---

## 3. The Conversation, End to End

What actually happens during a single verification, from the visitor's first click to the on-screen result:

1. **Enter name.** The visitor types their name. We clean it into a clear, speakable first name (handling titles like "Dr.", ALL-CAPS, and international/accented names so the AI pronounces it correctly).

2. **Pre-warm the microphone.** Before the call starts, the page requests microphone access and immediately releases it. This makes the permission prompt and device setup happen *up front*, which prevents a common "flaky first call" problem.

3. **Start the call.** The page asks the Vapi cloud to start the Freya agent, passing the visitor's name so the AI can greet them personally ("Hi, is this *[name]*?").

4. **Live conversation.** Freya runs a short survey following a fixed script. She handles many situations — the right person answering, the wrong person, a voicemail, someone who's busy, someone suspicious of a scam, someone speaking another language, and so on. A glowing on-screen orb pulses in time with her voice so the visitor can see the call is live.

5. **Record the result.** When the conversation reaches a conclusion, Freya **silently records an outcome code** (see §4), then says a natural goodbye. The page captures that result.

6. **Show the result.** The page reveals the result card **exactly when Freya finishes speaking** — never before — so the experience feels natural rather than abruptly cutting her off.

7. **Done.** The visitor sees a clear, color-coded result and can start a new verification.

---

## 4. The Result Model

Every call produces exactly one of six outcome codes:

| Code | Meaning | How it appears on screen |
|------|---------|--------------------------|
| **P1 · Confirmed** | Confirmed the right person | ✅ Success (green) |
| **P2 · Voicemail** | A voicemail or answering machine picked up | 📬 Voicemail |
| **P3 · No Answer** | Couldn't connect / dead air / silence | 📵 Error |
| **P4 · Not Interested** | Reached the person, but they declined or were hostile | 🚫 Warning |
| **P5 · Wrong Person** | Reached someone, but not the right person | 🙅 Neutral |
| **P6 · Unclear** | Reached someone, but the outcome genuinely couldn't be determined | 🤔 Muted |

These same six codes are used consistently in four places: the AI's recording tool, the on-screen display, the post-call classifier, and the server-side validation — so there is a single, shared vocabulary across the whole system.

---

## 5. The Safety Net (the most important design decision)

A live, in-conversation result signal can never be 100% reliable — the AI occasionally forgets to record the result, or the visitor hangs up early. Rather than accept occasional lost results, the system uses **three layers of defense**, each one a backup for the one before it:

### Layer 1 — Live result during the call (the normal path)

The AI is instructed to record the result **as a silent step *before* it says goodbye**. This ordering matters: the goodbye phrase automatically ends the call the instant it's spoken, so if the result weren't recorded first, it would be lost. The AI's "creativity" setting is deliberately turned down low to make it reliably follow this order instead of improvising. In the normal case, the page receives this live signal and shows the result immediately.

### Layer 2 — A second, independent AI classifier (after the call)

After **every** call, the cloud service runs a **separate AI pass** that reads the full conversation transcript and independently determines the correct outcome code. This is *not* the agent trying again — it's a different model acting as an impartial reviewer of what actually happened. Its conclusion is stored with the call record.

> **This is the "extra AI layer."** It exists purely as a backstop: if the live signal in Layer 1 is missed for any reason, this transcript-based classification is still available.

### Layer 3 — The bridge that delivers Layer 2 to the page

Layer 2's result lives in the cloud and doesn't automatically reach the visitor's screen. So if a call ends **without** a live result, the page calls a small **serverless helper function** of ours. That function securely looks up the official result for that call (using a private key that never touches the browser) and returns just the outcome code. The page briefly shows "Finalizing…", then displays the recovered result.

If even that fails (e.g., pure silence with no transcript to classify), the page falls back gracefully to a neutral "Call Ended" message rather than showing an error.

```
Call ends
   │
   ├─ Live result captured?  ── yes ──▶  show it immediately
   │
   └─ no ──▶  ask our helper function for the official result
                 │
                 ├─ found (live signal or transcript classifier) ──▶ show it
                 │
                 └─ genuinely nothing ──▶ neutral "Call Ended" message
```

**The takeaway for non-engineers:** the result is protected by three independent mechanisms, including a second AI that reviews the transcript. No single failure causes a lost result.

---

## 6. Component Breakdown

### Our application (this codebase)

| Component | Responsibility |
|-----------|----------------|
| **The web page** | The visual interface: the name form, the live "call" view with the pulsing voice orb, and the final result card. A single state switch drives three views: *idle → calling → result*. |
| **Browser logic** | Starts the call, listens for live events from the AI (speaking, volume, result, call-end), manages microphone permissions, enforces timeouts, and controls exactly when the result appears. |
| **Shared helpers** | Small, independently tested utilities — most notably the name-cleaning logic that ensures the AI pronounces names correctly. |
| **The result-fallback function** | The single piece of server-side code: securely looks up a call's official result when the live signal was missed. Returns only a result code — never any personal data. |
| **Configuration script** | The "source of truth in code" for the AI agent. Running it pushes the entire agent setup — persona, conversation script, tools, voice, and the post-call classifier — to the cloud service. |
| **Diagnostics script** | A debugging tool that pulls recent calls and prints what happened (transcript, result, end reason) — used to verify the agent is behaving correctly. |

### The Vapi cloud service (the managed backend)

| Component | Responsibility |
|-----------|----------------|
| **The AI agent ("Freya")** | Runs the conversation following the configured script. |
| **The "record result" tool** | How the AI reports its conclusion back to the page. |
| **Voice & hearing** | High-quality text-to-speech (the voice the visitor hears) and speech-to-text (so the AI understands replies). |
| **The post-call classifier** | The second AI that reviews each transcript (Layer 2 of the safety net). |

> **Important:** The AI's behavior is configured in the cloud service, not hard-coded in the web page. To change how Freya talks or behaves, we update the configuration — the web page itself doesn't contain the conversation logic.

---

## 7. Security & Privacy

- **No personal data is stored by this application.** There is no database. The conversation happens live and is not persisted on our side.
- **Two-tier key model.** A *public* key (safe to expose) lets the browser start a call. A *private* key (used only by our server-side helper function and our internal scripts) is **never** sent to the browser and never committed to source control.
- **The result-lookup function is locked down.** It strictly validates the call identifier (preventing misuse), times out quickly, and returns **only** a result code — never a transcript or any personal information.
- **Production hardening note.** Because the public key allows starting (billable) calls, we restrict which website domains are allowed to use it in the production configuration.

---

## 8. Hosting & Operations

- **Hosting:** Deployed on Vercel as a static web page plus one serverless function.
- **Updates:** Pushing to the main branch automatically deploys the latest version.
- **Low maintenance:** No servers, databases, or queues to operate. The heavy lifting (AI, voice, scaling) is handled by the managed Vapi service.
- **Requirements:** The microphone only works over a secure (HTTPS) connection, which the hosting platform provides automatically.

---

## 9. Known Constraints (honest limitations)

- **AI voice agents are probabilistic.** The AI occasionally deviates from its script — which is precisely why the three-layer safety net exists.
- **Pure silence produces no transcript.** If a caller says nothing at all, there is nothing for either the live tool or the transcript classifier to work with, so the call ends with a neutral "Call Ended" result. This is expected behavior, not a bug.
- **Cannot be fully tested without a human.** A real end-to-end test requires a person with a microphone — the voice conversation can't be driven by an automated script.
- **The live result is best-effort.** It's not guaranteed on every single call, which is the entire reason the post-call classifier and fallback function exist.

---

## 10. One-Paragraph Summary (for a quick read)

A lightweight web page starts a fully-configured AI voice agent in the cloud, the visitor and the agent have a short spoken conversation in the browser, and the agent reports a result that the page shows live. Because a live signal can never be perfectly reliable, the result is protected by three layers — the live report, a second AI that independently classifies the conversation transcript after the call, and a small secure function that delivers that backup result to the page. The system stores no personal data, requires no servers or databases of our own, and degrades gracefully when something goes wrong.

---

*Prepared from a direct review of the codebase. For deeper technical detail (event handling, timing logic, or the AI's full conversation script), see `CLAUDE.md` and `scripts/configure-assistant.mjs` in the repository.*
