// ─────────────────────────────────────────────────────────────────────────────
// Pure, DOM-free helpers. Kept out of main.js so they can be unit-tested in
// isolation (see utils.test.js) — importing main.js would touch the DOM at load.
// ─────────────────────────────────────────────────────────────────────────────

// Outcome → display config. The 6 P-codes the assistant's set_outcome tool emits.
export const OUTCOME_CONFIG = {
  P1_SUCCESS:     { label: "P1 · Confirmed",       cls: "P1", icon: "✅", cardState: "success",   title: "Verification Successful", msg: "You confirmed your identity — thanks!" },
  P2_VOICEMAIL:   { label: "P2 · Voicemail",       cls: "P2", icon: "📬", cardState: "voicemail", title: "Reached Voicemail",       msg: "A voicemail or answering machine picked up." },
  P3_UNREACHABLE: { label: "P3 · No Answer",       cls: "P3", icon: "📵", cardState: "error",     title: "Couldn't Connect",        msg: "The call couldn't be completed." },
  P4_DECLINED:    { label: "P4 · Not Interested",  cls: "P4", icon: "🚫", cardState: "warning",   title: "Declined",                msg: "We reached the person, but they weren't interested." },
  P5_WRONG_PERSON:{ label: "P5 · Wrong Person",    cls: "P5", icon: "🙅", cardState: "neutral",   title: "Not the Right Person",    msg: "We reached someone, but not the person we were verifying." },
  P6_UNCLEAR:     { label: "P6 · Unclear",         cls: "P6", icon: "🤔", cardState: "muted",     title: "Couldn't Tell",           msg: "We reached someone, but couldn't confirm the outcome." },
};

// Honorifics stripped from the front of a typed name before picking the first name.
export const HONORIFICS = new Set([
  "mr", "mrs", "ms", "miss", "mx", "dr", "prof", "professor", "sir", "madam", "maam", "rev", "fr", "hon",
]);

// Cap on the name we hand to the TTS — guards against an absurdly long paste
// being sent as {{name}} (and read aloud) without truncation.
export const MAX_NAME_LEN = 40;

// Pull a clean, speakable first name out of whatever the user typed. Handles
// honorifics ("Mr.Ara" → "Ara"), ALL-CAPS (→ Title-case so the TTS says it as a
// word instead of spelling it), initials, punctuation, stray whitespace, and
// Unicode/accented/non-Latin names (José, Müller, محمد, 李伟 are preserved, not
// stripped to "" or mangled). Returns "" if there's no real (letter) name.
export function normalizeFirstName(raw) {
  // A name is a text field. Reject non-string input (object/array/number/bool)
  // outright rather than stringifying it into a bogus name ("[object Object]").
  if (typeof raw !== "string") return "";
  const tokens = raw
    .normalize("NFC")          // unify accented forms so combining marks survive
    .replace(/[.,]/g, " ")     // split "Mr.Ara" and initials
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length && HONORIFICS.has(tokens[i].toLowerCase().replace(/[^a-z]/g, ""))) i++;
  const rest = tokens.slice(i);
  // \p{L} = any Unicode letter (not just a–z), so non-Latin names aren't dropped.
  const hasLetter = (t) => /\p{L}/u.test(t);
  const letterCount = (t) => (t.match(/\p{L}/gu) || []).length;
  const longEnough = (t) => letterCount(t) >= 2;
  const pick =
    rest.find((t) => hasLetter(t) && longEnough(t)) ||
    rest.find(hasLetter) ||
    tokens.find(hasLetter) ||   // fallback: even an honorific-only edge
    "";
  // Keep letters, combining marks (accents), apostrophes and hyphens; drop the rest.
  const clean = pick.replace(/[^\p{L}\p{M}'-]/gu, "").slice(0, MAX_NAME_LEN);
  if (!clean) return "";
  // Title-case. For non-cased scripts (CJK, Arabic, …) toUpper/Lower are no-ops,
  // so this leaves them intact while fixing ALL-CAPS Latin ("NEEL" → "Neel").
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

// Tool-call arguments arrive as either a JSON string or an already-parsed object.
// Always returns a plain object ({} on anything unparseable) so callers can read
// args.outcome without a type guard.
export function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
}

export function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

// SDK/runtime errors come in many shapes (string, Error, nested {error:{message}},
// Daily-style {errorMsg}, …). Dig out the most human-readable message we can.
export function describeError(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  const m =
    e?.error?.message || e?.errorMsg || e?.message ||
    e?.error?.msg || e?.error?.error || e?.reason || e?.type;
  if (m) return typeof m === "string" ? m : safeJson(m);
  return safeJson(e);
}
