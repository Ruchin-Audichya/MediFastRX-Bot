"use strict";

/**
 * P6 — `createMedicineContext` idempotency.
 *
 * For any (resolution, conversationId, userId, now), calling
 * `createMedicineContext` twice with the same inputs MUST produce
 * deep-equal canonical fields.
 *
 * **Validates: Requirements 2.1, 2.8**
 *
 * Drives the production module directly. No I/O.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const { createMedicineContext } = require(path.join(REPO_ROOT, "src/context/medicineContext.js"));
const { makeRng, MEDICINES } = require("../_gen");

const SEEDS = [1, 7, 42, 137, 999];

const FIXED_NOW = 1_700_000_000_000;

test("P6 — createMedicineContext is idempotent under fixed clock", () => {
  for (const seed of SEEDS) {
    const rng = makeRng(seed);
    for (const med of MEDICINES) {
      const resolution = {
        medicine: med,
        type: "medicine",
        confidence: 0.5 + rng() * 0.5,
        method: "p6",
        relationships: [
          { type: "same_class", from: med.medicineName, to: "Other", confidence: 0.6 },
        ],
      };
      const a = createMedicineContext({
        resolution,
        conversationId: `p6-${seed}`,
        userId: `p6-${seed}`,
        now: FIXED_NOW,
      });
      const b = createMedicineContext({
        resolution,
        conversationId: `p6-${seed}`,
        userId: `p6-${seed}`,
        now: FIXED_NOW,
      });
      assert.deepEqual(a, b, `seed=${seed} med=${med.medicineName}: contexts must be deep-equal`);
      // Returned objects must be frozen.
      assert.ok(Object.isFrozen(a));
      assert.ok(Object.isFrozen(b));
    }
  }
});

test("P6 — different `now` only changes timestamp/updatedAt", () => {
  const rng = makeRng(2024);
  const med = MEDICINES[1];
  const resolution = { medicine: med, type: "medicine", confidence: 0.9, method: "p6t" };
  const a = createMedicineContext({ resolution, conversationId: "p6t", userId: "p6t", now: 1000 });
  const b = createMedicineContext({ resolution, conversationId: "p6t", userId: "p6t", now: 2000 });
  // Strip volatile fields then compare.
  const stripVolatile = (ctx) => {
    const { timestamp, updatedAt, ...rest } = ctx;
    return rest;
  };
  assert.deepEqual(stripVolatile(a), stripVolatile(b));
  assert.equal(a.timestamp, 1000);
  assert.equal(b.timestamp, 2000);
  // Touch rng so the import is exercised, keeping the generator surface live.
  assert.ok(typeof rng === "function");
});
