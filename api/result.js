/**
 * api/result.js
 * ---------------------------------------------------------------------------
 * GET /api/result?call_id=<vapi-call-id>
 *
 * Polling endpoint — returns the current state of a verification call.
 *
 * Response shapes:
 *   { status: "not_found" }
 *   { status: "pending",   call_id }
 *   { status: "completed", result: "success"|"fail", outcome: "P1_SUCCESS"|… }
 * ---------------------------------------------------------------------------
 */

import { get, set } from "../lib/outcomeStore.js";

export default async function handler(req, res) {
  // Only accept GET
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

  if (!data.completed) {
    try {
      // Sync with Vapi to catch silent failures (e.g. SIP timeouts) where Vapi
      // marks the call as 'ended' but fails to send the webhook.
      const vapiRes = await fetch(`https://api.vapi.ai/call/${call_id}`, {
        headers: { Authorization: `Bearer ${process.env.VAPI_API_KEY}` }
      });
      if (vapiRes.ok) {
        const vapiCall = await vapiRes.json();
        if (vapiCall.status === "ended") {
          console.log(`[result] Vapi shows call ${call_id} ended (${vapiCall.endedReason}), but webhook was missed. Forcing completion.`);
          
          const reason = vapiCall.endedReason || "";
          const isErrorOrTimeout = reason.includes("error") || reason.includes("timeout") || reason.includes("failed");
          
          data.completed = true;
          data.outcome = isErrorOrTimeout ? "P3_UNREACHABLE" : "P4_UNCLEAR"; 
          data.finalResult = "fail";
          data.failReason = reason || "silent_drop";
          
          await set(call_id, data);
          
          return res.status(200).json({
            status: "completed",
            call_id,
            result: data.finalResult,
            outcome: data.outcome,
            name: data.name,
            phone_number: data.phone_number,
            failReason: data.failReason
          });
        }
      }
    } catch (e) {
      console.error("[result] Vapi sync check failed", e);
    }

    return res.status(200).json({
      status: "pending",
      call_id,
      current_status: data.status ?? "pending",
    });
  }

  return res.status(200).json({
    status: "completed",
    call_id,
    result: data.finalResult ?? data.result ?? "fail",
    outcome: data.outcome ?? null,
    name: data.name,
    phone_number: data.phone_number,
    completedAt: data.completedAt,
  });
}
