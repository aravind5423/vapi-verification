#!/usr/bin/env node
/**
 * scripts/dump-calls.mjs
 * ---------------------------------------------------------------------------
 * Pulls recent real calls from the Vapi API and writes each as a fixture to
 * test/fixtures/calls/<id>.json — the raw inputs the classifier needs
 * ({ id, endedReason, durationSec, liveOutcome, transcript }). scripts/
 * replay-classify.mjs then runs these through classify() for regression checks.
 *
 * Reads VAPI_PRIVATE_KEY (+ assistant id) from the env OR .env.local. Never prints
 * the key. These fixtures contain transcript text (which may include names) — they
 * live under test/ for local validation; add to .gitignore if you'd rather not
 * commit real transcripts.
 *
 *   node scripts/dump-calls.mjs [limit]
 * ---------------------------------------------------------------------------
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

function env(name) {
  if (process.env[name]) return process.env[name];
  try {
    const txt = readFileSync(join(ROOT, ".env.local"), "utf8");
    const line = txt.split(/\r?\n/).find((l) => l.startsWith(name + "="));
    return line ? line.slice(name.length + 1).trim().replace(/^["']|["']$/g, "") : undefined;
  } catch { return undefined; }
}

const KEY = env("VAPI_PRIVATE_KEY");
const ASSISTANT_ID = env("VITE_VAPI_ASSISTANT_ID") || env("VAPI_ASSISTANT_ID");
const argN = Number(process.argv[2]);
const LIMIT = Number.isFinite(argN) && argN > 0 ? Math.min(Math.floor(argN), 100) : 8;

if (!KEY) {
  console.error("✗ VAPI_PRIVATE_KEY not found (env or .env.local).");
  process.exit(1);
}

const url = new URL("https://api.vapi.ai/call");
if (ASSISTANT_ID) url.searchParams.set("assistantId", ASSISTANT_ID);
url.searchParams.set("limit", String(LIMIT));

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 30000);
let calls;
try {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${KEY}` }, signal: ctrl.signal });
  if (!res.ok) { console.error(`✗ Vapi API ${res.status}:`, await res.text()); process.exit(1); }
  calls = await res.json();
} catch (err) {
  console.error("✗ Could not reach Vapi:", err?.message || err);
  process.exit(1);
} finally {
  clearTimeout(timer);
}

if (!Array.isArray(calls) || calls.length === 0) {
  console.log("No calls found.");
  process.exit(0);
}

function liveOutcomeOf(messages) {
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    for (const t of m?.toolCalls || m?.tool_calls || []) {
      const name = t?.function?.name ?? t?.name;
      if (name !== "set_outcome") continue;
      const raw = t?.function?.arguments ?? t?.arguments;
      try { return (typeof raw === "string" ? JSON.parse(raw) : raw)?.outcome ?? null; } catch { return null; }
    }
  }
  return null;
}

const outDir = join(ROOT, "test/fixtures/calls");
mkdirSync(outDir, { recursive: true });

let n = 0;
for (const c of calls) {
  const durationSec =
    c.startedAt && c.endedAt ? (new Date(c.endedAt) - new Date(c.startedAt)) / 1000 : undefined;
  const fixture = {
    id: c.id,
    endedReason: c.endedReason ?? null,
    durationSec,
    liveOutcome: liveOutcomeOf(c.messages),
    transcript: typeof c.transcript === "string" ? c.transcript : "",
  };
  writeFileSync(join(outDir, `${c.id}.json`), JSON.stringify(fixture, null, 2));
  n++;
}

console.log(`✓ Wrote ${n} call fixture(s) to test/fixtures/calls/. Run: node scripts/replay-classify.mjs`);
