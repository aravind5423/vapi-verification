import * as VapiSDK from "@vapi-ai/web";
import "./style.css";

// @vapi-ai/web ships as CommonJS (module.exports = { default: VapiClass }).
// The default-import interop mis-resolves in the production bundle
// ("X.default is not a constructor"), so resolve the constructor defensively.
const Vapi =
  typeof VapiSDK === "function" ? VapiSDK :
  typeof VapiSDK?.default === "function" ? VapiSDK.default :
  typeof VapiSDK?.default?.default === "function" ? VapiSDK.default.default :
  null;

if (!Vapi && typeof window !== "undefined" && window.__showBootError) {
  window.__showBootError("⚠️ Vapi SDK failed to load (constructor not found).");
}

// ─── Config (browser-safe, inlined by Vite at build time) ───────────────────
// Env vars win when set; the fallbacks let it deploy with zero config. Both are
// PUBLIC/non-secret (the public key is meant to live in the browser). For prod,
// restrict the public key to your domain in the Vapi dashboard.
const PUBLIC_KEY = import.meta.env.VITE_VAPI_PUBLIC_KEY || "1a840109-9d4c-484d-85e6-e4747c1588f4";
const ASSISTANT_ID = import.meta.env.VITE_VAPI_ASSISTANT_ID || "28fe3455-e09e-4d09-bf74-6c7b0411a804";

// ─── Element refs ────────────────────────────────────────────────────────────
const startForm   = document.getElementById("startForm");
const nameInput   = document.getElementById("name");
const nameError   = document.getElementById("nameError");
const startBtn    = document.getElementById("startBtn");
const startBtnText= document.getElementById("startBtnText");
const spinner     = document.getElementById("spinner");

const app         = document.getElementById("app");
const orb         = document.getElementById("orb");
const orbEmoji    = document.getElementById("orbEmoji");
const statusTitle = document.getElementById("statusTitle");
const statusMsg   = document.getElementById("statusMessage");
const outcomeBadge= document.getElementById("outcomeBadge");
const muteBtn     = document.getElementById("muteBtn");
const endBtn      = document.getElementById("endBtn");
const retryBtn    = document.getElementById("retryBtn");

// ─── Outcome display config ──────────────────────────────────────────────────
const OUTCOME_CONFIG = {
  P1_SUCCESS:     { label: "P1 · Confirmed",       cls: "P1", icon: "✅", cardState: "success",   title: "Verification Successful", msg: "You confirmed your identity — thanks!" },
  P2_VOICEMAIL:   { label: "P2 · Voicemail",       cls: "P2", icon: "📬", cardState: "voicemail", title: "Reached Voicemail",       msg: "A voicemail or answering machine picked up." },
  P3_UNREACHABLE: { label: "P3 · No Answer",       cls: "P3", icon: "📵", cardState: "error",     title: "Couldn't Connect",        msg: "The call couldn't be completed." },
  P4_DECLINED:    { label: "P4 · Not Interested",  cls: "P4", icon: "🚫", cardState: "warning",   title: "Declined",                msg: "We reached the person, but they weren't interested." },
  P5_WRONG_PERSON:{ label: "P5 · Wrong Person",    cls: "P5", icon: "🙅", cardState: "neutral",   title: "Not the Right Person",    msg: "We reached someone, but not the person we were verifying." },
  P6_UNCLEAR:     { label: "P6 · Unclear",         cls: "P6", icon: "🤔", cardState: "muted",     title: "Couldn't Tell",           msg: "We reached someone, but couldn't confirm the outcome." },
};

// ─── State ───────────────────────────────────────────────────────────────────
const vapi = (PUBLIC_KEY && Vapi) ? new Vapi(PUBLIC_KEY) : null;
let outcome = null;     // last set_outcome captured this call
let inCall  = false;
let connectTimer = null; // guards against a never-connecting call (hung spinner)

// ─── Helpers ─────────────────────────────────────────────────────────────────
// Pull a clean, speakable first name out of whatever the user typed. Handles
// honorifics ("Mr.Ara" → "Ara"), ALL-CAPS (→ Title-case so the TTS says it as a
// word instead of spelling it), initials, punctuation and stray whitespace.
// Returns "" if there's no real (letter-containing) name.
const HONORIFICS = new Set([
  "mr","mrs","ms","miss","mx","dr","prof","professor","sir","madam","maam","rev","fr","hon",
]);
function normalizeFirstName(raw) {
  const tokens = String(raw || "")
    .replace(/[.,]/g, " ")     // split "Mr.Ara" and initials
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < tokens.length && HONORIFICS.has(tokens[i].toLowerCase().replace(/[^a-z]/g, ""))) i++;
  const rest = tokens.slice(i);
  const hasLetter = (t) => /[a-zA-Z]/.test(t);
  const longEnough = (t) => t.replace(/[^a-zA-Z'-]/g, "").length >= 2;
  const pick =
    rest.find((t) => hasLetter(t) && longEnough(t)) ||
    rest.find(hasLetter) ||
    tokens.find(hasLetter) ||   // fallback: even an honorific-only edge
    "";
  const clean = pick.replace(/[^a-zA-Z'-]/g, "");
  if (!clean) return "";
  return clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

function describeError(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  const m =
    e?.error?.message || e?.errorMsg || e?.message ||
    e?.error?.msg || e?.error?.error || e?.reason || e?.type;
  if (m) return typeof m === "string" ? m : safeJson(m);
  return safeJson(e);
}
function safeJson(v) { try { return JSON.stringify(v); } catch { return String(v); } }

function setStatus(icon, orbClass, title, msg, tone) {
  orbEmoji.textContent = icon;
  orb.className = `orb ${orbClass}`;
  orb.style.boxShadow = ""; // clear any volume-driven glow from a prior call
  statusTitle.textContent = title;
  statusMsg.textContent   = msg;
  app.dataset.tone = tone || ""; // accent hook for the result area
}

function showStartButtonLoading(loading) {
  startBtn.disabled = loading;
  startBtnText.textContent = loading ? "Connecting…" : "Start verification call";
  spinner.style.display = loading ? "block" : "none";
}

function resetToIdle() {
  outcome = null;
  inCall = false;
  clearTimeout(connectTimer);
  window.__clearBootError?.();
  showStartButtonLoading(false);
  app.dataset.state = "idle";
  app.dataset.tone = "";
  outcomeBadge.className = "outcome-badge";
  outcomeBadge.textContent = "";
  nameError.style.display = "none";
  nameInput.classList.remove("error-input");
  muteBtn.classList.remove("muted");
  muteBtn.textContent = "Mute";
}

function renderResult(code) {
  inCall = false;
  showStartButtonLoading(false);
  app.dataset.state = "result";

  if (!code) {
    // Call ended without a recorded outcome (e.g. hung up early, or the agent
    // never heard you and timed out on silence) — stay neutral and nudge the mic.
    outcomeBadge.className = "outcome-badge";
    setStatus("☎️", "muted", "Call Ended",
      "The call ended before a result was recorded. If you didn't get to speak, check your microphone and try again.", "muted");
  } else {
    const cfg = OUTCOME_CONFIG[code] || OUTCOME_CONFIG.P6_UNCLEAR;
    setStatus(cfg.icon, cfg.cardState, cfg.title, cfg.msg, cfg.cardState);
    outcomeBadge.textContent = cfg.label;
    outcomeBadge.className = `outcome-badge show ${cfg.cls}`;
  }
}

// ─── Vapi event wiring ───────────────────────────────────────────────────────
if (vapi) {
  vapi.on("call-start", () => {
    clearTimeout(connectTimer);
    inCall = true;
    showStartButtonLoading(false);
    app.dataset.state = "calling";
    setStatus("🎙️", "live", "Connected", "You're live with Freya — just talk naturally.", "");
  });

  vapi.on("call-end", () => {
    clearTimeout(connectTimer);
    renderResult(outcome);
  });

  // Make the orb pulse with Freya's voice while she speaks. volume-level fires
  // very frequently and animating a large blurred box-shadow per event is a
  // repaint hot spot — coalesce to at most one update per animation frame.
  let pendingLvl = 0, glowQueued = false;
  vapi.on("volume-level", (v) => {
    if (!inCall) return;
    pendingLvl = Math.max(0, Math.min(1, Number(v) || 0));
    if (glowQueued) return;
    glowQueued = true;
    requestAnimationFrame(() => {
      glowQueued = false;
      const lvl = pendingLvl;
      orb.style.boxShadow = `0 0 ${16 + lvl * 46}px ${4 + lvl * 12}px rgba(99,102,241,${0.18 + lvl * 0.5})`;
    });
  });

  vapi.on("message", (m) => {
    if (!m) return;

    // Capture the set_outcome tool call (modern tool-calls or legacy function-call)
    const calls =
      m.type === "tool-calls"    ? (m.toolCallList ?? m.toolCalls ?? []) :
      m.type === "function-call" ? [m.functionCall] :
      [];

    for (const c of calls) {
      const fnName = c?.function?.name ?? c?.name;
      if (fnName === "set_outcome") {
        const args = parseArgs(c?.function?.arguments ?? c?.arguments ?? c?.parameters);
        if (typeof args?.outcome === "string") outcome = args.outcome;
      }
    }
  });

  vapi.on("error", (e) => {
    console.error("[vapi] error", e);
    clearTimeout(connectTimer);
    const detail = describeError(e);
    const low = detail.toLowerCase();

    // Daily tears the room down when the call ends (silence timeout, normal
    // hangup, etc.) and surfaces it here as an "error" — but it isn't one.
    // Don't alarm the user; let the call-end handler render the result.
    if (low.includes("meeting has ended") || low.includes("meeting ended") || low.includes("ejected")) {
      inCall = false;
      return;
    }

    let msg = detail;
    if (low.includes("notallowed") || low.includes("permission")) {
      msg = "Microphone access is required — allow your mic and try again.";
    } else if (low.includes("notfound")) {
      msg = "No microphone found. Plug one in and try again.";
    }
    inCall = false;
    outcomeBadge.className = "outcome-badge";
    app.dataset.state = "result";
    setStatus("⚠️", "error", "Call Error", msg, "error");
    showStartButtonLoading(false);
  });
}

// ─── Form / control handlers ─────────────────────────────────────────────────
// `submit` (not button `click`) so pressing Enter in the name field starts the
// call instead of triggering the browser's default form submit (a page reload).
startForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!vapi || !PUBLIC_KEY || !ASSISTANT_ID) {
    outcomeBadge.className = "outcome-badge";
    app.dataset.state = "result";
    setStatus("⚠️", "error", "Not Configured",
      "Missing VITE_VAPI_PUBLIC_KEY or VITE_VAPI_ASSISTANT_ID. Set them and rebuild.", "error");
    return;
  }

  const fullName = nameInput.value.trim();
  // Derive a clean, speakable first name from whatever was typed (titles, caps, etc.).
  const name = normalizeFirstName(fullName);
  if (!name) {
    nameError.style.display = "block";
    nameInput.classList.add("error-input");
    return;
  }
  nameError.style.display = "none";
  nameInput.classList.remove("error-input");

  // Switch to the live call view in a fresh connecting state
  outcome = null;
  window.__clearBootError?.();
  outcomeBadge.className = "outcome-badge";
  app.dataset.state = "calling";
  setStatus("🎙️", "pending", "Connecting…", "Allow microphone access to begin.", "");
  showStartButtonLoading(true);

  // Guard against a call that never connects (keeps the spinner from hanging forever).
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (inCall) return;
    try { vapi.stop(); } catch {}
    outcomeBadge.className = "outcome-badge";
    app.dataset.state = "result";
    setStatus("⚠️", "error", "Couldn't Connect",
      "The call didn't connect in time. Check your internet connection and try again.", "error");
    showStartButtonLoading(false);
  }, 20000);

  try {
    await vapi.start(ASSISTANT_ID, { variableValues: { name } });
  } catch (err) {
    console.error("[vapi] start failed", err);
    clearTimeout(connectTimer);
    const detail = describeError(err);
    outcomeBadge.className = "outcome-badge";
    app.dataset.state = "result";
    setStatus("⚠️", "error", "Couldn't Start", detail, "error");
    if (window.__showBootError) window.__showBootError("⚠️ Start failed: " + detail);
    showStartButtonLoading(false);
  }
});

muteBtn.addEventListener("click", () => {
  if (!vapi || !inCall) return;
  const next = !vapi.isMuted();
  vapi.setMuted(next);
  muteBtn.textContent = next ? "Unmute" : "Mute";
  muteBtn.classList.toggle("muted", next);
});

endBtn.addEventListener("click", () => {
  if (vapi && inCall) vapi.stop();
});

retryBtn.addEventListener("click", resetToIdle);
