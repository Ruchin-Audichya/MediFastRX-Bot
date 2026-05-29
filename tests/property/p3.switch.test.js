"use strict";

/**
 * P3 — Context switch on explicit new medicine.
 *
 * For any pair (M, N) where N differs in identity from M and the resolver
 * returns N at high confidence, calling `resolveContextualQuery` after
 * `setActiveMedicineContext(M)` MUST signal a switch:
 *   { usedContext: false, context: null }
 *
 * **Validates: Requirements 2.7, 2.8, 1.7, 1.8**
 *
 * The conversation service signals a switch by returning `usedContext=false,
 * context=null` without mutating storage; the bot/search layer then calls
 * `setActiveMedicineContext` after a successful search. We assert the signal
 * here over many seeds.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.ACTIVE_CONTEXT_TTL_MS = process.env.ACTIVE_CONTEXT_TTL_MS || "60000";
process.env.MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD =
  process.env.MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD || "0.6";

const { stubModule, REPO_ROOT } = require("../_mocks/installShims");

// Programmable resolver — each subtest sets `nextResolution` before calling
// resolveContextualQuery. This mirrors the unit-test pattern in
// tests/unit/services/conversationContextService.test.js.
let nextResolution = { type: "unknown", confidence: 0 };
const setNextResolution = (r) => { nextResolution = r; };

stubModule("src/medicine/medicineNormalizer.js", {
  normalizeMedicineQuery: async () => nextResolution,
});

const ccs = require(path.join(REPO_ROOT, "src/services/conversationContextService.js"));
const {
  setActiveMedicineContext,
  resolveContextualQuery,
  clearActiveContext,
  getActiveContext,
} = ccs;

const { makeRng, generateDistinctMedicinePair } = require("../_gen");

const SEEDS = [1, 7, 42, 137, 999, 31337];

test("P3 — explicit high-conf new medicine signals a switch", async () => {
  for (const seed of SEEDS) {
    const rng = makeRng(seed);
    for (let i = 0; i < 4; i += 1) {
      const [m, n] = generateDistinctMedicinePair(rng);
      const tg = `p3-${seed}-${i}`;
      clearActiveContext(tg);

      const stored = setActiveMedicineContext(tg, {
        resolution: {
          medicine: m,
          type: "medicine",
          confidence: 0.92,
          method: "p3-active",
        },
      });
      assert.ok(stored, `seed=${seed} active=${m.medicineName}: must store ctx`);

      // Drive the resolver to return N at high confidence.
      setNextResolution({
        type: "medicine",
        confidence: 0.9,
        medicine: {
          medicineName: n.medicineName,
          genericName: n.genericName,
        },
      });

      const r = await resolveContextualQuery(tg, `now tell me about ${n.medicineName}`);

      assert.equal(
        r.usedContext,
        false,
        `seed=${seed} M=${m.medicineName} N=${n.medicineName}: usedContext must be false on switch (got ${JSON.stringify(r)})`,
      );
      assert.equal(
        r.context,
        null,
        `seed=${seed} M=${m.medicineName} N=${n.medicineName}: context must be null on switch`,
      );

      // Storage is NOT auto-mutated — the search layer is responsible for
      // setActiveMedicineContext after a successful search. Active stays M.
      const post = getActiveContext(tg);
      assert.ok(post, "ctx should still exist after switch signal");
      assert.equal(post.medicineName, m.medicineName);
      clearActiveContext(tg);
    }
  }
});

test("P3 — same-identity high-conf resolution does NOT trigger a switch", async () => {
  const rng = makeRng(11);
  const [m] = generateDistinctMedicinePair(rng);
  const tg = "p3-same";
  clearActiveContext(tg);
  setActiveMedicineContext(tg, {
    resolution: {
      medicine: m,
      type: "medicine",
      confidence: 0.92,
      method: "p3-same",
    },
  });
  setNextResolution({
    type: "medicine",
    confidence: 0.9,
    medicine: { medicineName: m.medicineName, genericName: m.genericName },
  });
  const r = await resolveContextualQuery(tg, `${m.medicineName} side effects`);
  assert.equal(r.usedContext, true, "same-identity follow-up should not switch");
  assert.ok(String(r.query || "").toLowerCase().includes(m.medicineName.toLowerCase()));
  clearActiveContext(tg);
});
