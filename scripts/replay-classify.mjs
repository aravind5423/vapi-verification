#!/usr/bin/env node
/**
 * scripts/replay-classify.mjs
 * ---------------------------------------------------------------------------
 * Replays a corpus of call transcripts (the 8 real production calls + synthetic
 * edge cases in test/fixtures/synthetic.json, plus any real calls dumped into
 * test/fixtures/calls/*.json) through the authoritative classifier (api/classify.js)
 * and reports whether each lands on its expected outcome.
 *
 * This is the PRIMARY proof that the restructure fixes the lost/false outcomes —
 * e.g. the "confirmed-but-busy" calls (#3/#7/#8) that used to be a false P1_SUCCESS
 * now resolve to P8_VERIFIED_NO_SURVEY.
 *
 * Two modes (auto-detected):
 *   • Heuristic-only — no DEEPSEEK_API_KEY: exercises the deterministic floor.
 *     Informational only (some nuanced cases need the LLM); never exits non-zero.
 *   • Full ensemble  — with DEEPSEEK_API_KEY (env or .env.local): the real accuracy
 *     measure. Exits non-zero if any STRICT `expect` case fails.
 *
 *   node scripts/replay-classify.mjs
 * ---------------------------------------------------------------------------
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { classify } from "../api/classify.js";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dir, "..");

// Load DEEPSEEK_API_KEY from .env.local if not already in the environment, so the
// harness runs in full-ensemble mode without extra setup.
function loadEnvLocal() {
  if (process.env.DEEPSEEK_API_KEY) return;
  try {
    const txt = readFileSync(join(ROOT, ".env.local"), "utf8");
    const line = txt.split(/\r?\n/).find((l) => l.startsWith("DEEPSEEK_API_KEY="));
    if (line) process.env.DEEPSEEK_API_KEY = line.slice("DEEPSEEK_API_KEY=".length).trim().replace(/^["']|["']$/g, "");
  } catch { /* no .env.local — heuristic mode */ }
}
loadEnvLocal();

const ensemble = Boolean(process.env.DEEPSEEK_API_KEY);

// ─── Gather fixtures ──────────────────────────────────────────────────────────
const fixtures = [];

// 1) Synthetic + real-call reproductions (the asserted corpus).
const synthPath = join(ROOT, "test/fixtures/synthetic.json");
if (existsSync(synthPath)) {
  for (const f of JSON.parse(readFileSync(synthPath, "utf8"))) fixtures.push(f);
}

// 2) Any raw real calls dumped by scripts/dump-calls.mjs (no expectations — these
//    are eyeball/regression data; we print the verdict + the old live outcome).
const callsDir = join(ROOT, "test/fixtures/calls");
if (existsSync(callsDir)) {
  for (const file of readdirSync(callsDir).filter((f) => f.endsWith(".json"))) {
    const c = JSON.parse(readFileSync(join(callsDir, file), "utf8"));
    fixtures.push({ name: `dumped:${file} (${c.id ?? "?"})`, ...c });
  }
}

if (fixtures.length === 0) {
  console.error("No fixtures found. Add test/fixtures/synthetic.json or run scripts/dump-calls.mjs.");
  process.exit(1);
}

// ─── Run ──────────────────────────────────────────────────────────────────────
console.log(`\nReplay mode: ${ensemble ? "FULL ENSEMBLE (DeepSeek)" : "HEURISTIC-ONLY (no API key)"}`);
console.log(`Fixtures: ${fixtures.length}\n` + "═".repeat(86));

let strictTotal = 0, strictPass = 0, softTotal = 0, softPass = 0;
const failures = [];

for (const f of fixtures) {
  const r = await classify({
    transcript: f.transcript,
    endedReason: f.endedReason,
    durationSec: f.durationSec,
    liveOutcome: f.liveOutcome ?? undefined,
  });
  const got = r.code;

  const expectStrict = typeof f.expect === "string" ? f.expect : null;
  const expectSet = Array.isArray(f.expectOneOf) ? f.expectOneOf : (expectStrict ? [expectStrict] : null);

  let mark = "·"; // no expectation (dumped real call)
  if (expectSet) {
    const ok = expectSet.includes(got);
    if (expectStrict) { strictTotal++; if (ok) strictPass++; }
    else { softTotal++; if (ok) softPass++; }
    mark = ok ? "✓" : "✗";
    if (!ok) failures.push({ name: f.name, got, expected: expectSet, strict: Boolean(expectStrict), live: f.liveOutcome, source: r.source });
  }

  const live = f.liveOutcome ? ` live=${f.liveOutcome}` : "";
  const exp = expectSet ? ` want=${expectSet.join("|")}` : "";
  console.log(`${mark} ${got.padEnd(22)} [${r.source}]${exp}${live}  — ${f.name}`);
}

console.log("═".repeat(86));
console.log(`Strict (expect):   ${strictPass}/${strictTotal} passed`);
console.log(`Lenient (oneOf):   ${softPass}/${softTotal} passed`);

if (failures.length) {
  console.log("\nMismatches:");
  for (const x of failures) {
    console.log(`  ${x.strict ? "STRICT" : "soft  "}  got ${x.got} (src ${x.source}), wanted ${x.expected.join("|")}  — ${x.name}`);
  }
}

// In ensemble mode, a failed STRICT expectation is a real regression → non-zero exit.
// In heuristic-only mode, we never fail the process (the floor isn't meant to nail
// nuanced cases — that's the LLM's job; offline correctness is covered by unit tests).
if (ensemble && strictPass < strictTotal) {
  console.log("\n✗ Strict expectations failed in ensemble mode.");
  process.exit(1);
}
console.log(`\n✓ Done${ensemble ? "" : " (heuristic mode — informational only)"}.`);
