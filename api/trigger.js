/**
 * api/trigger.js
 * ---------------------------------------------------------------------------
 * POST /api/trigger
 *
 * Accepts { name, phone_number } and fires an outbound Vapi verification call.
 * Returns { success, call_id, message } on success.
 * ---------------------------------------------------------------------------
 */

import { set } from "../lib/outcomeStore.js";

// ─── Constants ──────────────────────────────────────────────────────────────
const VAPI_API_URL = "https://api.vapi.ai/call/phone";

// ─── Build the inline assistant config ──────────────────────────────────────
function buildAssistant(name) {
  const systemPrompt = `You are a phone verification agent. Your ONLY goal is to confirm whether you have reached the correct person.

Follow this script exactly:

1. Start with: "Hi, is this ${name}?"

2. If they confirm YES (say "yes", "speaking", "that's me", etc.):
   - Say: "Perfect — thanks, just quickly confirming I've reached the right person. Have a good day."
   - End the call immediately.
   - Set outcome: P1_SUCCESS

3. If they ask "Who is this?":
   - Say: "Sure — I'm just quickly verifying I've reached ${name} before I proceed. Is this the right number for them?"
   - If they then confirm: outcome P1_SUCCESS, end call.
   - If they stay defensive or refuse: outcome P4_UNCLEAR, end call politely.

4. If they ask "Where did you get my number?":
   - Say: "I understand — we work with publicly available business contact data sources. I'm just doing a quick check to confirm I've reached the correct ${name} on this number. Can I just confirm — is this the right number for ${name}?"
   - If they confirm: P1_SUCCESS, end call.
   - If they refuse: P4_UNCLEAR, end call politely.

5. If they are hostile / refuse to confirm:
   - Say: "No problem at all — I'll make a note. Have a good day."
   - End the call. Set outcome: P4_UNCLEAR.

6. If call goes to voicemail with the person's name in the greeting:
   - Set outcome: P2_VOICEMAIL. Do NOT leave a message.

7. If number is invalid, off, or unreachable:
   - Set outcome: P3_UNREACHABLE.

OUTCOME CODES:
- P1_SUCCESS → person confirmed, verification successful
- P2_VOICEMAIL → voicemail reached (identity likely matched)
- P3_UNREACHABLE → could not connect
- P4_UNCLEAR → connected but identity unconfirmed / hostile / refused

At the end of the call, you MUST call the function "set_outcome" with the appropriate outcome code BEFORE saying goodbye or ending the call. Never hang up without calling this function first!`;

  return {
    model: {
      provider: "openai",
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
      ],
    },
    voice: {
      provider: "vapi",
      voiceId: "Elliot",
    },
    firstMessage: `Hi, is this ${name}?`,
    endCallFunctionEnabled: true,
    functions: [
      {
        name: "set_outcome",
        description:
          "Call this function at the end of the conversation to record the outcome of the verification attempt.",
        parameters: {
          type: "object",
          properties: {
            outcome: {
              type: "string",
              enum: ["P1_SUCCESS", "P2_VOICEMAIL", "P3_UNREACHABLE", "P4_UNCLEAR"],
              description: "The outcome of the verification attempt",
            },
          },
          required: ["outcome"],
        },
      },
    ],
    // Vapi will POST events to this URL
    serverUrl: `${process.env.WEBHOOK_BASE_URL}/api/webhook`,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Only accept POST
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  let { name, phone_number } = req.body ?? {};

  // ── Validate input ──────────────────────────────────────────────────────
  const missing = [];
  if (!name) missing.push("name");
  if (!phone_number) missing.push("phone_number");

  if (missing.length > 0) {
    return res.status(400).json({
      success: false,
      error: `Missing required fields: ${missing.join(", ")}`,
    });
  }

  // Clean the phone number (remove spaces, dashes, parentheses)
  phone_number = phone_number.replace(/[\s\-\(\)]/g, "");

  // Basic E.164 sanity check
  if (!/^\+\d{7,15}$/.test(phone_number)) {
    return res.status(400).json({
      success: false,
      error: "phone_number must be in E.164 format (e.g. +919876543210)",
    });
  }

  if (!process.env.VAPI_API_KEY || !process.env.VAPI_PHONE_NUMBER_ID) {
    console.error("[trigger] Missing VAPI_API_KEY or VAPI_PHONE_NUMBER_ID env vars");
    return res.status(500).json({ success: false, error: "Server misconfiguration" });
  }

  // ── Build Vapi call payload ─────────────────────────────────────────────
  const payload = {
    phoneNumberId: process.env.VAPI_PHONE_NUMBER_ID,
    customer: {
      number: phone_number,
      name: name,
    },
    assistant: buildAssistant(name),
  };

  // ── Fire the Vapi call ──────────────────────────────────────────────────
  let vapiResponse;
  try {
    const response = await fetch(VAPI_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VAPI_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error("[trigger] Vapi API error:", response.status, responseText);
      return res.status(502).json({
        success: false,
        error: `Vapi API returned ${response.status}`,
        detail: responseText,
      });
    }

    vapiResponse = JSON.parse(responseText);
  } catch (err) {
    console.error("[trigger] Network error calling Vapi:", err);
    return res.status(502).json({
      success: false,
      error: "Failed to reach Vapi API",
      detail: err.message,
    });
  }

  const callId = vapiResponse?.id;
  if (!callId) {
    console.error("[trigger] Vapi response missing call ID:", vapiResponse);
    return res.status(502).json({
      success: false,
      error: "Vapi did not return a call ID",
    });
  }

  // ── Persist initial call record ─────────────────────────────────────────
  await set(callId, {
    callId,
    name,
    phone_number,
    status: "pending",
    outcome: null,
    result: null,
    completed: false,
    createdAt: new Date().toISOString(),
  });

  console.log(`[trigger] Call initiated — call_id=${callId} name=${name} number=${phone_number}`);

  return res.status(200).json({
    success: true,
    call_id: callId,
    message: "Verification call initiated",
  });
}
