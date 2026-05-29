"use strict";

/**
 * Task 5.6 — integration test for end-to-end contamination prevention.
 *
 *   Property 1 (No contamination): when the active medicine is Pregabalin,
 *   `retrieveKnowledge` MUST surface only Pregabalin / neutral chunks; no
 *   Gabapentin / Alprazolam / Dolo650 chunks.
 *   Property 4 (Preservation): when no scope is supplied, the unscoped
 *   baseline is preserved (mixed chunks flow through).
 *
 * **Validates: Requirements 1.2, 1.3, 2.2, 2.3, 3.1, 3.2**
 *
 * The test stubs `src/rag/hybridRetriever.js` and `src/rag/evaluator.js`
 * BEFORE requiring `src/services/ragService.js` so we exercise:
 *   ragService.retrieveKnowledge → (stubbed) hybridRetrieve → real reranker.
 *
 * No real Mongo / Chroma / Groq / network is touched. Tests are deterministic.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { stubModule, REPO_ROOT } = require("../../_mocks/installShims");
const { CHUNKS } = require("../../_mocks/fakeKnowledgeBase");

// The real reranker must be required from the actual file so the stubbed
// hybridRetriever can call it.
const { rerank } = require(path.join(REPO_ROOT, "src/rag/reranker.js"));

// Stub the evaluator so retrieveKnowledge does not hit the (mocked) Mongo
// model when persisting retrieval metrics. Keep the function signatures
// identical to what ragService consumes.
stubModule("src/rag/evaluator.js", {
  evaluateRetrieval: (query, results = [], opts = {}) => ({
    query,
    retrievalType: opts.retrievalType || "hybrid",
    hitCount: results.length,
    topConfidence: results[0]?.confidence || 0,
    latencyMs: opts.latencyMs || 0,
    categories: [],
    failed: results.length === 0,
  }),
  recordRetrievalMetric: async (metric) => metric,
  getRetrievalQualitySummary: async () => ({}),
});

// Capture call arguments so subtests can assert the scope flowed through.
let lastCall = null;

stubModule("src/rag/hybridRetriever.js", {
  // Mimic the production signature (`(query, options)`) and exercise the real
  // reranker so the medicineMatch boost / demote behavior is part of the
  // integration. Synthetic vector + keyword scores are deterministic and
  // crafted so mismatches drop below `mismatchDropThreshold` while matches
  // and neutrals survive.
  hybridRetrieve: async (query, options = {}) => {
    lastCall = { query, options };
    const synthesized = CHUNKS.map((c, idx) => ({
      id: c.id,
      text: c.text,
      metadata: c.metadata,
      // Distinct distances so unscoped ordering is stable and deterministic.
      vectorScore: 0.2 + idx * 0.02,
      keywordScore: c.text.toLowerCase().includes(String(query).toLowerCase())
        ? 0.7
        : 0.1,
      sourceType: "vector",
    }));
    // High mismatch drop threshold ensures clear contaminants (medicineMatch
    // = -1) are removed, while neutral chunks (medicineMatch = 0) survive.
    const ranked = rerank(query, synthesized, {
      category: options.category,
      medicineScope: options.medicineScope,
      mismatchDropThreshold: 0.5,
    });
    return ranked.slice(0, options.k || 5);
  },
});

const { retrieveKnowledge } = require(path.join(
  REPO_ROOT,
  "src/services/ragService.js"
));

const PREGABALIN_SCOPE = {
  medicineName: "Pregabalin",
  genericName: "Pregabalin",
  aliases: ["Lyrica"],
  salts: ["Pregabalin"],
};

const DOLO_SCOPE = {
  medicineName: "Dolo650",
  genericName: "Paracetamol",
};

// ===========================================================================
// Subtest A — Active Pregabalin: zero contamination.
// ===========================================================================
test("Property 1 — active Pregabalin yields zero contamination", async () => {
  lastCall = null;
  const result = await retrieveKnowledge({
    question: "side effects",
    medicineScope: PREGABALIN_SCOPE,
    k: 10,
  });

  // Scope flowed through to hybridRetrieve.
  assert.equal(lastCall.options.medicineScope.medicineName, "Pregabalin");
  assert.equal(lastCall.options.medicineScope.genericName, "Pregabalin");

  // Every surfaced item belongs to Pregabalin or is a neutral guideline.
  const allowedMedicines = new Set(["Pregabalin", null]);
  const allowedGenerics = new Set(["Pregabalin", null]);
  for (const item of result.context) {
    assert.ok(
      allowedMedicines.has(item.metadata.medicine),
      `contamination: medicine=${item.metadata.medicine} surfaced for Pregabalin scope`
    );
    assert.ok(
      allowedGenerics.has(item.metadata.generic),
      `contamination: generic=${item.metadata.generic} surfaced for Pregabalin scope`
    );
  }

  // Pregabalin chunks must surface; no Gabapentin/Alprazolam/Dolo650.
  const surfaced = result.context.map((c) => c.metadata.medicine);
  assert.ok(surfaced.includes("Pregabalin"), `Pregabalin chunks missing: ${surfaced}`);
  assert.ok(!surfaced.includes("Gabapentin"));
  assert.ok(!surfaced.includes("Alprazolam"));
  assert.ok(!surfaced.includes("Dolo650"));
});

// ===========================================================================
// Subtest B — Active Dolo650: only Dolo650 / neutral surfaced.
// ===========================================================================
test("active Dolo650 scope surfaces only Dolo650 + neutral chunks", async () => {
  lastCall = null;
  const result = await retrieveKnowledge({
    question: "side effects",
    medicineScope: DOLO_SCOPE,
    k: 10,
  });

  const surfaced = result.context.map((c) => c.metadata.medicine);
  assert.ok(!surfaced.includes("Pregabalin"), `Pregabalin leaked: ${surfaced}`);
  assert.ok(!surfaced.includes("Gabapentin"));
  assert.ok(!surfaced.includes("Alprazolam"));
  // Dolo650 chunk and neutral guideline (medicine=null) may appear.
  for (const item of result.context) {
    const allowed = item.metadata.medicine === "Dolo650" || item.metadata.medicine == null;
    assert.ok(
      allowed,
      `unexpected medicine ${item.metadata.medicine} for Dolo650 scope`
    );
  }
  assert.ok(surfaced.includes("Dolo650"), "Dolo650 chunk missing");
});

// ===========================================================================
// Subtest C — No scope: unscoped baseline preserved (Property 4).
// ===========================================================================
test("Property 4 — no scope passes through with mixed chunks intact", async () => {
  lastCall = null;
  const result = await retrieveKnowledge({
    question: "side effects",
    k: 10,
  });

  // No medicineScope flowed through.
  assert.ok(
    lastCall.options.medicineScope === undefined ||
      lastCall.options.medicineScope === null,
    `medicineScope should be undefined/null, got ${JSON.stringify(lastCall.options.medicineScope)}`
  );

  const surfaced = result.context.map((c) => c.metadata.medicine);
  // Mixed corpus is preserved — at least Pregabalin, Gabapentin, Alprazolam,
  // Dolo650, and the neutral chunk (medicine=null) are present.
  assert.ok(surfaced.includes("Pregabalin"), "Pregabalin missing in unscoped result");
  assert.ok(surfaced.includes("Gabapentin"), "Gabapentin missing in unscoped result");
  assert.ok(surfaced.includes("Alprazolam"), "Alprazolam missing in unscoped result");
  assert.ok(surfaced.includes("Dolo650"), "Dolo650 missing in unscoped result");
  assert.ok(surfaced.includes(null), "neutral chunk missing in unscoped result");
});

// ===========================================================================
// Subtest D — Plumbing sanity: knowledgeFilter received medicine fields.
// ===========================================================================
test("knowledgeFilter received medicine fields when scope is supplied", async () => {
  lastCall = null;
  await retrieveKnowledge({
    question: "side effects",
    medicineScope: PREGABALIN_SCOPE,
    metadata: { source: "knowledge-base/medicines/pregabalin.md" },
    k: 4,
  });

  // The metadata passed to hybridRetrieve must include `medicine` from the
  // scope (and not `generic`, since generic equals medicine for Pregabalin).
  assert.equal(lastCall.options.metadata.medicine, "Pregabalin");
  assert.equal(lastCall.options.metadata.generic, undefined);
  assert.equal(
    lastCall.options.metadata.source,
    "knowledge-base/medicines/pregabalin.md"
  );
});
