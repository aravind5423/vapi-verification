// Vercel serverless function — the AUTHORITATIVE server-side outcome resolver.
//
// The browser shows the live in-call `set_outcome` instantly for UX, but that tool
// is probabilistic (dropped ~25% of the time) and sometimes semantically wrong
// (e.g. it marks a confirmed-but-busy person as P1_SUCCESS). This endpoint is the
// source of truth: given a callId, it fetches the call from Vapi and runs OUR OWN
// classifier (api/classify.js) over the always-available transcript + endedReason,
// returning the correct P-code. The client reconciles its card to this result.
//
// The Vapi PRIVATE key lives in a server env var here (never bundled to the client).
// This endpoint only ever returns a P-code + metadata — no transcript, no PII.

import { heuristicEndReason, classifyWithFullPrompt } from "./classify.js";
import { resolve, extractFacts } from "./resolve.js";
import { isValidOutcome, isDisplayable } from "../src/outcomes.js";

export default async function handler(req, res) {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) {
    return res.status(500).json({ error: "Server not configured (VAPI_PRIVATE_KEY missing)." });
  }

  const callId = String(req.query?.callId ?? "").trim();
  // Vapi call ids are UUID-shaped. Validate strictly so this can only ever hit
  // api.vapi.ai/call/<uuid> (no SSRF / path injection via the query param).
  if (!/^[0-9a-fA-F-]{20,40}$/.test(callId)) {
    return res.status(400).json({ error: "Invalid callId." });
  }

  let resp;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      resp = await fetch(`https://api.vapi.ai/call/${callId}`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(t);
    }
  } catch {
    return res.status(502).json({ error: "Could not reach Vapi." });
  }

  if (!resp.ok) return res.status(502).json({ error: `Vapi returned ${resp.status}.` });

  let call;
  try {
    call = await resp.json();
  } catch {
    return res.status(502).json({ error: "Bad response from Vapi." });
  }

  const ended = call?.status === "ended" || Boolean(call?.endedAt);
  const transcript = typeof call?.transcript === "string" ? call.transcript : "";
  const endedReason = call?.endedReason || "";

  // PENDING — tell the client to poll again:
  //  • the call hasn't ended yet, OR
  //  • it ended but the transcript hasn't been populated by Vapi yet AND the end
  //    reason isn't one we can classify without a transcript (silence/voicemail).
  //    This grace window stops a talkative call from being momentarily misread as
  //    "unreachable" before its transcript lands (it populates within a few sec).
  const terminalWithoutTranscript = Boolean(heuristicEndReason(endedReason, transcript));
  if (!ended || (!transcript.trim() && !terminalWithoutTranscript)) {
    return res.status(200).json({ outcome: null, pending: true });
  }

  const liveOutcome = extractFromMessages(call?.messages);

  // ─── AUTHORITATIVE: the deterministic resolver ──────────────────────────────
  // Atomic facts (explicit fact tool calls, else derived from the transcript) +
  // endedReason → exactly one definite P-code. No LLM guessing, no abstention.
  let result;
  try {
    result = resolve({ facts: extractFacts(call?.messages), transcript, endedReason });
  } catch {
    return res.status(502).json({ error: "Resolution failed." });
  }
  if (!result || !isDisplayable(result.code)) {
    return res.status(200).json({ outcome: null, pending: false });
  }

  // ─── Side-by-side comparison signals (debug panel only — never override the resolver)
  // gpt4o = live set_outcome; vapi = Vapi's post-call analysis; deepseek = a fresh
  // full-prompt DeepSeek pick.
  let compare = null;
  try {
    const gpt4o = liveOutcome;
    const vapiRaw = call?.analysis?.structuredData?.outcome;
    const vapi = isValidOutcome(vapiRaw) ? vapiRaw : null;
    let deepseek = null;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    if (deepseekKey) {
      const agentPrompt = await fetchAgentPrompt(call, key);
      const ds = await classifyWithFullPrompt({ key: deepseekKey, transcript, agentPrompt });
      deepseek = ds?.code ?? null;
    }
    compare = { gpt4o, vapi, deepseek };
  } catch { /* compare is best-effort */ }

  return res.status(200).json({
    outcome: result.code,
    source: result.source,
    confidence: result.confidence,
    reason: result.reason,
    compare,
  });
}

// Retrieve the calling agent's full system prompt — preferably from the call's
// embedded assistant snapshot, else by fetching the assistant by id. Used to give
// the DeepSeek comparison the COMPLETE agent instructions.
async function fetchAgentPrompt(call, vapiKey) {
  const sysOf = (a) => a?.model?.messages?.find((m) => m?.role === "system")?.content || null;
  const snapshot = sysOf(call?.assistant);
  if (snapshot) return snapshot;
  const id = call?.assistantId;
  if (!id || !/^[0-9a-fA-F-]{20,40}$/.test(id)) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(`https://api.vapi.ai/assistant/${id}`, {
        headers: { Authorization: `Bearer ${vapiKey}` },
        signal: ctrl.signal,
      });
      if (!r.ok) return null;
      return sysOf(await r.json());
    } finally {
      clearTimeout(t);
    }
  } catch {
    return null;
  }
}

// Pull any explicit set_outcome the in-call model emitted, from the call's message
// log. Used only as a hint to the classifier (and surfaced for debugging).
function extractFromMessages(messages) {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    const tcs = m?.toolCalls || m?.tool_calls || [];
    if (!Array.isArray(tcs)) continue;
    for (const t of tcs) {
      const name = t?.function?.name ?? t?.name;
      if (name !== "set_outcome") continue;
      const rawArgs = t?.function?.arguments ?? t?.arguments;
      const args = typeof rawArgs === "string" ? safeParse(rawArgs) : rawArgs;
      const o = args?.outcome;
      if (isValidOutcome(o)) return o;
    }
  }
  return null;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
