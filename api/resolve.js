// ─────────────────────────────────────────────────────────────────────────────
// The DETERMINISTIC OUTCOME RESOLVER — the authoritative outcome path.
//
// Philosophy: don't GUESS a holistic P-code after the call. Record/derive a few
// ATOMIC FACTS, then map facts → exactly ONE definite P-code by fixed rules. Every
// completed call resolves to one of P1–P8 — there is no abstention / "needs review"
// state. Each rule is the honest determinable outcome (e.g. a confirmed caller whose
// survey answer is unclear is P8 "Identity Confirmed", never a guessed P1).
//
// Two fact sources, in order of trust:
//   1. EXPLICIT fact tool calls the agent emits during the call (confirm_identity,
//      wrong_person, record_survey, survey_declined, decline_call, mark_voicemail).
//      Ground truth — once those tools are live on the assistant.
//   2. DERIVED from the transcript with deterministic heuristics (works TODAY, before
//      any agent change — validated against the 30 real calls).
// Explicit facts always win over derived ones.
//
// The LLM classifiers (DeepSeek/Vapi) are NOT consulted here — the resolver is the sole
// decider. They remain only as the side-by-side compare panel in api/outcome.js.
// ─────────────────────────────────────────────────────────────────────────────

import { userTurns, heuristicEndReason } from "./classify.js";

const RX = {
  // explicit "wrong person / not me / wrong number"
  denial: /\bwrong number\b|\bthis isn'?t\b|\bnot here\b|\bno one (named|by)\b|you have the wrong|\bnot available\b|\bdoesn'?t live here\b/,
  bareNo: /^(no|nope|nah)\b/,
  bareNoExclude: /\bno (comment|thanks|thank you|problem|worries)\b/,
  // an explicit refusal of the CALL (before confirming) — hostile / DNC / not interested
  decline: /\bnot interested\b|\btake me off\b|\bstop calling\b|\bdo ?n'?t call\b|\bremove me\b|\bleave me alone\b|\bno thanks\b|\bdnc\b|\bunsubscribe\b|\bharass|\bi'?ll sue\b|\bgo away\b|\bpiss off\b|\bfuck\b/,
  // a real answer to the pulse-check sentiment question
  sentiment: /\b(happy|neutral|upset|angry|no comment|frustrated|pleased|annoyed|mad|indifferent|content|worried|concerned)\b/,
  // confirmed person deferring/refusing the SURVEY (identity is already verified)
  surveyDecline: /\bbusy\b|\bdriving\b|\bcan'?t talk\b|\blater\b|\bnot a good time\b|\bcan'?t answer\b|\bwon'?t answer\b|\bdon'?t (wanna|want to) answer\b|\bno time\b|\bgotta go\b|\bin a meeting\b|\bnot interested\b|\bno comment about\b/,
};

// A CLEAN confirmation of identity — stricter than a bare keyword match. Critically,
// "speaking" inside a QUESTION ("who is this speaking?") is NOT a confirmation, and a
// turn that also contains a standalone "no" is a contradiction, not a yes.
const CONFIRM = /\b(yes|yeah|yep|yup)\b|\b(this is (me|him|her)|that'?s me|it'?s me|you are speaking|you'?re speaking)\b/;
function isConfirmTurn(t) {
  if (/\bwho\b[^?]*\bspeaking\b/.test(t)) return false; // "who is this speaking?"
  if (hasNegation(t)) return false;                      // "yeah. no." is not a clean yes
  return CONFIRM.test(t) || /^(speaking|yes speaking|yep speaking)\b/.test(t.trim());
}
// A standalone negative anywhere in the turn (start or after punctuation), excluding
// "no comment / no thanks / no problem / no worries".
function hasNegation(t) {
  if (/\bno (comment|thanks|thank you|problem|worries)\b/.test(t)) {
    // strip the excluded phrases, then look for a remaining standalone no
    t = t.replace(/\bno (comment|thanks|thank you|problem|worries)\b/g, " ");
  }
  return /(^|[.!?,]\s*)(no|nope|nah)\b/.test(t);
}

// An idle/presence-check nudge the agent uses when the line goes quiet. A bare "yeah"
// answering one of these means "I'm here", NOT "I'm <name>".
const NUDGE = /\byou (still )?there\b|\bstill with me\b|\b(still )?hear me\b|\bdid i lose you\b|\byou cut out\b|\bstill there\b|^hello\b\??$/i;
// The agent's identity question.
const IDENTITY_ASK = /\bis this\b|\bspeaking with\b|\bam i speaking\b|\bjust to confirm\b/i;
// A BARE affirmation — only yes/yeah/yep/yup words (+ fillers), nothing substantive.
function isBareAffirm(t) {
  const words = String(t).replace(/[.,!?]/g, " ").split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => /^(yes|yeah|yep|yup|uh|um|oh)$/i.test(w));
}

function mk(code, confidence, source, reason) {
  return { code, confidence, source, reason };
}

// Find the caller's reply to the survey question: locate the AI turn that asks the
// pulse-check, return the next User turn (lowercased), or null if none.
export function surveyResponse(transcript) {
  const lines = String(transcript || "").split(/\r?\n/).map((l) => l.trim());
  let askedAt = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^ai\s*:/i.test(lines[i]) && /(happy|neutral|upset|no comment)|pulse check|tariff/i.test(lines[i])) askedAt = i;
  }
  if (askedAt < 0) return null;
  for (let j = askedAt + 1; j < lines.length; j++) {
    if (/^user\s*:/i.test(lines[j])) return lines[j].replace(/^user\s*:/i, "").trim().toLowerCase();
  }
  return null;
}

// Derive identity from the IDENTITY PHASE (turns before the survey question), using the
// agent's PRECEDING line as context. Two key rules:
//   • A "no" in the survey ANSWER (after the survey question) is never an identity denial.
//   • A BARE "yeah" answering an idle nudge ("you there?") means "I'm here", NOT "I'm
//     <name>", so it does NOT confirm identity. A bare yes only confirms when it answers
//     the identity question; a substantive confirm ("it's me", "speaking") always counts.
// Returns "confirmed" | "denied" | "contradiction" | undefined.
export function deriveIdentity(transcript) {
  const lines = String(transcript || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let surveyAt = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (/^ai\s*:/i.test(lines[i]) && /(happy|neutral|upset|no comment)|pulse check|tariff/i.test(lines[i])) surveyAt = i;
  }
  let confirmed = false, denied = false, prevAI = "";
  for (let i = 0; i < surveyAt; i++) {
    const line = lines[i];
    if (/^ai\s*:/i.test(line)) { prevAI = line.replace(/^ai\s*:/i, "").trim().toLowerCase(); continue; }
    if (!/^user\s*:/i.test(line)) continue;
    const u = line.replace(/^user\s*:/i, "").trim().toLowerCase();
    if (RX.denial.test(u) || hasNegation(u)) { denied = true; continue; }
    if (!isConfirmTurn(u)) continue;
    if (isBareAffirm(u)) {
      // bare "yeah" — a confirmation ONLY if the agent's last line asked about identity
      // (an idle "you there?" nudge with no identity ask does not count).
      if (!(NUDGE.test(prevAI) && !IDENTITY_ASK.test(prevAI))) confirmed = true;
    } else {
      confirmed = true; // substantive confirmation
    }
  }
  if (confirmed && denied) return "contradiction";
  if (denied) return "denied";
  if (confirmed) return "confirmed";
  return undefined;
}

// Parse the agent's EXPLICIT fact tool calls out of the call's message log.
// Returns a partial facts object; empty today (the tools aren't live yet) — the
// resolver then derives facts from the transcript instead.
export function extractFacts(messages) {
  const facts = {};
  if (!Array.isArray(messages)) return facts;
  const parse = (raw) => { try { return typeof raw === "string" ? JSON.parse(raw) : (raw || {}); } catch { return {}; } };
  for (const m of messages) {
    for (const t of m?.toolCalls || m?.tool_calls || []) {
      const name = t?.function?.name ?? t?.name;
      const args = parse(t?.function?.arguments ?? t?.arguments);
      switch (name) {
        case "confirm_identity": facts.identity = "confirmed"; break;
        case "wrong_person": facts.identity = "denied"; facts.wrongPerson = true; break;
        case "record_survey": facts.survey = { answered: true, sentiment: args?.sentiment }; break;
        case "survey_declined": facts.surveyDeclined = true; break;
        case "decline_call": facts.declined = true; break;
        case "mark_voicemail": facts.voicemail = true; break;
        default: break;
      }
    }
  }
  return facts;
}

// The resolver. facts = explicit tool facts (may be empty); the rest is derived.
export function resolve({ facts = {}, transcript = "", endedReason = "" } = {}) {
  const turns = userTurns(transcript);
  const text = turns.join("  ");
  const reason = String(endedReason || "").toLowerCase();

  // STEP 0 — deterministic terminals (telephony ground truth) win first.
  if (facts.voicemail || /voicemail/.test(reason) || /leave a message|after the (tone|beep)|\bvoicemail\b/.test(text)) {
    return mk("P2_VOICEMAIL", 0.97, "deterministic", "voicemail detected");
  }
  const term = heuristicEndReason(endedReason, transcript); // P2 voicemail / P3 silence-or-empty / null
  if (term && term.code === "P3_UNREACHABLE") {
    // If an explicit fact claims the call progressed but there's no caller audio, the two
    // contradict — report it as "couldn't confirm" (a definite outcome), not unreachable.
    if (facts.identity === "confirmed" || facts.survey || facts.wrongPerson) {
      return mk("P6_UNCLEAR", 0.6, "derived", "a recorded fact contradicts the lack of caller audio");
    }
    return mk("P3_UNREACHABLE", 0.95, "deterministic", "no caller audio / silence");
  }

  // STEP 1 — establish identity (explicit fact wins; else derive from the identity phase
  // with preceding-line context — see deriveIdentity).
  let identity = facts.identity; // "confirmed" | "denied" | undefined
  if (!identity) {
    const d = deriveIdentity(transcript);
    if (d === "contradiction") return mk("P6_UNCLEAR", 0.6, "derived", "contradictory identity: the caller both confirmed and denied");
    identity = d; // "confirmed" | "denied" | undefined
  }

  const src = Object.keys(facts).length ? "fact" : "derived";

  // STEP 2 — not (yet) confirmed: wrong person, decline, hangup, or unclear.
  if (identity === "denied") return mk("P5_WRONG_PERSON", 0.9, src, "explicit denial / wrong person");

  if (identity !== "confirmed") {
    if (facts.declined || RX.decline.test(text)) {
      return mk("P4_DECLINED", 0.85, src, "refused / hostile before confirming identity");
    }
    if (/customer-ended-call/.test(reason)) {
      return mk("P7_HUNGUP_EARLY", 0.85, "deterministic", "caller hung up before confirming identity");
    }
    // Reached a human, engaged, but we never got a clean yes or no. Honest, not a guess.
    return mk("P6_UNCLEAR", 0.8, "derived", "reached someone but identity was never confirmed");
  }

  // STEP 3 — identity CONFIRMED. Resolve the survey. (A confirmed person can never be
  // P4/P5 — identity is verified; the only question is whether they answered.)
  if (facts.survey && facts.survey.answered && facts.survey.sentiment) {
    return mk("P1_SUCCESS", 0.95, "fact", "confirmed + survey answered (fact)");
  }
  if (facts.surveyDeclined) {
    return mk("P8_VERIFIED_NO_SURVEY", 0.9, "fact", "confirmed + survey declined (fact)");
  }

  const resp = surveyResponse(transcript);
  if (resp == null) {
    return mk("P8_VERIFIED_NO_SURVEY", 0.85, "derived", "confirmed, but no survey response");
  }
  if (RX.sentiment.test(resp)) {
    return mk("P1_SUCCESS", 0.9, "derived", "confirmed + clear sentiment answer");
  }
  if (RX.surveyDecline.test(resp) || RX.decline.test(resp)) {
    return mk("P8_VERIFIED_NO_SURVEY", 0.85, "derived", "confirmed, deferred/declined the survey");
  }
  // Confirmed, said SOMETHING to the survey, but it's neither a clean sentiment nor a
  // clean refusal — garbled or a non-answer. Identity IS verified, so report P8 (we
  // confirmed who they are; the survey just wasn't clearly completed). P1 still requires
  // a clean sentiment, so an unintelligible reply never becomes a "Verified & Surveyed".
  return mk("P8_VERIFIED_NO_SURVEY", 0.7, "derived", `confirmed; survey response unclear: "${resp}"`);
}

// Cross-check is retained as a no-op pass-through: the resolver is now the sole
// decider and always returns a definite code, so the LLM never overrides it. (The
// DeepSeek/Vapi signals remain visible in the compare panel for debugging.)
export function crossCheck(result /* , otherCode */) {
  return result;
}
