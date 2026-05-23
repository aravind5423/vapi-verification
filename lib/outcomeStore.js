/**
 * outcomeStore.js
 * ---------------------------------------------------------------------------
 * Dual-mode state store for call outcomes.
 *
 * - LOCAL DEV  → plain in-memory Map (reset on cold-start; fine for testing)
 * - PRODUCTION → Upstash Redis (Redis-backed, survives serverless cold-starts)
 *
 * Switch is automatic: if UPSTASH_REDIS_REST_URL is set in env, Redis is used.
 *
 * Note: @vercel/kv was deprecated in 2024. Upstash Redis is the recommended
 * successor. Set up a free Redis database at https://upstash.com and link it
 * to your Vercel project under Integrations → Upstash.
 * ---------------------------------------------------------------------------
 */

const useKV = !!process.env.UPSTASH_REDIS_REST_URL;

// ─── In-memory fallback ────────────────────────────────────────────────────
const memStore = new Map();

const memGet = async (key) => memStore.get(key) ?? null;
const memSet = async (key, value) => { memStore.set(key, value); };

// ─── Upstash Redis wrapper ─────────────────────────────────────────────────
let kvGet, kvSet;

if (useKV) {
  // Dynamically import so local dev without the package doesn't explode
  const { Redis } = await import("@upstash/redis");
  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  kvGet = async (key) => await redis.get(key);
  kvSet = async (key, value) => await redis.set(key, value, { ex: 3600 }); // 1 hour TTL
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
