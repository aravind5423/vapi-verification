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

const statusCard  = document.getElementById("statusCard");
const orb         = document.getElementById("orb");
const orbEmoji    = document.getElementById("orbEmoji");
const statusTitle = document.getElementById("statusTitle");
const statusMsg   = document.getElementById("statusMessage");
const outcomeBadge= document.getElementById("outcomeBadge");
const transcript  = document.getElementById("transcript");
const callControls= document.getElementById("callControls");
const muteBtn     = document.getElementById("muteBtn");
const endBtn      = document.getElementById("endBtn");
const retryBtn    = document.getElementById("retryBtn");

// ─── Outcome display config ──────────────────────────────────────────────────
const OUTCOME_CONFIG = {
  P1_SUCCESS:     { label: "P1 — Identity Confirmed",      cls: "P1", icon: "✅", cardState: "success",   title: "Verification Successful", msg: "You confirmed your identity. Thanks!" },
  P2_VOICEMAIL:   { label: "P2 — Voicemail Detected",      cls: "P2", icon: "📬", cardState: "voicemail", title: "Reached Voicemail",       msg: "A voicemail/answering machine was detected." },
  P3_UNREACHABLE: { label: "P3 — Unreachable",             cls: "P3", icon: "📵", cardState: "error",     title: "Could Not Connect",       msg: "The call couldn't be completed." },
  P4_UNCLEAR:     { label: "P4 — Unclear / Uncooperative", cls: "P4", icon: "❓", cardState: "error",     title: "Could Not Verify",        msg: "Identity was not confirmed." },
};

// ─── State ───────────────────────────────────────────────────────────────────
const vapi = (PUBLIC_KEY && Vapi) ? new Vapi(PUBLIC_KEY) : null;
let outcome = null;     // last set_outcome captured this call
let inCall  = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

function setStatus(icon, orbClass, title, msg, cardState) {
  orbEmoji.textContent = icon;
  orb.className = `orb ${orbClass}`;
  orb.style.boxShadow = ""; // clear any volume-driven glow from a prior call
  statusTitle.textContent = title;
  statusMsg.textContent   = msg;
  statusCard.className     = `status-card ${cardState ? "state-" + cardState : ""}`;
}

function appendTranscript(role, text) {
  if (!text) return;
  const who = role === "assistant" ? "Freya" : "You";
  const line = document.createElement("div");
  line.className = `line ${role === "assistant" ? "assistant" : "user"}`;
  line.innerHTML = `<span class="who">${who}:</span> <span class="what"></span>`;
  line.querySelector(".what").textContent = text;
  transcript.appendChild(line);
  transcript.classList.add("show");
  transcript.scrollTop = transcript.scrollHeight;
}

function showStartButtonLoading(loading) {
  startBtn.disabled = loading;
  startBtnText.textContent = loading ? "Connecting…" : "Start verification call";
  spinner.style.display = loading ? "block" : "none";
}

function resetToIdle() {
  outcome = null;
  inCall = false;
  showStartButtonLoading(false);
  statusCard.style.display = "none";
  outcomeBadge.className = "outcome-badge";
  outcomeBadge.textContent = "";
  transcript.className = "transcript";
  transcript.innerHTML = "";
  callControls.className = "call-controls";
  retryBtn.className = "retry-btn";
  nameError.style.display = "none";
  nameInput.classList.remove("error-input");
  muteBtn.classList.remove("muted");
  muteBtn.textContent = "Mute";
}

function renderResult(code) {
  inCall = false;
  callControls.className = "call-controls"; // hide
  showStartButtonLoading(false);

  if (!code) {
    // Call ended without a recorded outcome (e.g. hung up early) — stay neutral.
    setStatus("☎️", "error", "Call Ended", "The call ended before a result was recorded.", "error");
  } else {
    const cfg = OUTCOME_CONFIG[code] || OUTCOME_CONFIG.P4_UNCLEAR;
    setStatus(cfg.icon, cfg.cardState, cfg.title, cfg.msg, cfg.cardState);
    outcomeBadge.textContent = cfg.label;
    outcomeBadge.className = `outcome-badge show ${cfg.cls}`;
  }
  retryBtn.className = "retry-btn show";
}

// ─── Vapi event wiring ───────────────────────────────────────────────────────
if (vapi) {
  vapi.on("call-start", () => {
    inCall = true;
    showStartButtonLoading(false);
    callControls.className = "call-controls show";
    setStatus("🎙️", "live", "Connected", "You're live with Freya — just talk naturally.", null);
  });

  vapi.on("call-end", () => {
    renderResult(outcome);
  });

  // Make the orb pulse with Freya's voice while she speaks.
  vapi.on("volume-level", (v) => {
    if (!inCall) return;
    const lvl = Math.max(0, Math.min(1, Number(v) || 0));
    orb.style.boxShadow = `0 0 ${16 + lvl * 46}px ${4 + lvl * 12}px rgba(99,102,241,${0.18 + lvl * 0.5})`;
  });

  vapi.on("message", (m) => {
    if (!m) return;

    // Live transcript
    if (m.type === "transcript" && m.transcriptType === "final") {
      appendTranscript(m.role, m.transcript);
    }

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
    const raw = (e?.error?.message || e?.message || JSON.stringify(e) || "").toString();
    let msg = "Something went wrong with the call. Please try again.";
    if (raw.includes("NotAllowedError") || raw.toLowerCase().includes("permission")) {
      msg = "Microphone access is required. Please allow your mic and try again.";
    } else if (raw.toLowerCase().includes("notfound")) {
      msg = "No microphone found. Plug one in and try again.";
    }
    inCall = false;
    callControls.className = "call-controls";
    setStatus("⚠️", "error", "Error", msg, "error");
    retryBtn.className = "retry-btn show";
    showStartButtonLoading(false);
  });
}

// ─── Form / control handlers ─────────────────────────────────────────────────
startBtn.addEventListener("click", async () => {
  if (!vapi || !PUBLIC_KEY || !ASSISTANT_ID) {
    statusCard.style.display = "block";
    setStatus("⚠️", "error", "Not Configured",
      "Missing VITE_VAPI_PUBLIC_KEY or VITE_VAPI_ASSISTANT_ID. Set them and rebuild.", "error");
    return;
  }

  const fullName = nameInput.value.trim();
  if (!fullName) {
    nameError.style.display = "block";
    nameInput.classList.add("error-input");
    return;
  }
  nameError.style.display = "none";
  nameInput.classList.remove("error-input");

  // Address by first name only — sounds far more natural than the full name.
  const name = fullName.split(/\s+/)[0] || fullName;

  // Reset card to a fresh connecting state
  outcome = null;
  transcript.className = "transcript";
  transcript.innerHTML = "";
  outcomeBadge.className = "outcome-badge";
  retryBtn.className = "retry-btn";
  statusCard.style.display = "block";
  setStatus("🎙️", "pending", "Connecting…", "Allow microphone access to begin.", null);
  showStartButtonLoading(true);

  try {
    await vapi.start(ASSISTANT_ID, { variableValues: { name } });
  } catch (err) {
    console.error("[vapi] start failed", err);
    setStatus("⚠️", "error", "Couldn't Start",
      "We couldn't start the call. Check your mic permission and try again.", "error");
    retryBtn.className = "retry-btn show";
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
