/**
 * outcomeStore.js
 * ---------------------------------------------------------------------------
 * Dual-mode state store for call outcomes.
 *
 * - LOCAL DEV  → plain in-memory Map (reset on cold-start; fine for testing)
 * - PRODUCTION → Upstash Redis (Redis-backed, survives serverless cold-starts)
 *
 * Supports two env var naming conventions:
 *   1. Vercel Upstash integration (auto-injected): KV_REST_API_URL + KV_REST_API_TOKEN
 *   2. Manual setup:                               UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 * ---------------------------------------------------------------------------
 */

// Support both Vercel auto-injected KV vars and manual Upstash vars
const redisUrl   = process.env.KV_REST_API_URL   ?? process.env.UPSTASH_REDIS_REST_URL;
const redisToken = process.env.KV_REST_API_TOKEN  ?? process.env.UPSTASH_REDIS_REST_TOKEN;
const useKV = !!redisUrl && !!redisToken;

// ─── In-memory fallback ────────────────────────────────────────────────────
const memStore = new Map();

const memGet = async (key) => memStore.get(key) ?? null;
const memSet = async (key, value) => { memStore.set(key, value); };

// ─── Upstash Redis wrapper ─────────────────────────────────────────────────
let kvGet, kvSet;

if (useKV) {
  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({ url: redisUrl, token: redisToken });
  kvGet = async (key) => await redis.get(key);
  kvSet = async (key, value) => await redis.set(key, value, { ex: 3600 }); // 1 hour TTL
  console.log("[store] Using Upstash Redis for persistent state");
} else {
  console.log("[store] Using in-memory store (set KV_REST_API_URL to enable Redis)");
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Retrieve a stored call record.
 * @param {string} key  Vapi call ID
 * @returns {Promise<object|null>}
 */
export const get = async (key) => (useKV ? kvGet(key) : memGet(key));

/**
 * Store or update a call record.
 * @param {string} key    Vapi call ID
 * @param {object} value  Arbitrary data (status, outcome, result, etc.)
 * @returns {Promise<void>}
 */
export const set = async (key, value) => (useKV ? kvSet(key, value) : memSet(key, value));

/**
 * Merge new fields into an existing record (read → merge → write).
 * @param {string} key
 * @param {object} patch
 */
export const patch = async (key, patch) => {
  const existing = (await get(key)) ?? {};
  await set(key, { ...existing, ...patch });
};
