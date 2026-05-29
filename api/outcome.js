// Vercel serverless function — server-side outcome resolver (the safety net's
// delivery path to the browser).
//
// The live UI normally gets the result from the in-call `set_outcome` tool. On
// the rare occasion the model skips it, the page calls this endpoint with the
// call id; we read Vapi's AUTHORITATIVE result server-side and return just the
// P-code. Two sources, in order of trust:
//   1) an explicit set_outcome tool call in the call's message log
//   2) the post-call transcript analysis (analysisPlan.structuredDataPlan)
//
// The Vapi PRIVATE key lives in a server env var here (never bundled to the
// client). This endpoint only ever returns a P-code — no transcript, no PII.

const OUTCOME_ENUM = new Set([
  "P1_SUCCESS", "P2_VOICEMAIL", "P3_UNREACHABLE", "P4_DECLINED", "P5_WRONG_PERSON", "P6_UNCLEAR",
]);

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

  // 1) Most trustworthy: an explicit set_outcome tool call from the transcript.
  const fromTool = extractFromMessages(call?.messages);
  if (fromTool) return res.status(200).json({ outcome: fromTool, source: "tool" });

  // 2) Fallback: the server-side transcript analysis.
  const fromAnalysis = call?.analysis?.structuredData?.outcome;
  if (typeof fromAnalysis === "string" && OUTCOME_ENUM.has(fromAnalysis)) {
    return res.status(200).json({ outcome: fromAnalysis, source: "analysis" });
  }

  // 3) Nothing yet. Tell the client whether it's worth polling again: if the call
  //    has ended but the analysis hasn't produced structuredData, it's still
  //    being generated → pending. Otherwise we genuinely can't classify it.
  const ended = call?.status === "ended" || Boolean(call?.endedAt);
  const analysisDone = call?.analysis && Object.prototype.hasOwnProperty.call(call.analysis, "structuredData");
  return res.status(200).json({ outcome: null, pending: !ended || !analysisDone });
}

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
      if (typeof o === "string" && OUTCOME_ENUM.has(o)) return o;
    }
  }
  return null;
}

function safeParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
