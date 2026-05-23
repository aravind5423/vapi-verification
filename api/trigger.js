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

Follow this script EXACTLY — do not improvise:

STEP 1 — Opening:
Say: "Hi, is this ${name}?"

STEP 2A — If they confirm YES (say "yes", "speaking", "that's me", "correct", etc.):
Say: "Perfect — thanks, just quickly confirming I've reached the right person. Have a good day."
Then IMMEDIATELY call set_outcome with outcome="P1_SUCCESS", then end the call.

STEP 2B — If they ask "Who is this?":
Say: "Sure — I'm just quickly verifying I've reached ${name} before I proceed. Is this the right number for them?"
  - If they then confirm → call set_outcome with outcome="P1_SUCCESS", say "Perfect, have a good day." then end the call.
  - If they stay defensive or refuse → call set_outcome with outcome="P4_UNCLEAR", say "No problem at all — I'll make a note. Have a good day." then end the call.

STEP 2C — If they ask "Where did you get my number?":
Say: "I understand — we work with publicly available business contact data sources. I'm just doing a quick check to confirm I've reached the correct ${name} on this number. Can I just confirm — is this the right number for ${name}?"
  - If they confirm → call set_outcome with outcome="P1_SUCCESS", say "Perfect, have a good day." then end the call.
  - If they refuse → call set_outcome with outcome="P4_UNCLEAR", say "No problem at all — I'll make a note. Have a good day." then end the call.

STEP 2D — If they are hostile, refuse to confirm, or say wrong number:
Say: "No problem at all — I'll make a note. Have a good day."
Then call set_outcome with outcome="P4_UNCLEAR", then end the call.

STEP 2E — If the call goes to voicemail and the greeting includes "${name}":
Call set_outcome with outcome="P2_VOICEMAIL". Do NOT leave a message. End the call.

STEP 2F — If the number is invalid, off, or unreachable:
Call set_outcome with outcome="P3_UNREACHABLE".

OUTCOME CODES (MANDATORY — you MUST call set_outcome with one of these before ending EVERY call):
- P1_SUCCESS → person confirmed identity, verification successful
- P2_VOICEMAIL → voicemail with name match
- P3_UNREACHABLE → could not connect at all
- P4_UNCLEAR → connected but identity unconfirmed / hostile / refused

⚠️ CRITICAL RULE: You MUST call the set_outcome tool BEFORE you say goodbye or end the call. This is mandatory. Never end a call without first calling set_outcome.`;

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
      // Modern Vapi tools format (replaces legacy 'functions')
      tools: [
        {
          type: "function",
          function: {
            name: "set_outcome",
            description:
              "MANDATORY: Call this function to record the verification outcome BEFORE ending the call. You must call this every single time before saying goodbye.",
            parameters: {
              type: "object",
              properties: {
                outcome: {
                  type: "string",
                  enum: ["P1_SUCCESS", "P2_VOICEMAIL", "P3_UNREACHABLE", "P4_UNCLEAR"],
                  description:
                    "P1_SUCCESS=confirmed identity, P2_VOICEMAIL=voicemail matched, P3_UNREACHABLE=no connection, P4_UNCLEAR=refused/unclear",
                },
              },
              required: ["outcome"],
            },
          },
        },
        {
          type: "endCall",
        },
      ],
    },
    voice: {
      provider: "vapi",
      voiceId: "Elliot",
    },
    firstMessage: `Hi, is this ${name}?`,
    endCallFunctionEnabled: true,
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
