#!/usr/bin/env node
/**
 * scripts/diagnose-last-call.mjs
 * ---------------------------------------------------------------------------
 * Pull the most recent web call(s) for the assistant from the Vapi API and
 * print what actually happened: end reason, transcript, and every tool call
 * (so we can see whether set_outcome was invoked, spoken, or never reached).
 *
 * Reads VAPI_PRIVATE_KEY from the environment OR from .env.local (gitignored).
 * NEVER prints the key.
 *
 *   node scripts/diagnose-last-call.mjs [limit]
 * ---------------------------------------------------------------------------
 */
import { readFileSync } from "node:fs";
import { classify } from "../api/classify.js";

function envFromLocal(name) {
  if (process.env[name]) return process.env[name];
  try {
    const txt = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    const line = txt.split(/\r?\n/).find((l) => l.startsWith(name + "="));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : undefined;
  } catch {
    return undefined;
  }
}

const KEY = envFromLocal("VAPI_PRIVATE_KEY");
const ASSISTANT_ID = envFromLocal("VITE_VAPI_ASSISTANT_ID") || envFromLocal("VAPI_ASSISTANT_ID");
// Make the classifier's DeepSeek key available (if set) so the printed verdict
// uses the full ensemble; without it, the verdict comes from the heuristic floor.
if (!process.env.DEEPSEEK_API_KEY) {
  const dk = envFromLocal("DEEPSEEK_API_KEY");
  if (dk) process.env.DEEPSEEK_API_KEY = dk;
}
// Validate the CLI arg: a non-numeric / <=0 / huge value falls back to a sane 3,
// clamped to 100 (Vapi's max page size) so we never send "NaN" or an absurd limit.
const argN = Number(process.argv[2]);
const LIMIT = Number.isFinite(argN) && argN > 0 ? Math.min(Math.floor(argN), 100) : 3;

if (!KEY) {
  console.error("✗ VAPI_PRIVATE_KEY not found (set it in the env or add it to .env.local).");
  process.exit(1);
}

const url = new URL("https://api.vapi.ai/call");
if (ASSISTANT_ID) url.searchParams.set("assistantId", ASSISTANT_ID);
url.searchParams.set("limit", String(LIMIT));

let res;
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 30000);
try {
  res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` }, signal: ctrl.signal });
} catch (err) {
  const why = err?.name === "AbortError" ? "request timed out after 30s" : (err?.message || String(err));
  console.error(`✗ Could not reach the Vapi API (${why}).`);
  process.exit(1);
} finally {
  clearTimeout(timer);
}
if (!res.ok) {
  console.error(`✗ Vapi API ${res.status}:`, await res.text());
  process.exit(1);
}
let calls;
try {
  calls = await res.json();
} catch (err) {
  console.error("✗ Vapi API returned a non-JSON response:", err?.message || err);
  process.exit(1);
}
if (!Array.isArray(calls) || calls.length === 0) {
  console.log("No calls found for this assistant.");
  process.exit(0);
}

const fmt = (v) => (v == null ? "—" : typeof v === "string" ? v : JSON.stringify(v));

for (const [i, c] of calls.entries()) {
  console.log("\n" + "═".repeat(76));
  console.log(`CALL #${i + 1}  id=${c.id}`);
  console.log(`  type:          ${fmt(c.type)}`);
  console.log(`  status:        ${fmt(c.status)}`);
  console.log(`  endedReason:   ${fmt(c.endedReason)}`);
  console.log(`  created:       ${fmt(c.createdAt)}`);
  console.log(`  started:       ${fmt(c.startedAt)}`);
  console.log(`  ended:         ${fmt(c.endedAt)}`);
  if (c.startedAt && c.endedAt) {
    const secs = (new Date(c.endedAt) - new Date(c.startedAt)) / 1000;
    console.log(`  duration:      ${Number.isFinite(secs) ? secs.toFixed(1) + "s" : "—"}`);
  }
  console.log(`  assistantId:   ${fmt(c.assistantId)}`);

  // Tool calls live inside the message log. Surface every one.
  const msgs = Array.isArray(c.messages) ? c.messages : [];
  const toolCalls = [];
  for (const m of msgs) {
    const tcs = m.toolCalls || m.tool_calls || (m.toolCallList ?? []);
    for (const t of tcs || []) {
      toolCalls.push({ name: t?.function?.name ?? t?.name, args: t?.function?.arguments ?? t?.arguments });
    }
    // legacy single function-call shape
    if (m.functionCall || m.function_call) {
      const f = m.functionCall || m.function_call;
      toolCalls.push({ name: f.name, args: f.arguments ?? f.parameters });
    }
  }
  console.log(`  TOOL CALLS:    ${toolCalls.length === 0 ? "NONE  ← set_outcome was never invoked" : ""}`);
  toolCalls.forEach((t) => console.log(`     • ${t.name}  ${fmt(t.args)}`));

  // Structured analysis Vapi may attach.
  if (c.analysis) {
    console.log(`  analysis.summary:        ${fmt(c.analysis.summary)}`);
    console.log(`  analysis.successEval:    ${fmt(c.analysis.successEvaluation)}`);
    console.log(`  analysis.structuredData: ${fmt(c.analysis.structuredData)}`);
  }

  console.log("  ── transcript ──");
  console.log(
    c.transcript
      ? c.transcript.split(/\r?\n/).map((l) => "    " + l).join("\n")
      : "    (no transcript)"
  );

  // What our authoritative classifier (api/classify.js) would decide for this call.
  const liveOutcome = toolCalls.find((t) => t.name === "set_outcome")?.args;
  const live = typeof liveOutcome === "string" ? (() => { try { return JSON.parse(liveOutcome)?.outcome; } catch { return liveOutcome; } })() : liveOutcome?.outcome;
  const durationSec = c.startedAt && c.endedAt ? (new Date(c.endedAt) - new Date(c.startedAt)) / 1000 : undefined;
  try {
    const verdict = await classify({ transcript: c.transcript, endedReason: c.endedReason, durationSec, liveOutcome: live });
    console.log(`  ▶ CLASSIFIER:  ${verdict.code}  (source=${verdict.source}, confidence=${verdict.confidence})${live && live !== verdict.code ? `  [live set_outcome was ${live}]` : ""}`);
  } catch (err) {
    console.log(`  ▶ CLASSIFIER:  (failed: ${err?.message || err})`);
  }
}

console.log("\n" + "═".repeat(76));
