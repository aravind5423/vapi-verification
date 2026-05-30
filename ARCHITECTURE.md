# AI Voice Verification — Architecture & Technical Overview

*A browser-based AI voice agent that verifies a person's identity through a short, natural voice conversation — no phone calls, no database, no downloads.*

---

## 1. Executive Summary

This application lets a visitor confirm their identity by **talking to an AI agent ("Freya") directly in their web browser**. The visitor enters their name, clicks **Start**, allows their microphone, and has a roughly 30-second voice conversation whose **one job is to verify identity** ("am I speaking with *[name]*?"). A short "pulse-check" survey is a secondary nicety. After the call, the page shows a single, clear result.

**What makes the design notable:**

- **No telephony and no database.** The conversation runs over the browser's microphone and speakers using real-time web audio (WebRTC). Nothing about the caller is stored by this application.
- **"Thick agent, thin app."** The AI persona, conversation, and voice all live in a managed cloud service (Vapi), not in our code. Our application is a lightweight web page plus one small server-side function.
- **The result is *derived from facts*, not *guessed*.** Instead of asking an AI to "pick a result code" (which can be confidently wrong), the agent records simple facts as they happen, and a small deterministic program turns those facts into exactly one definite outcome.

**The guiding principle:** every completed call resolves to one **definite, determinable** outcome — there's no "ask a human" step. Accuracy is preserved by mapping each case to its *honest* outcome: if we confirmed who the caller is but their survey answer was unclear, the result is **"Identity Confirmed"** (we did verify them) — never a fabricated "Verified & Surveyed". A clean "Verified & Surveyed" still requires a clear survey answer.

**Business value:** zero-friction identity verification (no app install, no phone number), a very low operational footprint (no servers or databases to maintain), and a result you can actually trust — because the system flags uncertainty instead of hiding it.

---

## 2. System at a Glance

```
┌──────────────────────────────┐        ┌────────────────────────────────────┐
│  OUR APPLICATION              │        │  VAPI CLOUD  (the managed "backend") │
│  (a static web page +         │        │                                      │
│   one server-side function)   │        │  • "Freya" — the AI agent            │
│                               │        │  • the conversation + fact-recording │
│  • the web page (UI)          │ ─ID──▶ │  • text-to-speech (the voice)        │
│  • browser logic / state      │        │  • speech-to-text (hearing)          │
│  • the outcome function:      │ ◀──────│  • the call transcript + facts       │
│    RESOLVES one trusted result│        │                                      │
└──────────────────────────────┘        └────────────────────────────────────┘
            ▲                                            │
            │  microphone + speakers (live web audio)    │
            └────────────────  THE VISITOR  ─────────────┘
```

The two halves are connected by **two identifiers** (a public key and the agent's ID) and the **call record** (the transcript and the facts the agent recorded), which our function reads after the call to decide the result.

---

## 3. The Conversation, End to End

1. **Enter name.** The visitor types their name. We clean it into a clear, speakable first name (handling titles like "Dr.", ALL-CAPS, and international names so the AI pronounces it correctly).

2. **Pre-warm the microphone.** The page requests mic access and releases it before the call, so device setup happens up front — this prevents a common "flaky first call" problem.

3. **Start the call.** The page starts the Freya agent in the cloud, passing the visitor's name so she can greet them ("Hi, is this *[name]*?").

4. **Verify identity (the core).** Freya's job is to get a clear yes or no. Real callers are often suspicious or busy, so she patiently handles their questions — "who is this?", "how did you get my number?", "is this a scam?", "are you an AI?" — answering each in one line and steering back to the identity question. She **never** moves on to the survey, or treats anyone as verified, without a clear, direct "yes."

5. **Record facts as they happen.** Rather than deciding a result at the end, the agent records simple facts the moment they become true — identity confirmed, wrong person, survey answered, declined, voicemail, and so on. These facts are the ground truth the result is built from.

6. **Show one trusted result.** When the call ends, the page briefly shows **"Wrapping up…"**, asks our outcome function for the official result, and displays it **once**. It never shows a quick answer that then changes — the visitor sees a single, stable, plain-language result.

---

## 4. The Result Model

Every completed call resolves to exactly one of these:

| Result | Meaning |
|--------|---------|
| **Verified & Surveyed** | Confirmed the right person *and* they answered the survey |
| **Identity Confirmed** | Confirmed the right person, but the survey wasn't completed |
| **Wrong Person** | Explicitly not them / wrong number / unavailable |
| **Declined** | Reached them, but they refused or were hostile |
| **Couldn't Confirm** | Reached someone, but never got a clear yes or no |
| **Ended Early** | Hung up before confirming identity |
| **Voicemail** | A voicemail or machine picked up |
| **No Answer** | No connection, silence, or dead air |

The visitor only ever sees the plain-language label; an internal code is kept in logs for debugging. The same vocabulary is shared across the whole system so the labels never drift.

---

## 5. How the Result Is Decided (the most important design decision)

The earlier version of this app asked an AI to read the conversation and pick a result. The problem: on a garbled or ambiguous call, the AI would still answer with full confidence — and was sometimes **confidently wrong** (for example, marking someone "Verified & Surveyed" when they never actually answered). For a verification product, that's unacceptable.

The current design fixes this with two ideas:

### 1. Record facts, then derive the result by fixed rules
The agent records simple, individually-checkable facts during the call (identity confirmed? survey answered? wrong person? voicemail?). A small **deterministic program** — not an AI — turns those facts into exactly one definite result. Simple facts are easy to get right; turning facts into a result is just a lookup table. There's no "guessing."

### 2. Map every case to its *honest* outcome — never overstate
Every call still resolves to a definite result, but the rules are conservative about what they claim. The strongest result, **"Verified & Surveyed,"** requires *both* a confirmed identity *and* a clear survey answer. If identity was confirmed but the survey answer was unclear or garbled, the result is the more modest **"Identity Confirmed"** — true and useful, without overstating. If the caller both confirmed and denied, it's **"Couldn't Confirm."** So the system is definite *and* accurate: it never invents a "success" out of an unintelligible answer.

(A separate AI still reviews each transcript, but only as a side-by-side **"compare" view** for debugging and tuning — it never decides the result.)

```
Call ends
   │
   ├─ read the facts the agent recorded (and, if needed, infer them from the transcript)
   │
   ├─ confirmed + clear survey answer ─────────▶ Verified & Surveyed
   ├─ confirmed + unclear/garbled answer ──────▶ Identity Confirmed (honest, not overstated)
   ├─ explicit "no" / wrong number ────────────▶ Wrong Person
   └─ never got a clear yes/no ────────────────▶ Couldn't Confirm
```

**The takeaway for non-engineers:** every call gets a definite, determinable result built from verifiable facts — and the rules are written so the system is accurate by *under*-claiming (e.g. "Identity Confirmed") rather than inventing a confident success.

---

## 6. Component Breakdown

### Our application (this codebase)

| Component | Responsibility |
|-----------|----------------|
| **The web page** | The name form, the live "call" view with the pulsing voice orb, and the final result card. One state switch drives three views: *idle → calling → result*. |
| **Browser logic** | Starts the call, manages microphone permissions and timeouts, and — on call end — shows "Wrapping up…" then displays the one official result. |
| **The outcome function** (server-side) | The brain of the result: reads the call's facts and transcript, derives one definite result by fixed rules, and returns only a result label — never any personal data. |
| **The resolver** | The small, fully-tested deterministic program inside the outcome function that maps facts → exactly one definite result. |
| **Configuration script** | The "source of truth in code" for the agent. Running it pushes the agent's persona, conversation, tools, and voice to the cloud service. |
| **Diagnostics & test tools** | Pull recent real calls and show exactly what the system would decide and why; plus an automated test suite (100 tests) that proves the result logic offline, with no live calls. |

### The Vapi cloud service (the managed backend)

| Component | Responsibility |
|-----------|----------------|
| **The AI agent ("Freya")** | Runs the identity-verification conversation and records facts. |
| **Voice & hearing** | High-quality text-to-speech and speech-to-text (with extra "boosting" of the key words — the name, yes/no — to reduce mishears). |
| **The call record** | The transcript and recorded facts our outcome function reads after the call. |

> **Important:** Freya's behavior is configured in the cloud service, not hard-coded in the web page. We change how she talks by updating that configuration.

---

## 7. Security & Privacy

- **No personal data is stored by this application.** There is no database; the conversation isn't persisted on our side.
- **Two-tier key model.** A *public* key (safe to expose) lets the browser start a call. *Private* keys (used only server-side) are never sent to the browser or committed to source control.
- **The outcome function is locked down.** It strictly validates the call identifier, times out quickly, and returns **only** a result label — never a transcript or personal information.
- **Production hardening.** Because the public key allows starting (billable) calls, we restrict which website domains may use it.

---

## 8. Hosting & Operations

- **Hosting:** Vercel — a static web page plus one serverless function.
- **Updates:** Pushing to the main branch auto-deploys.
- **Low maintenance:** No servers, databases, or queues of our own; the AI, voice, and scaling are handled by the managed Vapi service.
- **Requirements:** The microphone needs a secure (HTTPS) connection, which the host provides automatically.

---

## 9. Known Constraints (honest limitations)

- **100% is not achievable — and we don't claim it.** Speech-to-text and AI voice are probabilistic. The system guarantees a *definite* result on every call; it manages accuracy by under-claiming (e.g. "Identity Confirmed" rather than a fabricated "Verified & Surveyed") rather than overstating.
- **Speech-to-text can still mishear names and answers.** We boost the key words and never let the agent repeat a mis-heard name back, but garbling is a real-world limit — a garbled survey answer lands as "Identity Confirmed," not a false "Verified & Surveyed".
- **The new fact-recording on the agent is staged but not yet live.** The result logic already works by inferring the same facts from the transcript; turning on the agent's explicit fact-recording needs one supervised live test (real calls cost money).
- **A true end-to-end test needs a human with a microphone.** The result logic itself, however, is fully tested automatically.

---

## 10. One-Paragraph Summary

A lightweight web page starts a cloud AI agent whose job is to verify a caller's identity. The agent records simple facts during the call, and a small deterministic program turns those facts into exactly one definite, determinable result. The rules are conservative — the top result requires both a confirmed identity and a clear survey answer, so an unclear call lands as the honest "Identity Confirmed" rather than a fabricated success. The system stores no personal data, runs with no servers or databases of our own, and is built around one principle: every call gets a definite result, and accuracy is protected by under-claiming rather than overstating.

---

*Prepared from a direct review of the codebase. For technical detail, see `CLAUDE.md`, `api/resolve.js` (the result logic), and `scripts/configure-assistant.mjs` (the agent) in the repository.*
