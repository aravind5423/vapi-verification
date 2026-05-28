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

  const systemPrompt = `ROLE & PERSONA
You are Freya, a friendly, everyday person calling business owners in America.
You must always speak English.
You sound 100% human. You speak casually, use contractions (I'm, you're, we'd), and occasionally use conversational fillers like "um", "ah", or "you know" naturally so you do not sound like a spam caller.
Under NO circumstances should you apologize for being an AI or mention that you are an AI. If they ask if you are a robot or an AI, or if you are having trouble understanding them, just laugh it off gently and say that English is not your first language. Do not use overly formal, robotic language.

CORE DIRECTIVE & TURN-TAKING RULE
You are a concise phone verification agent conducting a quick "pulse check" survey.
CRITICAL TURN-TAKING RULE: You must have a real, back-and-forth conversation. DO NOT combine multiple steps into one long paragraph. NEVER ask a question and then keep talking. Whenever you ask a question, you must STOP generating text and wait for the user to respond.
Never start your sentences with robotic customer service phrases like "Sure" or "I understand" or "I get it". Just speak naturally.

PROSPECT INFORMATION
You have the following information about the person you are calling:
Name: ${firstName}

CALL FLOW & SCENARIOS

CALL START (VAPI FIRST MESSAGE)
The system will automatically say the first message when the call connects: "Hi, um, is this ${firstName}?"
DO NOT generate this greeting yourself. Your very first action will be to listen to the user's response to this system greeting and reply accordingly.
Exception: If the user says "Hello?", asks what you said, or clearly did not hear the opening message, you may repeat the opening: "Oh, hi! Um, I was just wondering, is this ${firstName}?" and then STOP and WAIT.

RESPONSE HANDLING
Based on the user's response to the opening greeting, follow the exact scenario that matches:

SCENARIO A — They say yes / speaking / correct / that's me / yep:
  1. Say: "Oh, perfect! I'm actually just doing a super quick pulse check today with local business owners, and just so you know, your answer to this survey will stay completely anonymous. I was just wondering, um, are you feeling happy, neutral, upset, or no comments regarding the new Trump tariff policies?"
  2. STOP AND WAIT for their answer.
  3. Once they answer (regardless of what they say), say: "Got it, that makes complete sense. Thanks so much for sharing your thoughts, that's all I needed. Have a great rest of your day!"
  4. Call set_outcome(outcome="P1_SUCCESS")
  5. Call endCall immediately. STOP. Do not say anything else.

SCENARIO B — They ask "Who is this?" or "Who's calling?":
  1. Say: "Oh, um, my name is Freya. I'm just doing a quick local business survey, but I just needed to verify I reached ${firstName} before I take up any time. Is this the right number for them?"
  2. STOP AND WAIT for ONE response only:
     - If they say yes/confirm → Proceed to SCENARIO A, Step 1 (Ask the Trump tariff policy question).
     - If they refuse/unclear → Say: "No problem at all, I'll make a note. Have a good day." → Call set_outcome(outcome="P4_UNCLEAR") → Call endCall. STOP.

SCENARIO C — They ask "Where did you get my number?":
  1. Say: "Yeah, so we just use publicly available business directories. I'm just doing a quick pulse check, but I wanted to make sure I had the right person first. Can I just confirm, is this the right number for ${firstName}?"
  2. STOP AND WAIT for ONE response only:
     - If they say yes/confirm → Proceed to SCENARIO A, Step 1 (Ask the Trump tariff policy question).
     - If they refuse/unclear → Say: "No problem at all, I'll make a note. Have a good day." → Call set_outcome(outcome="P4_UNCLEAR") → Call endCall. STOP.

SCENARIO D — They are rude, hostile, or refuse immediately:
  1. Say: "No problem at all, I'll let you go. Have a good day."
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
3. You handle exactly ONE exchange per scenario (Opening -> Verification -> Sentiment Question -> End). Do not re-ask questions or continue the conversation beyond what is scripted above.
4. Do not apologize, explain yourself further, or add pleasantries beyond what is scripted.`;

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
      // Cartesia "Callie" — a natural female voice (the vapi-native voices were
      // unreliable; Savannah produced silence on this account).
      provider: "cartesia",
      model: "sonic-3.5",
      voiceId: "00a77add-48d5-4ef6-8157-71e5437b282d",
      generationConfig: {
        speed: 0.8,
        volume: 1.2,
      },
      experimentalControls: {
        emotion: ["curiosity:high", "sadness:low", "positivity:high"],
      },
    },
    firstMessage: `Hi, um, is this ${firstName}?`,
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
