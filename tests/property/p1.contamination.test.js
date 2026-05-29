"use strict";

/**
 * P1 — Bug Condition / No Contamination.
 *
 * For any active MedicineContext M (confidence >= threshold) and any mixed
 * chunk set generated for M, every kept item from `validateEvidence` MUST
 * satisfy `belongsToActiveMedicine`. Foreign chunks (different medicine /
 * generic) MUST land in `dropped`.
 *
 * **Validates: Requirements 1.2, 1.3, 1.6, 2.2, 2.3, 2.6**
 *
 * Drives the production module `src/orchestrator/evidenceIntegrity.js`
 * directly with deterministic input from `tests/_gen/index.js`. No I/O.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const { validateEvidence } = require(path.join(REPO_ROOT, "src/orchestrator/evidenceIntegrity.js"));
const { createMedicineContext } = require(path.join(REPO_ROOT, "src/context/medicineContext.js"));
const { makeRng, generateChunks, MEDICINES } = require("../_gen");

const SEEDS = [1, 7, 42, 137, 999];

test("P1 — every kept evidence item belongs to the active medicine", () => {
  for (const seed of SEEDS) {
    const rng = makeRng(seed);
    for (const med of MEDICINES) {
      const ctx = createMedicineContext({
        resolution: { medicine: med, confidence: 0.92, method: "p1-seed" },
        conversationId: "p1",
        userId: "p1",
        now: 1_700_000_000_000,
      });
      const chunks = generateChunks(rng, med, 8);
      const result = validateEvidence({
        items: chunks,
        activeMedicine: ctx,
        explicitMedicines: [],
        itemKind: "rag",
      });

      for (const item of result.kept) {
        const meta = item.metadata || {};
        const tag = String(meta.medicine || meta.generic || "").toLowerCase();
        const allowed = [ctx.medicineName, ctx.genericName, ...ctx.aliases, ...ctx.salts]
          .map((s) => String(s).toLowerCase());
        assert.ok(
          tag === "" || allowed.includes(tag),
          `seed=${seed} active=${med.medicineName}: kept item with foreign tag "${tag}"`,
        );
      }

      for (const item of result.dropped) {
        const meta = item.metadata || {};
        const tag = String(meta.medicine || meta.generic || "").toLowerCase();
        const allowed = [ctx.medicineName, ctx.genericName].map((s) => String(s).toLowerCase());
        assert.ok(
          !allowed.includes(tag),
          `seed=${seed} active=${med.medicineName}: dropped item should not have matched: "${tag}"`,
        );
      }

      assert.equal(
        result.report.total,
        chunks.length,
        `seed=${seed}: report.total mismatch`,
      );
      assert.equal(result.kept.length + result.dropped.length, chunks.length);
    }
  }
});

test("P1 — explicitly-requested medicines bypass contamination drop (3.6)", () => {
  const rng = makeRng(2024);
  const active = MEDICINES[0]; // Pregabalin
  const ctx = createMedicineContext({
    resolution: { medicine: active, confidence: 0.92, method: "p1-explicit" },
    conversationId: "p1e",
    userId: "p1e",
    now: 1_700_000_000_000,
  });
  const chunks = generateChunks(rng, active, 6);
  const result = validateEvidence({
    items: chunks,
    activeMedicine: ctx,
    explicitMedicines: ["Gabapentin"],
    itemKind: "rag",
  });
  // Any Gabapentin chunk must be kept (explicitlyRequested) instead of dropped.
  const gabapentinKept = result.kept.filter((i) => i.metadata && i.metadata.medicine === "Gabapentin");
  const gabapentinDropped = result.dropped.filter((i) => i.metadata && i.metadata.medicine === "Gabapentin");
  if (chunks.some((c) => c.metadata.medicine === "Gabapentin")) {
    assert.ok(gabapentinKept.length > 0, "Gabapentin chunk should be kept under explicit request");
    assert.equal(gabapentinDropped.length, 0, "no Gabapentin chunks should be dropped under explicit request");
    for (const item of gabapentinKept) {
      assert.equal(item.explicitlyRequested, true, "explicitlyRequested flag must be set");
    }
  }
});
