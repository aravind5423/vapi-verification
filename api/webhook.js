/**
 * api/webhook.js
 * ---------------------------------------------------------------------------
 * POST /api/webhook
 *
 * Receives ALL Vapi call lifecycle events and tool-call callbacks.
 *
 * Event types handled:
 *   call-started          → Mark call as in_progress
 *   tool-calls            → Modern Vapi: parse set_outcome from toolCallList
 *   function-call         → Legacy Vapi: parse set_outcome from functionCall
 *   status-update(ended)  → Finalise result using stored outcome
 *   end-of-call-report    → Finalise result using stored outcome (duplicate guard)
 *   call-ended            → Same as above
 *   call-failed           → Mark as P3_UNREACHABLE / completed
 *
 * Outcome → binary result:
 *   P1_SUCCESS    → "success"
 *   P2_VOICEMAIL  → "voicemail"  (distinct from fail — caller's choice)
 *   P3_UNREACHABLE→ "fail"
 *   P4_UNCLEAR    → "fail"
 * ---------------------------------------------------------------------------
 */

import { get, set, patch } from "../lib/outcomeStore.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function outcomeToResult(outcome) {
  if (outcome === "P1_SUCCESS")   return "success";
  if (outcome === "P2_VOICEMAIL") return "voicemail";
  return "fail";
}

function extractCallId(message) {
  return (
    message?.call?.id ??
    message?.callId ??
    message?.call_id ??
    null
  );
}

function safeParseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return {}; }
  }
  return raw;
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const body    = req.body ?? {};
  const message = body.message ?? body;
  const eventType = message?.type;
  const callId    = extractCallId(message);

  console.log(`[webhook] event=${eventType} call_id=${callId}`);

  // ── call-started ───────────────────────────────────────────────────────────
  if (eventType === "call-started") {
    if (callId) {
      await patch(callId, { status: "in_progress", startedAt: new Date().toISOString() });
    }
    return res.status(200).json({ received: true });
  }

  // ── tool-calls (modern Vapi) ───────────────────────────────────────────────
  if (eventType === "tool-calls") {
    const toolCallList = message?.toolCallList ?? [];

    for (const tool of toolCallList) {
      const name = tool?.function?.name ?? tool?.name;
      const args = safeParseArgs(tool?.function?.arguments ?? tool?.arguments ?? tool?.parameters);

      console.log(`[webhook] tool-call → name=${name} args=${JSON.stringify(args)} call_id=${callId}`);

      if (name === "set_outcome") {
        const outcome = args?.outcome ?? "P4_UNCLEAR";
        const result  = outcomeToResult(outcome);
        if (callId) await patch(callId, { outcome, result });
        console.log(`[webhook] set_outcome → ${outcome} / ${result} call_id=${callId}`);
        // Vapi requires 200 + { result } to proceed
        return res.status(200).json({ results: [{ toolCallId: tool?.id, result: outcome }] });
      }
    }

    return res.status(200).json({ results: [] });
  }

  // ── function-call (legacy Vapi) ────────────────────────────────────────────
  if (eventType === "function-call") {
    const fc   = message?.functionCall ?? message?.function_call ?? null;
    const name = fc?.name ?? fc?.function?.name ?? null;
    const args = safeParseArgs(fc?.parameters ?? fc?.arguments ?? {});

    console.log(`[webhook] function-call → name=${name} args=${JSON.stringify(args)} call_id=${callId}`);

    if (name === "set_outcome") {
      const outcome = args?.outcome ?? "P4_UNCLEAR";
      const result  = outcomeToResult(outcome);
      if (callId) await patch(callId, { outcome, result });
      console.log(`[webhook] set_outcome (legacy) → ${outcome} / ${result} call_id=${callId}`);
      return res.status(200).json({ result: outcome });
    }

    return res.status(200).json({ result: "unhandled_function" });
  }

  // ── call-ended / status-update(ended) / end-of-call-report ────────────────
  const isEndEvent =
    eventType === "call-ended" ||
    eventType === "end-of-call-report" ||
    (eventType === "status-update" && message?.status === "ended");

  if (isEndEvent) {
    if (callId) {
      const stored = (await get(callId)) ?? {};

      if (!stored.completed) {
        const outcome     = stored?.outcome ?? "P4_UNCLEAR";
        const finalResult = stored?.result  ?? outcomeToResult(outcome);
        const endedReason = message?.endedReason ?? message?.call?.endedReason ?? null;

        await set(callId, {
          ...stored,
          status: "completed",
          outcome,
          finalResult,
          completed: true,
          completedAt: new Date().toISOString(),
          endedReason,
        });

        console.log(`[webhook] call ended (${eventType}) → ${outcome} / ${finalResult} | reason=${endedReason} call_id=${callId}`);
      } else {
        console.log(`[webhook] call already completed, skipping duplicate end event (${eventType}) call_id=${callId}`);
      }
    }
    return res.status(200).json({ received: true });
  }

  // ── call-failed ────────────────────────────────────────────────────────────
  if (eventType === "call-failed") {
    if (callId) {
      const stored = (await get(callId)) ?? {};
      if (!stored.completed) {
        const failReason = message?.endedReason ?? message?.error ?? "unknown";
        await set(callId, {
          ...stored,
          status: "completed",
          outcome: "P3_UNREACHABLE",
          finalResult: "fail",
          completed: true,
          completedAt: new Date().toISOString(),
          failReason,
        });
        console.log(`[webhook] call-failed → P3_UNREACHABLE reason=${failReason} call_id=${callId}`);
      }
    }
    return res.status(200).json({ received: true });
  }

  // ── Everything else: ack silently ─────────────────────────────────────────
  return res.status(200).json({ received: true });
}
