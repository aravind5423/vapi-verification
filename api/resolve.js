// ─────────────────────────────────────────────────────────────────────────────
// The DETERMINISTIC OUTCOME RESOLVER — the authoritative outcome path.
//
// Philosophy (per the approved plan): don't GUESS a holistic P-code after the call.
// Record/derive a few ATOMIC FACTS, then map facts → exactly one P-code by fixed
// rules — OR abstain to NEEDS_REVIEW when the facts are missing, contradictory, or
// the decisive turn is too ambiguous/garbled to trust. We would rather flag a call
// for a human than show a confident wrong code.
//
// Two fact sources, in order of trust:
//   1. EXPLICIT fact tool calls the agent emits during the call (confirm_identity,
//      wrong_person, record_survey, survey_declined, decline_call, mark_voicemail).
//      Ground truth — once those tools are live on the assistant.
//   2. DERIVED from the transcript with deterministic heuristics (works TODAY, before
//      any agent change — this is what we validate against the 30 real calls).
// Explicit facts always win over derived ones.
//
// The LLM classifiers (DeepSeek/Vapi) are NOT consulted here. They are a CROSS-CHECK
// applied by the caller (api/outcome.js): they can only RAISE NEEDS_REVIEW when they
// strongly contradict an explicit recorded fact — never override the resolver.
// ─────────────────────────────────────────────────────────────────────────────

import { userTurns, heuristicEndReason } from "./classify.js";
import { NEEDS_REVIEW } from "../src/outcomes.js";

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

function mk(code, confidence, source, reason) {
  return { code, confidence, source, reason };
}
function review(reason) {
  return { code: NEEDS_REVIEW, confidence: 0, source: "abstain", reason };
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
    // If an explicit fact claims the call progressed but there's no caller audio, that's
    // a contradiction → review rather than silently calling it unreachable.
    if (facts.identity === "confirmed" || facts.survey || facts.wrongPerson) {
      return review("a recorded fact says the call progressed, but there is no caller audio");
    }
    return mk("P3_UNREACHABLE", 0.95, "deterministic", "no caller audio / silence");
  }

  // STEP 1 — establish identity (explicit fact wins; else derive).
  let identity = facts.identity; // "confirmed" | "denied" | undefined
  if (!identity) {
    const hasConfirm = turns.some(isConfirmTurn);
    const hasDeny = RX.denial.test(text) || turns.some((t) => hasNegation(t));
    if (hasConfirm && hasDeny) return review("contradictory identity: the caller both confirmed and denied");
    if (hasDeny) identity = "denied";
    else if (hasConfirm) identity = "confirmed";
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
  // clean refusal — genuinely ambiguous (garbled or a non-answer). ABSTAIN.
  return review(`confirmed, but the survey response is ambiguous: "${resp}"`);
}

// Cross-check: given the resolver result and an independent LLM/Vapi code, decide
// whether to RAISE needs-review. Only fires when the resolver result rests on an
// EXPLICIT fact (high trust) and the cross-check flatly contradicts it on the
// verified-vs-not axis. Never used to override a derived result (the LLM reads the
// same transcript, so disagreement there is just noise).
const VERIFIED = new Set(["P1_SUCCESS", "P8_VERIFIED_NO_SURVEY"]);
const NOT_VERIFIED = new Set(["P5_WRONG_PERSON", "P6_UNCLEAR", "P7_HUNGUP_EARLY"]);
export function crossCheck(result, otherCode) {
  if (!result || result.source !== "fact" || !otherCode) return result;
  const a = result.code, b = otherCode;
  const contradicts =
    (VERIFIED.has(a) && NOT_VERIFIED.has(b)) || (NOT_VERIFIED.has(a) && VERIFIED.has(b));
  if (contradicts) {
    return review(`recorded fact (${a}) contradicts the independent classifier (${b})`);
  }
  return result;
}
