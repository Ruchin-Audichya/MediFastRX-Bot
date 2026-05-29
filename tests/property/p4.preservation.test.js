"use strict";

/**
 * P4 — Preservation of unscoped behavior.
 *
 * When no active medicine context is supplied:
 *   (a) `validateEvidence` is a no-op — every item kept, dropped === 0.
 *   (b) `rerank` returns components without `medicineMatch`.
 *   (c) `knowledgeFilter` produces only the canonical 4 keys.
 *
 * **Validates: Requirements 3.1, 3.2, 3.4**
 *
 * Drives the production modules directly. No shims, no I/O.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const { validateEvidence } = require(path.join(REPO_ROOT, "src/orchestrator/evidenceIntegrity.js"));
const { rerank } = require(path.join(REPO_ROOT, "src/rag/reranker.js"));
const { knowledgeFilter } = require(path.join(REPO_ROOT, "src/services/ragService.js"));
const { makeRng, generateChunks, MEDICINES } = require("../_gen");

const SEEDS = [1, 7, 42, 137, 999];
const CANONICAL_KEYS = new Set(["source", "category", "trust", "updatedAt"]);

test("P4.a — validateEvidence is a no-op pass-through with no active medicine", () => {
  for (const seed of SEEDS) {
    const rng = makeRng(seed);
    for (const med of MEDICINES.slice(0, 4)) {
      const chunks = generateChunks(rng, med, 6);
      const result = validateEvidence({
        items: chunks,
        activeMedicine: null,
        explicitMedicines: [],
        itemKind: "rag",
      });
      assert.equal(result.kept.length, chunks.length, `seed=${seed}: every chunk must be kept`);
      assert.equal(result.dropped.length, 0, `seed=${seed}: nothing should be dropped`);
      assert.equal(result.report.dropped, 0);
      assert.equal(result.report.activeMedicine, null);
      for (const item of result.kept) {
        assert.equal(item.belongsToActiveMedicine, true);
      }
    }
  }
});

test("P4.b — rerank components omit medicineMatch when no scope", () => {
  const synth = (id, text, vectorScore, keywordScore, metadata = {}) => ({
    id,
    text,
    metadata,
    vectorScore,
    keywordScore,
  });
  for (const seed of SEEDS) {
    const rng = makeRng(seed);
    // Use chunks that have foreign metadata.medicine to confirm it does NOT
    // affect ordering when no scope is supplied.
    const chunks = generateChunks(rng, MEDICINES[0], 5).map((c, i) =>
      synth(`r-${seed}-${i}`, c.text, 0.2 + i * 0.05, 0.5 - i * 0.05, c.metadata),
    );
    const ranked = rerank("side effects", chunks, {
      semanticWeight: 0.55,
      keywordWeight: 0.35,
      categoryWeight: 0.1,
    });
    for (const r of ranked) {
      assert.deepEqual(
        Object.keys(r.components).sort(),
        ["category", "keyword", "semantic"],
        `seed=${seed}: components shape must be {semantic, keyword, category}`,
      );
      assert.equal(r.components.medicineMatch, undefined);
    }
  }
});

test("P4.c — knowledgeFilter retains only canonical keys when no scope", () => {
  const inputs = [
    {},
    { source: "knowledge-base/medicines/pregabalin.md" },
    { category: "neuropathic_pain" },
    { trust: "curated" },
    { updatedAt: "2026-01-01" },
    {
      source: "knowledge-base/symptoms/fever.md",
      category: "symptom",
      trust: "curated",
      updatedAt: "2026-02-15",
    },
    {
      source: "knowledge-base/medicines/dolo650.md",
      category: "analgesic",
      medicine: "Dolo650",
      generic: "Paracetamol",
      irrelevantKey: "should-not-leak",
    },
    { source: "", category: null, trust: undefined, updatedAt: 0 },
    { telegramId: "u-123", category: "guideline" },
  ];
  for (const input of inputs) {
    const out = knowledgeFilter(input); // no medicineScope
    for (const key of Object.keys(out)) {
      assert.ok(
        CANONICAL_KEYS.has(key),
        `unscoped knowledgeFilter leaked key "${key}" for input ${JSON.stringify(input)}`,
      );
    }
  }
});
