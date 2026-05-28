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
  // Address the person by first name only — sounds far more natural on a call
  // than repeating their full name. Full name is still kept as Vapi metadata.
  const firstName = name.trim().split(/\s+/)[0] || name;

  const systemPrompt = `You are a concise phone verification agent. Your only job is to confirm you have reached the correct person. You must follow this script exactly with NO improvisation and NO extra conversation.

---
OPENING (always start with this):
Say exactly: "Hi, is this ${firstName}?"

---
RESPONSE HANDLING — After the opening, ONE of these scenarios will occur:

SCENARIO A — They say yes / speaking / correct / that's me / yep / sure:
  1. Say: "Perfect — thanks, just quickly confirming I've reached the right person. Have a good day."
  2. Call set_outcome(outcome="P1_SUCCESS")
  3. Call endCall immediately. STOP. Do not say anything else.

SCENARIO B — They ask "Who is this?" or "Who's calling?":
  1. Say: "Sure — I'm just quickly verifying I've reached ${firstName} before I proceed. Is this the right number for them?"
  2. Wait for ONE response only:
     - If they say yes/confirm → say "Perfect, have a good day." → call set_outcome(outcome="P1_SUCCESS") → call endCall. STOP.
     - If they refuse/unclear → say "No problem at all — I'll make a note. Have a good day." → call set_outcome(outcome="P4_UNCLEAR") → call endCall. STOP.

SCENARIO C — They ask "Where did you get my number?":
  1. Say: "I understand — we work with publicly available business contact data sources. I'm just doing a quick check to confirm I've reached the correct ${firstName} on this number. Can I just confirm — is this the right number for ${firstName}?"
  2. Wait for ONE response only:
     - If they say yes/confirm → say "Perfect, have a good day." → call set_outcome(outcome="P1_SUCCESS") → call endCall. STOP.
     - If they refuse/unclear → say "No problem at all — I'll make a note. Have a good day." → call set_outcome(outcome="P4_UNCLEAR") → call endCall. STOP.

SCENARIO D — They are rude, hostile, or refuse immediately:
  1. Say: "No problem at all — I'll make a note. Have a good day."
  2. Call set_outcome(outcome="P4_UNCLEAR")
  3. Call endCall. STOP.

SCENARIO E — Call goes to voicemail with "${firstName}" or "${name}" in the greeting:
  1. Call set_outcome(outcome="P2_VOICEMAIL")
  2. Call endCall. Do NOT leave a message. STOP.

SCENARIO F — Number is unreachable / invalid / off:
  1. Call set_outcome(outcome="P3_UNREACHABLE")
  2. Call endCall. STOP.

---
⚠️ ABSOLUTE RULES — violation is not permitted:
1. You MUST call set_outcome before ending every call. No exceptions.
2. After saying your goodbye line, you MUST immediately call set_outcome then endCall. You must NOT say anything further after the goodbye line.
3. You handle exactly ONE exchange per scenario. Do not re-ask questions or continue the conversation beyond what is scripted above.
4. Do not apologise, explain yourself further, or add pleasantries beyond what is scripted.`;

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
    firstMessage: `Hi, is this ${firstName}?`,
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
