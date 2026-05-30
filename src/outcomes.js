// ─────────────────────────────────────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH for the verification outcome taxonomy.
//
// These codes used to be duplicated in three places (the set_outcome tool enum in
// scripts/configure-assistant.mjs, the validation Set in api/outcome.js, and the
// UI config in src/utils.js). Drift between them caused silent bugs. Everything
// now imports from here:
//   • src/utils.js / src/main.js  → OUTCOME_CONFIG (UI rendering)
//   • api/outcome.js, api/classify.js → OUTCOME_SET / isValidOutcome (validation)
//   • scripts/configure-assistant.mjs → OUTCOME_CODES (tool enum + analysis schema)
//
// Plain ESM, zero dependencies, DOM-free — safe to import from the browser bundle,
// a Vercel serverless function, and a Node script alike.
// ─────────────────────────────────────────────────────────────────────────────

// The canonical ordered list of outcome codes. P1–P6 are unchanged; P7/P8 were
// added (minimal-additive) to fix two real gaps seen in production calls:
//   • P7 — a customer who hangs up before confirming identity had no home (it was
//     landing in P6/null, which is wrong).
//   • P8 — "confirmed identity but never answered the survey" was being recorded
//     as P1_SUCCESS, a false success. P1 now means confirmed AND surveyed.
export const OUTCOME_CODES = [
  "P1_SUCCESS",
  "P2_VOICEMAIL",
  "P3_UNREACHABLE",
  "P4_DECLINED",
  "P5_WRONG_PERSON",
  "P6_UNCLEAR",
  "P7_HUNGUP_EARLY",
  "P8_VERIFIED_NO_SURVEY",
];

export const OUTCOME_SET = new Set(OUTCOME_CODES);

// True only for a real, known P-code the agent/Vapi can emit. Every completed call
// resolves to exactly one of these — there is no abstention / "needs review" state.
export function isValidOutcome(code) {
  return typeof code === "string" && OUTCOME_SET.has(code);
}

// True for anything the UI can render. Now identical to isValidOutcome (the 8 P-codes),
// kept as a distinct name for the server-side render/validation call sites.
export function isDisplayable(code) {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(OUTCOME_CONFIG, code);
}

// Outcome → display config. `cardState` reuses the existing orb/accent states
// (success | voicemail | error | warning | neutral | muted) so no new orb styles
// are needed; `cls` is the badge accent class (see src/style.css).
//
// `badge` is the ONLY outcome text the end user sees — plain human words, no internal
// P-code. (`label` keeps the P-code for logs/debugging; the UI uses `badge`.)
export const OUTCOME_CONFIG = {
  P1_SUCCESS:            { label: "P1 · Confirmed",      badge: "Verified & Surveyed",                cls: "P1", icon: "✅", cardState: "success",   title: "Verification Successful", msg: "Identity confirmed and the check was completed — thanks!" },
  P2_VOICEMAIL:         { label: "P2 · Voicemail",      badge: "Voicemail",                          cls: "P2", icon: "📬", cardState: "voicemail", title: "Reached Voicemail",       msg: "A voicemail or answering machine picked up." },
  P3_UNREACHABLE:       { label: "P3 · No Answer",      badge: "No Answer",                          cls: "P3", icon: "📵", cardState: "error",     title: "Couldn't Connect",        msg: "The call couldn't be completed." },
  P4_DECLINED:          { label: "P4 · Not Interested", badge: "Declined",                           cls: "P4", icon: "🚫", cardState: "warning",   title: "Declined",                msg: "We reached the person, but they weren't interested." },
  P5_WRONG_PERSON:      { label: "P5 · Wrong Person",   badge: "Wrong Person",                       cls: "P5", icon: "🙅", cardState: "neutral",   title: "Not the Right Person",    msg: "We reached someone, but not the person we were verifying." },
  P6_UNCLEAR:           { label: "P6 · Unclear",        badge: "Couldn't Confirm",                   cls: "P6", icon: "🤔", cardState: "muted",     title: "Couldn't Confirm",        msg: "We reached someone, but couldn't confirm their identity." },
  P7_HUNGUP_EARLY:      { label: "P7 · Hung Up",        badge: "Ended Early",                         cls: "P7", icon: "📴", cardState: "muted",     title: "Call Dropped Early",      msg: "The call ended before identity could be confirmed." },
  P8_VERIFIED_NO_SURVEY:{ label: "P8 · Verified",       badge: "Identity Confirmed",                 cls: "P8", icon: "☑️", cardState: "neutral",   title: "Identity Confirmed",      msg: "Identity confirmed, but the survey wasn't completed." },
};
