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

import { get } from "../lib/outcomeStore.js";

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
