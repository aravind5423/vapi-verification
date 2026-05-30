// ─────────────────────────────────────────────────────────────────────────────
// The authoritative outcome classifier — the layer that makes the result robust.
//
// WHY THIS EXISTS: the live in-call `set_outcome` tool is probabilistic (the model
// drops it ~25% of the time) and Vapi's own structuredData analysis silently fails.
// But the call TRANSCRIPT + endedReason are ALWAYS available after a call. So we
// classify them ourselves, with three stacked layers, and ALWAYS return a valid
// code for a completed call:
//
//   Step 0  Deterministic pre-filters (endedReason / transcript shape).
//           Telephony facts the LLM can't see from text → these OVERRIDE the LLM.
//   Step 1  DeepSeek ensemble — 3 parallel samples, majority vote. The accuracy engine.
//   Step 2  Heuristic floor — keyword rules. Guarantees a valid code if the LLM is
//           unavailable / times out / has no API key. NEVER returns null.
//   Step 3  Reconcile with the live `set_outcome` hint (tiebreaker only).
//
// Pure and side-effect-free except the LLM fetch, so it's unit-testable offline
// (heuristic mode runs with no network and no API key).
// ─────────────────────────────────────────────────────────────────────────────

import { OUTCOME_CODES, isValidOutcome } from "../src/outcomes.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-chat";
const SAMPLES = 3;          // self-consistency votes
const LLM_TIMEOUT_MS = 8000; // per-sample upstream timeout

// ─── Transcript helpers ──────────────────────────────────────────────────────
// Vapi transcripts are newline-separated "AI: …" / "User: …" lines. We only ever
// match keywords against the USER's turns — matching the assistant's words would
// produce false positives (Freya says "happy, neutral, upset" in every survey).

export function userTurns(transcript) {
  if (typeof transcript !== "string" || !transcript.trim()) return [];
  return transcript
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^user\s*:/i.test(l))
    .map((l) => l.replace(/^user\s*:/i, "").trim().toLowerCase())
    .filter(Boolean);
}

const RX = {
  // An affirmative answer to "is this {name}?" — a "yes" counts even if a spoken
  // name differs (STT garbles names; mirror the Scenario A rule).
  confirm: /\b(yes|yeah|yep|yup|speaking|this is (he|she|me|him|her)|that'?s me|that'?s right|that'?s correct|you'?re speaking|you are speaking)\b/,
  // Explicit "wrong person / not me / wrong number".
  denial: /\bwrong number\b|\bthis isn'?t\b|\bnot here\b|\bno one (named|by)\b|you have the wrong|\bhe'?s not (here|in)\b|\bshe'?s not (here|in)\b|\bthey'?re not (here|in)\b|\bnot available\b/,
  // A standalone negative ("no" / "nope" / "nah") answering the identity question —
  // read literally as "you've got the wrong person". Excludes "no comment/thanks/…".
  bareNo: /^(no|nope|nah)\b/,
  bareNoExclude: /\bno (comment|thanks|thank you|problem|worries)\b/,
  // Reached the person but they refuse / are hostile / not interested.
  decline: /\bnot interested\b|\btake me off\b|\bstop calling\b|\bdon'?t call\b|\bremove me\b|\bleave me alone\b|\bno thanks\b|\bnot now\b|\bgo away\b|\bfuck\b|\bpiss off\b|\bbug off\b/,
  // A real answer to the sentiment ("pulse check") question.
  sentiment: /\b(happy|neutral|upset|angry|no comment|don'?t care|indifferent|frustrated|pleased|annoyed|mad)\b/,
  // Voicemail-ish self-evidence in the transcript.
  voicemail: /\bleave a message\b|\bafter the (tone|beep)\b|\bvoicemail\b|\bnot available to take your call\b|\brecord your message\b/,
};

export function hasConfirmation(turns) {
  return turns.some((t) => RX.confirm.test(t));
}

// ─── Step 0 + Step 2: deterministic / heuristic (no LLM, always available) ────

// endedReason + transcript-shape rules that the LLM cannot judge from text alone.
// Returns a terminal verdict (use as-is, skip the LLM) or null (let the LLM run).
export function heuristicEndReason(endedReason, transcript) {
  const reason = String(endedReason || "").toLowerCase();
  const turns = userTurns(transcript);

  if (/voicemail/.test(reason) || RX.voicemail.test(String(transcript || "").toLowerCase())) {
    return { code: "P2_VOICEMAIL", confidence: 0.98, source: "deterministic" };
  }
  // Silence / never spoke / no mic / no answer → genuinely unreachable.
  if (
    /silence|no-answer|did-not-give-microphone|customer-did-not-answer/.test(reason) ||
    turns.length === 0
  ) {
    return { code: "P3_UNREACHABLE", confidence: 0.95, source: "deterministic" };
  }
  return null;
}

// The floor: pure keyword classification that ALWAYS returns a valid code.
// Used when the LLM is unavailable, errors, or ties.
export function heuristicFromText(transcript, endedReason) {
  const reason = String(endedReason || "").toLowerCase();
  const turns = userTurns(transcript);
  const text = turns.join("  ");

  // Telephony terminals first (mirrors heuristicEndReason for standalone use).
  const term = heuristicEndReason(endedReason, transcript);
  if (term) return term.code;

  const confirmed = hasConfirmation(turns);

  if (confirmed) {
    // A confirmed person can't be "wrong person"; they either decline, answer, or
    // never complete the survey.
    if (RX.decline.test(text)) return "P4_DECLINED";
    if (RX.sentiment.test(text)) return "P1_SUCCESS";
    return "P8_VERIFIED_NO_SURVEY";
  }

  const bareNo = turns.some((t) => RX.bareNo.test(t) && !RX.bareNoExclude.test(t));
  if (RX.denial.test(text) || bareNo) return "P5_WRONG_PERSON";
  if (RX.decline.test(text)) return "P4_DECLINED";
  // Reached someone, they engaged, but hung up before confirming who they are.
  if (/customer-ended-call/.test(reason)) return "P7_HUNGUP_EARLY";
  return "P6_UNCLEAR";
}

// ─── Step 1: DeepSeek ensemble ────────────────────────────────────────────────

function definitionsBlock() {
  return [
    "P1_SUCCESS = the right person confirmed they are the target (any 'yes'/'speaking'/'this is me' counts, EVEN IF a spoken name sounds different — speech-to-text garbles names) AND they engaged with the one-question pulse-check survey (gave any sentiment answer, even vague/sarcastic).",
    "P2_VOICEMAIL = a voicemail or answering machine picked up.",
    "P3_UNREACHABLE = no connection, dead air, only silence, or they never actually spoke.",
    "P4_DECLINED = reached the person (or very likely them) but they declined, weren't interested, were hostile, or asked not to be called.",
    "P5_WRONG_PERSON = reached someone who is NOT the target — explicit 'no this isn't them', wrong number, or the target is unavailable / someone else answered.",
    "P6_UNCLEAR = reached someone but the outcome genuinely can't be determined (garbled, language barrier, ambiguous).",
    "P7_HUNGUP_EARLY = the customer ended the call before ever confirming their identity (they spoke, but hung up during the who-are-you / are-you-X stage).",
    "P8_VERIFIED_NO_SURVEY = the right person CONFIRMED their identity, but did NOT complete the survey (they were busy, went quiet, or brushed off the question after confirming). Identity verified, survey incomplete. This is NOT P1.",
  ].join("\n");
}

function systemPrompt() {
  return (
    "You are an expert call-outcome classifier for a short identity-verification + " +
    "one-question survey call. An agent named Freya calls a person, confirms she's " +
    "speaking to the target, then asks a single pulse-check sentiment question.\n\n" +
    "Choose EXACTLY ONE outcome code from this list, based ONLY on what actually " +
    "happened in the transcript:\n\n" +
    definitionsBlock() +
    "\n\nKey rules:\n" +
    "- A 'yes'/'speaking'/'this is me'/'yeah' answering \"is this <name>?\" is a CONFIRMATION " +
    "even if the name they say sounds different from the target — do NOT treat a garbled name as a wrong person.\n" +
    "- P1 and P8 BOTH REQUIRE an EXPLICIT identity confirmation. If the person merely engaged, " +
    "asked questions ('who is this?'), or said they were busy WITHOUT ever explicitly confirming they are the " +
    "target, it is NOT P1 and NOT P8 — use P6_UNCLEAR, or P7_HUNGUP_EARLY if they ended during the identity stage.\n" +
    "- Only an explicit denial ('no, this isn't', 'wrong number', 'not here') is P5.\n" +
    "- Confirmed identity but no real survey answer (busy/quiet/brush-off) = P8, NOT P1.\n" +
    "- Suspecting a scam but then continuing is NOT a decline.\n" +
    `- Valid codes: ${OUTCOME_CODES.join(", ")}.\n\n` +
    'Respond with STRICT JSON only: {"code":"<ONE_CODE>","reason":"<short justification>"}'
  );
}

function userPrompt({ transcript, endedReason, durationSec, liveOutcome }) {
  const hint = isValidOutcome(liveOutcome)
    ? `\n\nThe in-call model guessed "${liveOutcome}" — treat this as a weak hint only; it is frequently wrong (it tends to mark confirmed-but-busy people as P1_SUCCESS). Decide for yourself from the transcript.`
    : "";
  return (
    `endedReason: ${endedReason || "unknown"}\n` +
    `durationSeconds: ${durationSec ?? "unknown"}${hint}\n\n` +
    `TRANSCRIPT:\n${transcript || "(empty)"}`
  );
}

async function callDeepSeekOnce({ key, transcript, endedReason, durationSec, liveOutcome }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
  try {
    const resp = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        // temperature 0 = near-deterministic: the 3 samples almost always agree, so
        // the majority vote reproduces across runs (no Call-#1-style P6↔P8 flip-flop).
        // A residual non-majority still returns null → the deterministic heuristic floor.
        temperature: 0.0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt() },
          { role: "user", content: userPrompt({ transcript, endedReason, durationSec, liveOutcome }) },
        ],
      }),
    });
    if (!resp.ok) throw new Error(`deepseek ${resp.status}`);
    const data = await resp.json();
    const content = data?.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    const code = parsed?.code;
    return isValidOutcome(code) ? code : null;
  } finally {
    clearTimeout(t);
  }
}

// Run SAMPLES classifications in parallel and majority-vote. Returns
// { code, confidence, votes } on a clear winner, or null on all-failed / hard tie.
export async function classifyWithLLM(input) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) return null; // no key → caller falls back to the heuristic floor

  const results = await Promise.allSettled(
    Array.from({ length: SAMPLES }, () => callDeepSeekOnce({ key, ...input })),
  );
  const codes = results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);
  if (codes.length === 0) return null;

  const tally = new Map();
  for (const c of codes) tally.set(c, (tally.get(c) || 0) + 1);
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [topCode, topVotes] = ranked[0];

  // Hard tie (e.g. 1-1-1, or 1-1 with one failure): no clear signal → let the
  // caller reconcile with the live hint / heuristic instead of guessing.
  const tie = ranked.length > 1 && ranked[1][1] === topVotes;
  if (tie) return null;

  return { code: topCode, confidence: topVotes / codes.length, votes: codes.length };
}

// ─── Orchestration ────────────────────────────────────────────────────────────

// classify(): the single entry point. Always resolves to { code, confidence,
// source } with a valid code for any completed call.
export async function classify({ transcript, endedReason, durationSec, liveOutcome, messages } = {}) {
  // Step 0 — deterministic telephony terminals win over everything.
  const term = heuristicEndReason(endedReason, transcript);
  if (term) return term;

  // Step 1 — LLM ensemble (the source of truth for "reached a human" codes).
  let llm = null;
  try {
    llm = await classifyWithLLM({ transcript, endedReason, durationSec, liveOutcome });
  } catch {
    llm = null; // any unexpected failure → fall through to the floor
  }
  if (llm) {
    // IDENTITY-GATE INVARIANT (deterministic guard): P1 and P8 both mean "identity
    // verified". That is impossible without an explicit confirmation somewhere in the
    // caller's turns. If the model claims a verified outcome with no confirmation in
    // the transcript, it's hallucinating verification (the same mistake the live agent
    // makes on never-confirmed "I'm busy / call me later" callers) — downgrade to P6.
    const verified = llm.code === "P1_SUCCESS" || llm.code === "P8_VERIFIED_NO_SURVEY";
    if (verified && !hasConfirmation(userTurns(transcript))) {
      return { code: "P6_UNCLEAR", confidence: llm.confidence, source: "ensemble-guard" };
    }
    return { ...llm, source: "ensemble" };
  }

  // Step 3 (reconcile, LLM unavailable / tied) — fall to the deterministic heuristic
  // floor, period. The live `set_outcome` is the unreliable layer we're backstopping
  // (wrong ~half the time — it marks confirmed-but-busy as P1 and leaks a false P8 on
  // never-confirmed callers), so it is NEVER a tiebreaker here. It stays ONLY an input
  // to the LLM prompt (a hint the model is told to distrust). The floor always returns
  // a valid code, so the same transcript always classifies the same way — no run-to-run
  // flip-flop (e.g. a never-confirmed evasive caller is deterministically P6_UNCLEAR,
  // never the agent's wrong P8).
  const floor = heuristicFromText(transcript, endedReason);
  return { code: floor, confidence: 0.55, source: "heuristic" };
}
