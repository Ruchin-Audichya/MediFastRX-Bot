"use strict";

// Per-user TTL+LRU cache for response-stage artifacts (resolution, retrieval,
// enrichment) keyed by `(telegramId, normalizedMedicineQuery)`. Bounded size,
// in-memory only, no PII beyond `telegramId`, no I/O.
//
// Used by:
//   - src/services/conversationContextService.js (cache the resolution)  [opt-in]
//   - src/orchestrator/toolExecutor.js            (cache retrieval result)
//   - MediAtlas enrichment step (Phase 7)         (cache enrichment payload)
//
// Phase 6 / Task 8.2 of the medicine-context-integrity bugfix.
//
// NOTE: A separate `src/cache/medicineCache.js` already exists and is used by
// `searchService`, `medicineEnrichmentService`, and `medicineImporter` for
// medicine-knowledge match caching with a different key/value shape. We add
// this response-stage cache as a NEW module to avoid clobbering the existing
// cache and to keep the public API distinct.
//
// Design notes:
//   - Tiny LRU using `Map` insertion order. Reads refresh order on hit.
//   - Lazy expiry on read (no eager timer threads).
//   - `get`/`set` accept an optional `slot` so callers can update one section
//     (`resolution` / `retrieval` / `enrichment`) without clobbering the
//     others. The composite value is `{ resolution, retrieval, enrichment,
//     expiresAt }`.
//   - `expiresAt` is refreshed on writes (so a hot conversation keeps its
//     entry alive for the configured TTL window).
//   - No PII beyond `telegramId` is held — keys are deterministically derived
//     from `(telegramId, normalizedMedicineQuery)` and values are the
//     production payloads the upstream stages already compute.
//
// **Validates: Requirements 2.9, 3.4**

const MEDIFAST_RESPONSE_CACHE_TTL_MS = Number(
  process.env.MEDIFAST_RESPONSE_CACHE_TTL_MS || 90 * 1000
); // default ~90s (env override permitted in 60-120s recommended band)
const MEDIFAST_RESPONSE_CACHE_MAX_SIZE = Number(
  process.env.MEDIFAST_RESPONSE_CACHE_MAX_SIZE || 500
);

const ALLOWED_SLOTS = new Set(["resolution", "retrieval", "enrichment"]);

const lowerTrim = (v) => {
  if (v === null || v === undefined) return "";
  return String(v).trim().toLowerCase();
};

const buildKey = (telegramId, normalizedMedicineQuery) => {
  const tg =
    telegramId === null || telegramId === undefined ? "" : String(telegramId);
  const q = lowerTrim(normalizedMedicineQuery);
  if (!tg || !q) return null;
  return `${tg}::${q}`;
};

// Singleton store. Insertion order = LRU order (oldest first).
const store = new Map();

const evictIfNeeded = () => {
  while (store.size > MEDIFAST_RESPONSE_CACHE_MAX_SIZE) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
};

const isExpired = (entry, now) =>
  !entry || typeof entry.expiresAt !== "number" || now > entry.expiresAt;

const get = ({
  telegramId,
  normalizedMedicineQuery,
  slot,
  now = Date.now(),
} = {}) => {
  const key = buildKey(telegramId, normalizedMedicineQuery);
  if (!key) return null;
  const entry = store.get(key);
  if (!entry || isExpired(entry, now)) {
    if (entry) store.delete(key);
    return null;
  }
  // Refresh LRU order (delete + re-set at the end).
  store.delete(key);
  store.set(key, entry);
  if (slot) {
    if (!ALLOWED_SLOTS.has(slot)) return null;
    return Object.prototype.hasOwnProperty.call(entry.value, slot)
      ? entry.value[slot]
      : null;
  }
  // Return a shallow copy of the composite value so callers cannot mutate the
  // cached object in place (defensive, not required for correctness today).
  return { ...entry.value };
};

const set = ({
  telegramId,
  normalizedMedicineQuery,
  slot,
  value,
  now = Date.now(),
  ttlMs = MEDIFAST_RESPONSE_CACHE_TTL_MS,
} = {}) => {
  const key = buildKey(telegramId, normalizedMedicineQuery);
  if (!key) return null;
  const safeTtl = Number(ttlMs) > 0 ? Number(ttlMs) : MEDIFAST_RESPONSE_CACHE_TTL_MS;

  let composite;
  const existing = store.get(key);
  if (!existing || isExpired(existing, now)) {
    composite = {};
  } else {
    // Refresh LRU and TTL on write (keep prior slots).
    store.delete(key);
    composite = { ...existing.value };
  }

  if (slot) {
    if (!ALLOWED_SLOTS.has(slot)) return null;
    composite[slot] = value;
  } else if (value && typeof value === "object") {
    // Merge top-level slots from `value` (only allowed slots are kept).
    for (const key2 of Object.keys(value)) {
      if (ALLOWED_SLOTS.has(key2)) composite[key2] = value[key2];
    }
  }

  const nextEntry = { value: composite, expiresAt: now + safeTtl };
  store.set(key, nextEntry);
  evictIfNeeded();
  return { ...composite };
};

const invalidate = ({ telegramId, normalizedMedicineQuery } = {}) => {
  const key = buildKey(telegramId, normalizedMedicineQuery);
  if (!key) return false;
  return store.delete(key);
};

const clear = () => {
  store.clear();
};

const stats = () => ({
  size: store.size,
  ttlMs: MEDIFAST_RESPONSE_CACHE_TTL_MS,
  maxSize: MEDIFAST_RESPONSE_CACHE_MAX_SIZE,
});

module.exports = {
  buildKey,
  get,
  set,
  invalidate,
  clear,
  stats,
  MEDIFAST_RESPONSE_CACHE_TTL_MS,
  MEDIFAST_RESPONSE_CACHE_MAX_SIZE,
};
