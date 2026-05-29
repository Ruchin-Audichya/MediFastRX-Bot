"use strict";

/**
 * P2 — Context retention across follow-ups.
 *
 * For any sequence `[setActiveMedicineContext(M), follow-up*]` where each
 * follow-up is drawn from `FOLLOW_UP_TEMPLATES` and the deterministic
 * resolver is stubbed to return `{ type: "unknown", confidence: 0 }`, every
 * follow-up MUST resolve to M (`usedContext === true` AND the rewritten
 * query references M.medicineName).
 *
 * **Validates: Requirements 2.4, 2.5, 2.8**
 *
 * The resolver shim mirrors `tests/unit/services/conversationContextService.test.js`:
 * we install a stub for `src/medicine/medicineNormalizer.js` BEFORE requiring
 * the conversation context service so the active-context branch never reaches
 * Mongo.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

// Module-load env (TTL, threshold) — set BEFORE the require below.
process.env.ACTIVE_CONTEXT_TTL_MS = process.env.ACTIVE_CONTEXT_TTL_MS || "60000";
process.env.MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD =
  process.env.MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD || "0.6";

const { stubModule, REPO_ROOT } = require("../_mocks/installShims");

stubModule("src/medicine/medicineNormalizer.js", {
  // Always "unknown" — keeps the active context, exercising follow-up rewrite.
  normalizeMedicineQuery: async () => ({ type: "unknown", confidence: 0 }),
});

const ccs = require(path.join(REPO_ROOT, "src/services/conversationContextService.js"));
const {
  setActiveMedicineContext,
  resolveContextualQuery,
  clearActiveContext,
} = ccs;
const { makeRng, generateFollowUpSequence, MEDICINES } = require("../_gen");

const SEEDS = [1, 7, 42, 137, 999];

test("P2 — every follow-up resolves to the active medicine", async () => {
  for (const seed of SEEDS) {
    const rng = makeRng(seed);
    for (const med of MEDICINES.slice(0, 5)) {
      const tg = `p2-${seed}-${med.medicineName}`;
      clearActiveContext(tg);
      const ctx = setActiveMedicineContext(tg, {
        resolution: {
          medicine: med,
          type: "medicine",
          confidence: 0.92,
          method: "p2-seed",
        },
      });
      assert.ok(ctx, `seed=${seed} med=${med.medicineName}: context must be stored`);

      const sequence = generateFollowUpSequence(rng, 4);
      for (const followUp of sequence) {
        const r = await resolveContextualQuery(tg, followUp);
        assert.equal(
          r.usedContext,
          true,
          `seed=${seed} med=${med.medicineName} input="${followUp}": usedContext must be true (got ${JSON.stringify(r)})`,
        );
        const lower = String(r.query || "").toLowerCase();
        assert.ok(
          lower.includes(med.medicineName.toLowerCase()),
          `seed=${seed} med=${med.medicineName} input="${followUp}": rewritten query "${r.query}" must reference ${med.medicineName}`,
        );
        assert.ok(r.context && r.context.medicineName === med.medicineName);
      }
      clearActiveContext(tg);
    }
  }
});
