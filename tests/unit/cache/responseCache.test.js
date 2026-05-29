"use strict";

/**
 * Phase 6 / Task 8.5 — unit tests for the per-user TTL+LRU response cache.
 *
 *   `src/cache/responseCache.js` is the new (Task 8.2) cache used by
 *   `toolExecutor` (retrieval slot) and reserved for `conversationContext`
 *   (resolution slot) and the MediAtlas enrichment step (enrichment slot).
 *
 * **Validates: Requirements 2.9, 3.4**
 *
 * Note on filename: tasks.md mentions `tests/unit/cache/medicineCache.test.js`,
 * but Task 8.2 implemented the cache as `src/cache/responseCache.js` (a
 * separate module from the pre-existing `src/cache/medicineCache.js`). We
 * place the tests next to the module they actually exercise.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const cache = require(path.join(REPO_ROOT, "src/cache/responseCache.js"));

// Each subtest starts from a clean cache so order doesn't leak.
const beforeEach = () => cache.clear();

// ---------------------------------------------------------------------------
// buildKey
// ---------------------------------------------------------------------------

test("buildKey — same (telegramId, query) yields same key", () => {
  beforeEach();
  const k1 = cache.buildKey("u-1", "Pregabalin");
  const k2 = cache.buildKey("u-1", "Pregabalin");
  assert.equal(k1, k2);
});

test("buildKey — different inputs yield different keys", () => {
  beforeEach();
  const a = cache.buildKey("u-1", "Pregabalin");
  const b = cache.buildKey("u-2", "Pregabalin");
  const c = cache.buildKey("u-1", "Dolo650");
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.notEqual(b, c);
});

test("buildKey — falsy inputs return null", () => {
  beforeEach();
  assert.equal(cache.buildKey(null, "Pregabalin"), null);
  assert.equal(cache.buildKey("u-1", null), null);
  assert.equal(cache.buildKey("u-1", ""), null);
  assert.equal(cache.buildKey("u-1", "   "), null);
  assert.equal(cache.buildKey("", "Pregabalin"), null);
  assert.equal(cache.buildKey(undefined, undefined), null);
});

test("buildKey — case + whitespace normalized for the query", () => {
  beforeEach();
  const a = cache.buildKey("u-1", "Pregabalin");
  const b = cache.buildKey("u-1", "  PREGABALIN  ");
  assert.equal(a, b);
});

// ---------------------------------------------------------------------------
// get on miss / set then get
// ---------------------------------------------------------------------------

test("get on miss returns null", () => {
  beforeEach();
  assert.equal(
    cache.get({ telegramId: "u-1", normalizedMedicineQuery: "Pregabalin", slot: "retrieval" }),
    null
  );
  assert.equal(
    cache.get({ telegramId: "u-1", normalizedMedicineQuery: "Pregabalin" }),
    null
  );
});

test("set then get returns the same value (slot-scoped)", () => {
  beforeEach();
  const value = { context: [{ text: "Pregabalin causes dizziness" }] };
  cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
    value,
  });
  const got = cache.get({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
  });
  assert.deepEqual(got, value);
});

// ---------------------------------------------------------------------------
// TTL — lazy expiry
// ---------------------------------------------------------------------------

test("TTL expiry — get returns null after the TTL window passes", () => {
  beforeEach();
  cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
    value: { hello: "world" },
    now: 1_000,
    ttlMs: 50,
  });
  // Within window.
  assert.deepEqual(
    cache.get({
      telegramId: "u-1",
      normalizedMedicineQuery: "Pregabalin",
      slot: "retrieval",
      now: 1_040,
    }),
    { hello: "world" }
  );
  // Just after expiry.
  assert.equal(
    cache.get({
      telegramId: "u-1",
      normalizedMedicineQuery: "Pregabalin",
      slot: "retrieval",
      now: 1_051,
    }),
    null
  );
  // And the entry is purged from the underlying store.
  assert.equal(cache.stats().size, 0);
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

test("LRU bound — oldest entry is evicted when size exceeds the configured max", () => {
  beforeEach();
  const max = cache.MEDIFAST_RESPONSE_CACHE_MAX_SIZE;
  // Fill exactly to capacity.
  for (let i = 0; i < max; i += 1) {
    cache.set({
      telegramId: `u-${i}`,
      normalizedMedicineQuery: "Pregabalin",
      slot: "retrieval",
      value: { i },
      now: 1_000 + i,
    });
  }
  assert.equal(cache.stats().size, max);

  // The (current) oldest entry — `u-0` — must be present.
  assert.deepEqual(
    cache.get({
      telegramId: "u-0",
      normalizedMedicineQuery: "Pregabalin",
      slot: "retrieval",
      now: 1_000 + max,
    }),
    { i: 0 }
  );

  // After the read above, `u-0` was promoted to MRU. So the oldest is now `u-1`.
  // Insert one more entry — `u-1` should be the one that gets evicted.
  cache.set({
    telegramId: `u-${max}`,
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
    value: { i: max },
    now: 2_000 + max,
  });

  assert.equal(cache.stats().size, max);
  assert.equal(
    cache.get({
      telegramId: "u-1",
      normalizedMedicineQuery: "Pregabalin",
      slot: "retrieval",
      now: 2_001 + max,
    }),
    null,
    "u-1 (the oldest non-promoted entry) must be evicted"
  );
  // The just-inserted entry is alive.
  assert.deepEqual(
    cache.get({
      telegramId: `u-${max}`,
      normalizedMedicineQuery: "Pregabalin",
      slot: "retrieval",
      now: 2_002 + max,
    }),
    { i: max }
  );
});

// ---------------------------------------------------------------------------
// Slot semantics — `retrieval` and `enrichment` co-exist on the same key.
// ---------------------------------------------------------------------------

test("slot semantics — different slots on the same key co-exist", () => {
  beforeEach();
  cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
    value: { context: ["chunk-1"] },
    now: 1_000,
  });
  cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "enrichment",
    value: { inventory: { items: [{ id: "p-1" }] } },
    now: 1_010,
  });

  assert.deepEqual(
    cache.get({
      telegramId: "u-1",
      normalizedMedicineQuery: "Pregabalin",
      slot: "retrieval",
      now: 1_020,
    }),
    { context: ["chunk-1"] }
  );
  assert.deepEqual(
    cache.get({
      telegramId: "u-1",
      normalizedMedicineQuery: "Pregabalin",
      slot: "enrichment",
      now: 1_020,
    }),
    { inventory: { items: [{ id: "p-1" }] } }
  );

  // Composite get returns both slots.
  const composite = cache.get({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    now: 1_020,
  });
  assert.ok(composite.retrieval, "composite must include retrieval slot");
  assert.ok(composite.enrichment, "composite must include enrichment slot");
});

test("slot semantics — unknown slot in `set` is rejected", () => {
  beforeEach();
  const out = cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "not-a-real-slot",
    value: { x: 1 },
  });
  assert.equal(out, null);
  // Nothing was stored.
  assert.equal(cache.stats().size, 0);
});

// ---------------------------------------------------------------------------
// TTL refresh on write — hot conversations stay alive.
// ---------------------------------------------------------------------------

test("TTL refresh on write — second write extends the expiry window", () => {
  beforeEach();
  cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
    value: { tag: "first" },
    now: 0,
    ttlMs: 100,
  });
  // Refresh at t=50 with a new value, ttl unchanged: expiry should now be at t=150.
  cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
    value: { tag: "second" },
    now: 50,
    ttlMs: 100,
  });
  // At t=120, the ORIGINAL TTL (100) would have expired (>100), but the
  // refreshed TTL (50+100=150) keeps the entry alive.
  assert.deepEqual(
    cache.get({
      telegramId: "u-1",
      normalizedMedicineQuery: "Pregabalin",
      slot: "retrieval",
      now: 120,
    }),
    { tag: "second" }
  );
});

// ---------------------------------------------------------------------------
// Defensive copy — mutating the returned value does not bleed back.
// ---------------------------------------------------------------------------

test("defensive copy — mutating composite get does not bleed into the cache", () => {
  beforeEach();
  cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
    value: { tag: "original" },
  });

  const composite = cache.get({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
  });
  assert.deepEqual(composite, { retrieval: { tag: "original" } });

  // Mutate the top-level shape.
  composite.retrieval = { tag: "mutated" };
  composite.bogus = true;

  const fresh = cache.get({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
  });
  assert.deepEqual(
    fresh,
    { retrieval: { tag: "original" } },
    "internal cache state must remain unchanged after caller mutation"
  );
});

// ---------------------------------------------------------------------------
// invalidate / clear
// ---------------------------------------------------------------------------

test("invalidate — removes a single (telegramId, query) entry", () => {
  beforeEach();
  cache.set({
    telegramId: "u-1",
    normalizedMedicineQuery: "Pregabalin",
    slot: "retrieval",
    value: { x: 1 },
  });
  assert.equal(cache.stats().size, 1);

  const removed = cache.invalidate({ telegramId: "u-1", normalizedMedicineQuery: "Pregabalin" });
  assert.equal(removed, true);
  assert.equal(cache.stats().size, 0);
  assert.equal(
    cache.get({ telegramId: "u-1", normalizedMedicineQuery: "Pregabalin", slot: "retrieval" }),
    null
  );
});
