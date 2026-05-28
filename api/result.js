/**
 * api/result.js
 * ---------------------------------------------------------------------------
 * GET /api/result?call_id=<vapi-call-id>
 *
 * Polling endpoint. Response shapes:
 *   { status: "not_found" }
 *   { status: "pending", call_id, current_status }
 *   { status: "completed", result: "success"|"voicemail"|"fail", outcome, name, phone_number }
 *
 * Source of truth = Vapi. When the local store doesn't yet have a completed
 * record, we ask Vapi directly and read the outcome the assistant recorded
 * (the set_outcome tool call) from the call object. This keeps results correct
 * even if the webhook was missed OR the in-memory store didn't persist across
 * serverless instances (i.e. no Redis configured).
 * ---------------------------------------------------------------------------
 */

import { get, set } from "../lib/outcomeStore.js";

// Map Vapi's endedReason to an outcome code (last-resort guess when the
// assistant never recorded an explicit outcome).
function reasonToOutcome(reason = "") {
  const r = reason.toLowerCase();
  if (r.includes("voicemail"))       return "P2_VOICEMAIL";
  if (r.includes("no-answer"))       return "P3_UNREACHABLE";
  if (r.includes("busy"))            return "P3_UNREACHABLE";
  if (r.includes("error") || r.includes("timeout") || r.includes("failed") || r.includes("sip")) return "P3_UNREACHABLE";
  return "P4_UNCLEAR"; // connected but the assistant left no explicit outcome
}

function outcomeToResult(outcome) {
  if (outcome === "P1_SUCCESS")    return "success";
  if (outcome === "P2_VOICEMAIL")  return "voicemail";
  return "fail";
}

function safeParse(raw) {
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// Recursively locate the set_outcome tool call inside a Vapi call object and
// return the outcome code the assistant chose. Only matches actual tool CALLS
// (which carry `arguments`), never the tool DEFINITION or the system prompt.
function extractOutcome(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 10) return null;

  const fn = node.function ?? node;
  const name = fn?.name ?? node?.name;
  if (name === "set_outcome") {
    const args = safeParse(fn?.arguments ?? node?.arguments);
    const oc = args?.outcome;
    if (typeof oc === "string" && /^P[1-4]_/.test(oc)) return oc;
  }

  const children = Array.isArray(node) ? node : Object.values(node);
  for (const child of children) {
    const found = extractOutcome(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { call_id } = req.query;
  if (!call_id) {
    return res.status(400).json({ error: "Missing required query param: call_id" });
  }

  const data = (await get(call_id)) ?? null;

  // ── Fast path: store already has a completed record (works when Redis is on) ──
  if (data?.completed) {
    return res.status(200).json({
      status:       "completed",
      call_id,
      result:       data.finalResult ?? data.result ?? "fail",
      outcome:      data.outcome ?? null,
      name:         data.name,
      phone_number: data.phone_number,
      completedAt:  data.completedAt,
      endedReason:  data.endedReason ?? data.failReason ?? null,
    });
  }

  // ── Otherwise ask Vapi directly (source of truth) ───────────────────────────
  try {
    const vapiRes = await fetch(`https://api.vapi.ai/call/${call_id}`, {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
    });

    if (vapiRes.ok) {
      const vapiCall = await vapiRes.json();

      if (vapiCall.status === "ended") {
        const reason = vapiCall.endedReason ?? "";
        // Prefer the outcome the assistant actually recorded; then the stored
        // value; then a best-guess from the ended reason.
        const outcome = extractOutcome(vapiCall) ?? data?.outcome ?? reasonToOutcome(reason);
        const result  = outcomeToResult(outcome);
        const name         = data?.name         ?? vapiCall.customer?.name   ?? null;
        const phone_number = data?.phone_number ?? vapiCall.customer?.number ?? null;

        // Best-effort persist (harmless no-op if the store is non-persistent).
        await set(call_id, {
          ...(data ?? {}),
          callId: call_id,
          name,
          phone_number,
          status:      "completed",
          outcome,
          finalResult: result,
          completed:   true,
          completedAt: new Date().toISOString(),
          endedReason: reason,
          syncedFromVapi: true,
        });

        console.log(`[result] completed via Vapi — call_id=${call_id} outcome=${outcome} reason=${reason}`);

        return res.status(200).json({
          status:       "completed",
          call_id,
          result,
          outcome,
          name,
          phone_number,
          endedReason:  reason,
        });
      }

      // Vapi knows the call but it hasn't ended yet → still in progress
      return res.status(200).json({
        status:         "pending",
        call_id,
        current_status: vapiCall.status ?? data?.status ?? "pending",
      });
    }

    // Vapi doesn't know this call id (and we have nothing locally)
    if (vapiRes.status === 404 && !data) {
      return res.status(404).json({ status: "not_found", call_id });
    }
  } catch (e) {
    console.error("[result] Vapi sync failed:", e.message);
  }

  // ── Couldn't reach Vapi ─────────────────────────────────────────────────────
  if (data) {
    return res.status(200).json({ status: "pending", call_id, current_status: data.status ?? "pending" });
  }
  return res.status(404).json({ status: "not_found", call_id });
}
