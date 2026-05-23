/**
 * api/webhook.js
 * ---------------------------------------------------------------------------
 * POST /api/webhook
 *
 * Receives Vapi call lifecycle events and function-call callbacks.
 *
 * Handled event types:
 *   ┌─────────────────┬──────────────────────────────────────────────────────┐
 *   │ call-started    │ Mark call as in_progress                             │
 *   │ function-call   │ If name === "set_outcome", persist outcome code      │
 *   │ call-ended      │ Finalise result from stored outcome                  │
 *   │ call-failed     │ Store P3_UNREACHABLE, mark completed                 │
 *   └─────────────────┴──────────────────────────────────────────────────────┘
 *
 * Outcome → result mapping:
 *   P1_SUCCESS  → "success"
 *   P2_VOICEMAIL → "fail"   (change to "voicemail" if your product needs it)
 *   P3_UNREACHABLE → "fail"
 *   P4_UNCLEAR  → "fail"
 *
 * IMPORTANT: Vapi requires a 200 response with { result } for function-call
 * events, otherwise it retries and the assistant stalls.
 * ---------------------------------------------------------------------------
 */

import { get, set, patch } from "../lib/outcomeStore.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Map an outcome code to a binary result string. */
function outcomeToResult(outcome) {
  return outcome === "P1_SUCCESS" ? "success" : "fail";
}

/**
 * Safely extract the call ID from wherever Vapi puts it in the event body.
 * Vapi message shapes vary slightly between event types.
 */
function extractCallId(message) {
  return (
    message?.call?.id ??
    message?.callId ??
    message?.call_id ??
    null
  );
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Vapi sends the payload directly as the body (or wrapped in { message })
  const body = req.body ?? {};
  // Support both top-level and { message: … } envelope
  const message = body.message ?? body;

  const eventType = message?.type;
  const callId = extractCallId(message);

  console.log(`[webhook] event=${eventType} call_id=${callId}`);

  // ── call-started ─────────────────────────────────────────────────────────
  if (eventType === "call-started") {
    if (callId) {
      await patch(callId, { status: "in_progress", startedAt: new Date().toISOString() });
    }
    return res.status(200).json({ received: true });
  }

  // ── function-call: set_outcome ────────────────────────────────────────────
  if (eventType === "function-call") {
    const functionCall =
      message?.functionCall ?? message?.function_call ?? message?.toolCall ?? null;

    const functionName = functionCall?.name ?? functionCall?.function?.name ?? null;
    const parameters =
      functionCall?.parameters ?? functionCall?.arguments ?? {};

    // Parse stringified JSON if Vapi sends arguments as a string
    let parsedParams = parameters;
    if (typeof parameters === "string") {
      try {
        parsedParams = JSON.parse(parameters);
      } catch {
        parsedParams = {};
      }
    }

    if (functionName === "set_outcome") {
      const outcome = parsedParams?.outcome ?? "P4_UNCLEAR";
      const result = outcomeToResult(outcome);

      console.log(`[webhook] set_outcome → outcome=${outcome} result=${result} call_id=${callId}`);

      if (callId) {
        await patch(callId, { outcome, result });
      }

      // Vapi REQUIRES a 200 with { result } to acknowledge function calls
      return res.status(200).json({ result: outcome });
    }

    // Unknown function — acknowledge so Vapi doesn't retry
    return res.status(200).json({ result: "unhandled_function" });
  }

  // ── call-ended ────────────────────────────────────────────────────────────
  if (eventType === "call-ended") {
    if (callId) {
      const stored = (await get(callId)) ?? {};
      const finalResult = stored?.result ?? "fail";
      const outcome = stored?.outcome ?? "P4_UNCLEAR";

      await set(callId, {
        ...stored,
        status: "completed",
        outcome,
        finalResult,
        completed: true,
        completedAt: new Date().toISOString(),
      });

      console.log(
        `[webhook] call-ended → call_id=${callId} outcome=${outcome} finalResult=${finalResult}`
      );
    }
    return res.status(200).json({ received: true });
  }

  // ── call-failed ────────────────────────────────────────────────────────────
  if (eventType === "call-failed") {
    if (callId) {
      const stored = (await get(callId)) ?? {};
      await set(callId, {
        ...stored,
        status: "completed",
        outcome: "P3_UNREACHABLE",
        finalResult: "fail",
        completed: true,
        completedAt: new Date().toISOString(),
        failReason: message?.endedReason ?? message?.error ?? "unknown",
      });

      console.log(`[webhook] call-failed → call_id=${callId} result=fail`);
    }
    return res.status(200).json({ received: true });
  }

  // ── speech-update, transcript, hang, status-update, etc. ──────────────────
  // Acknowledge silently — we don't need to act on these
  console.log(`[webhook] unhandled event type: ${eventType}`);
  return res.status(200).json({ received: true });
}
