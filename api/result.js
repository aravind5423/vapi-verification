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
 * Fallback: if the record is pending but Vapi shows the call as ended (missed
 * webhook), we sync directly with Vapi and force-complete the record.
 * ---------------------------------------------------------------------------
 */

import { get, set } from "../lib/outcomeStore.js";

// Map Vapi's endedReason to an outcome code when webhook was missed
function reasonToOutcome(reason = "") {
  const r = reason.toLowerCase();
  if (r.includes("customer-ended-call") || r.includes("assistant-ended-call")) return "P4_UNCLEAR";
  if (r.includes("voicemail"))       return "P2_VOICEMAIL";
  if (r.includes("no-answer"))       return "P3_UNREACHABLE";
  if (r.includes("busy"))            return "P3_UNREACHABLE";
  if (r.includes("error") || r.includes("timeout") || r.includes("failed") || r.includes("sip")) return "P3_UNREACHABLE";
  return "P4_UNCLEAR"; // call connected but outcome unknown
}

function outcomeToResult(outcome) {
  if (outcome === "P1_SUCCESS")    return "success";
  if (outcome === "P2_VOICEMAIL")  return "voicemail";
  return "fail";
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { call_id } = req.query;
  if (!call_id) {
    return res.status(400).json({ error: "Missing required query param: call_id" });
  }

  const data = await get(call_id);

  if (!data) {
    return res.status(404).json({ status: "not_found", call_id });
  }

  // ── Already completed ─────────────────────────────────────────────────────
  if (data.completed) {
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

  // ── Still pending — sync with Vapi to catch missed webhooks ──────────────
  try {
    const vapiRes = await fetch(`https://api.vapi.ai/call/${call_id}`, {
      headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` },
    });

    if (vapiRes.ok) {
      const vapiCall = await vapiRes.json();

      if (vapiCall.status === "ended") {
        // Webhook was missed. Derive outcome from endedReason.
        const reason  = vapiCall.endedReason ?? "";
        const outcome = data.outcome ?? reasonToOutcome(reason);
        const result  = data.result  ?? outcomeToResult(outcome);

        const completed = {
          ...data,
          status:      "completed",
          outcome,
          finalResult: result,
          completed:   true,
          completedAt: new Date().toISOString(),
          endedReason: reason,
          syncedFromVapi: true,
        };
        await set(call_id, completed);

        console.log(`[result] Forced completion via Vapi sync — call_id=${call_id} reason=${reason} outcome=${outcome}`);

        return res.status(200).json({
          status:       "completed",
          call_id,
          result,
          outcome,
          name:         data.name,
          phone_number: data.phone_number,
          completedAt:  completed.completedAt,
          endedReason:  reason,
        });
      }
    }
  } catch (e) {
    console.error("[result] Vapi sync check failed:", e.message);
  }

  // ── Still in progress ─────────────────────────────────────────────────────
  return res.status(200).json({
    status:         "pending",
    call_id,
    current_status: data.status ?? "pending",
  });
}
