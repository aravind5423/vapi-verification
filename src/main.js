import * as VapiSDK from "@vapi-ai/web";
import "./style.css";
import { OUTCOME_CONFIG, normalizeFirstName, parseArgs, describeError } from "./utils.js";

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

// ─── State ───────────────────────────────────────────────────────────────────
const vapi = (PUBLIC_KEY && Vapi) ? new Vapi(PUBLIC_KEY) : null;
let outcome = null;     // last set_outcome captured this call
let inCall  = false;
let connecting = false; // submitted, mic/connect in flight — guards double-submit
let connectTimer = null; // guards against a never-connecting call (hung spinner)
let awaitingResult = false;   // outcome captured; waiting for Freya to finish the goodbye
let resultFallbackTimer = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
// (normalizeFirstName / parseArgs / describeError live in ./utils.js so they're
//  unit-testable without a DOM. The DOM-bound helpers below stay here.)

function setStatus(icon, orbClass, title, msg, tone) {
  orbEmoji.textContent = icon;
  orb.className = `orb ${orbClass}`;
  orb.style.boxShadow = ""; // clear any volume-driven glow from a prior call
  statusTitle.textContent = title;
  statusMsg.textContent   = msg;
  app.dataset.tone = tone || ""; // accent hook for the result area
}

function showStartButtonLoading(loading) {
  connecting = loading; // single source of truth for "a start is in flight"
  startBtn.disabled = loading;
  startBtnText.textContent = loading ? "Connecting…" : "Start verification call";
  spinner.style.display = loading ? "block" : "none";
}

function resetToIdle() {
  outcome = null;
  inCall = false;
  awaitingResult = false;
  clearTimeout(connectTimer);
  clearTimeout(resultFallbackTimer);
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
    clearTimeout(resultFallbackTimer);
    awaitingResult = false;
    inCall = true;
    showStartButtonLoading(false);
    app.dataset.state = "calling";
    setStatus("🎙️", "live", "Connected", "You're live with Freya — just talk naturally.", "");
  });

  vapi.on("call-end", () => {
    clearTimeout(connectTimer);
    clearTimeout(resultFallbackTimer);
    awaitingResult = false;
    renderResult(outcome);
  });

  // Freya finished a spoken turn. If the outcome is already recorded, this is the
  // end of her closing line — reveal the result NOW (right as she stops), so the
  // UI never updates before she's done talking.
  vapi.on("speech-end", () => {
    if (awaitingResult) {
      awaitingResult = false;
      clearTimeout(resultFallbackTimer);
      renderResult(outcome);
    }
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
    // A malformed/unexpected message must never throw out of the event handler
    // (that would silently drop every later message on some emitters).
    try {
      if (!m) return;

      // Capture the set_outcome tool call (modern tool-calls or legacy function-call).
      const raw =
        m.type === "tool-calls"    ? (m.toolCallList ?? m.toolCalls ?? []) :
        m.type === "function-call" ? [m.functionCall] :
        [];
      const calls = Array.isArray(raw) ? raw : [];

      for (const c of calls) {
        const fnName = c?.function?.name ?? c?.name;
        if (fnName !== "set_outcome") continue;
        const args = parseArgs(c?.function?.arguments ?? c?.arguments ?? c?.parameters);
        const code = args?.outcome;
        if (typeof code !== "string" || !code.trim()) continue;
        outcome = code.trim();
        // Don't flip the UI yet — wait for Freya to FINISH the closing line
        // (the "speech-end" below) so the result never appears before she's
        // done talking. Fallback timer + call-end cover the rare no-speech case.
        if (inCall) {
          awaitingResult = true;
          clearTimeout(resultFallbackTimer);
          resultFallbackTimer = setTimeout(() => {
            if (awaitingResult) { awaitingResult = false; renderResult(outcome); }
          }, 6000);
        }
      }
    } catch (err) {
      console.error("[vapi] failed to handle message", err);
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
  // Ignore a second submit (double-click, Enter-spam) while a call is connecting
  // or live — otherwise we'd fire a second vapi.start and leak a parallel call.
  if (inCall || connecting) return;
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

  // Pre-warm the mic so the permission prompt + device init finish BEFORE the call —
  // the usual cause of a flaky first call. Release it right away so the SDK can claim it.
  try {
    const warm = await navigator.mediaDevices.getUserMedia({ audio: true });
    warm.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.error("[mic] pre-warm failed", err);
    const nm = err?.name || "";
    const msg =
      nm === "NotAllowedError" || nm === "SecurityError" ? "Microphone access is required — allow your mic and try again." :
      nm === "NotFoundError" || nm === "OverconstrainedError" ? "No microphone found. Plug one in and try again." :
      "Couldn't access the microphone: " + (err?.message || nm || "unknown error");
    outcomeBadge.className = "outcome-badge";
    app.dataset.state = "result";
    setStatus("⚠️", "error", "Microphone Needed", msg, "error");
    showStartButtonLoading(false);
    return;
  }

  // Guard against a call that never connects (keeps the spinner from hanging forever).
  clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    if (inCall) return;
    try { vapi.stop(); } catch (err) { console.error("[vapi] stop() on connect-timeout failed", err); }
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
  try {
    const next = !vapi.isMuted();
    vapi.setMuted(next);
    muteBtn.textContent = next ? "Unmute" : "Mute";
    muteBtn.classList.toggle("muted", next);
  } catch (err) {
    console.error("[vapi] toggling mute failed", err);
  }
});

endBtn.addEventListener("click", () => {
  if (!vapi || !inCall) return;
  try { vapi.stop(); } catch (err) { console.error("[vapi] stop() from End button failed", err); }
});

retryBtn.addEventListener("click", () => {
  // Defensive: retry is only shown on the result screen, but if a call were
  // somehow still live, tear it down before resetting so it can't run on silently.
  if (vapi && inCall) {
    try { vapi.stop(); } catch (err) { console.error("[vapi] stop() on retry failed", err); }
  }
  resetToIdle();
});
