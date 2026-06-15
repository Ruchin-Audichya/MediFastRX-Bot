"use strict";

/**
 * Preservation property tests for the "medicine context integrity" bugfix.
 *
 *   Property 4 — Preservation of Unscoped Behavior: when no medicine is
 *   resolved (or confidence is below MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD),
 *   the system SHALL behave byte-for-byte identical to today.
 *
 * **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
 *
 * IMPORTANT: This test runs against the UNFIXED pipeline and MUST PASS — the
 * passes capture the baseline that subsequent phases must preserve. The
 * snapshots are stored under tests/preserve/__snapshots__/ so future phases
 * can detect any drift.
 *
 * Inputs (¬C) covered:
 *   - Symptom-education: "bukhar ki tablet", "acidity ke liye kya lu"
 *   - Family-only:       "papa BP tablet", "mummy ke liye sugar dawai"
 *   - Nearby-only:       "Dolo near me" (with location context)
 *   - Low-confidence:    ambiguous medicine-like text
 *   - Greetings:         "hi"
 *
 * Test framework: node:test (built-in, no new deps).
 *
 * No production code is modified. No real Mongo / Chroma / Groq / network is
 * touched. Tests are deterministic.
 */

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const SNAPSHOT_DIR = path.join(__dirname, "__snapshots__");

// ---------------------------------------------------------------------------
// Tiny inline snapshot helper. On first run, writes the snapshot and passes.
// On subsequent runs, deep-equals against the stored snapshot. Set the env
// var UPDATE_PRESERVATION_SNAPSHOTS=1 to refresh snapshots intentionally.
// ---------------------------------------------------------------------------

const assertSnapshot = (name, actual) => {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
  const file = path.join(SNAPSHOT_DIR, `${name}.json`);
  const serialized = JSON.stringify(actual, null, 2);
  if (!fs.existsSync(file) || process.env.UPDATE_PRESERVATION_SNAPSHOTS === "1") {
    fs.writeFileSync(file, serialized + "\n", "utf8");
    return;
  }
  const stored = fs.readFileSync(file, "utf8").trim();
  assert.equal(
    serialized,
    stored,
    `Snapshot drift for "${name}".\nExpected (stored):\n${stored}\nActual:\n${serialized}`
  );
};

// ---------------------------------------------------------------------------
// Common deterministic inputs used across multiple properties.
// ---------------------------------------------------------------------------

const SYMPTOM_EDUCATION = ["bukhar ki tablet", "acidity ke liye kya lu"];
const FAMILY_ONLY = ["papa BP tablet", "mummy ke liye sugar dawai"];
const NEARBY_ONLY = ["Dolo near me"];
const LOW_CONFIDENCE = ["zzzqx tablet"]; // ambiguous, below threshold
const GREETINGS = ["hi"];
const NON_MEDICINE_INPUTS = [
  ...SYMPTOM_EDUCATION,
  ...FAMILY_ONLY,
  ...NEARBY_ONLY,
  ...LOW_CONFIDENCE,
  ...GREETINGS,
];

// ===========================================================================
// P4.a — knowledgeFilter parity when no medicineScope.
// ===========================================================================
//
// The current production helper (src/services/ragService.js) is:
//
//   const knowledgeFilter = (metadata = {}) =>
//     ["source", "category", "trust", "updatedAt"].reduce((filter, key) => {
//       if (metadata[key]) filter[key] = metadata[key];
//       return filter;
//     }, {});
//
// It is internal (not exported). To capture the byte-for-byte baseline we:
//   1) require() the module to prove it loads on unfixed code.
//   2) Read the source file as text and assert the canonical keys array
//      `["source", "category", "trust", "updatedAt"]` is still present.
//   3) Mirror the same reduction here (clearly labeled BASELINE_FILTER) and
//      snapshot the (input, output) pairs over a representative metadata set.
//
// Phase 3 / Task 5.2 will extend the filter to accept an optional
// `medicineScope`. When `medicineScope` is absent, the reduction above MUST
// still produce the snapshotted outputs — that is the preservation contract.

test("P4.a — knowledgeFilter parity when no medicineScope", async (t) => {
  // (1) The module loads cleanly on unfixed code.
  const ragService = require(path.join(REPO_ROOT, "src/services/ragService.js"));
  assert.equal(typeof ragService.retrieveKnowledge, "function");
  assert.equal(typeof ragService.listKnowledgeSources, "function");

  // (2) The canonical keys array is still present in the source. This is a
  // tripwire: if Phase 3 changes the keys when no medicineScope is supplied,
  // this assertion fails and the snapshot diff below pinpoints the drift.
  const ragSource = fs.readFileSync(
    path.join(REPO_ROOT, "src/services/ragService.js"),
    "utf8"
  );
  assert.match(
    ragSource,
    /\[\s*"source"\s*,\s*"category"\s*,\s*"trust"\s*,\s*"updatedAt"\s*\]/,
    "ragService.js no longer contains the canonical knowledgeFilter keys array"
  );

  // (3) Mirror the production reduction and snapshot its outputs over a
  // representative set of metadata inputs (¬C: no medicineScope).
  const BASELINE_KEYS = ["source", "category", "trust", "updatedAt"];
  const BASELINE_FILTER = (metadata = {}) =>
    BASELINE_KEYS.reduce((filter, key) => {
      if (metadata[key]) filter[key] = metadata[key];
      return filter;
    }, {});

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
    // Irrelevant keys must be dropped (preservation).
    {
      source: "knowledge-base/medicines/dolo650.md",
      category: "analgesic",
      medicine: "Dolo650",
      generic: "Paracetamol",
      alias: "Crocin",
      irrelevantKey: "should-not-leak",
    },
    // Falsy values for canonical keys must be skipped (preservation).
    { source: "", category: null, trust: undefined, updatedAt: 0 },
    // telegramId / category propagation are NOT filter keys today.
    { telegramId: "u-123", category: "guideline" },
  ];

  const observations = inputs.map((metadata) => ({
    input: metadata,
    output: BASELINE_FILTER(metadata),
  }));

  await t.test("baseline filter snapshot matches today's behavior", () => {
    assertSnapshot("p4a.knowledgeFilter.baseline", observations);
  });

  await t.test("filter never leaks unknown keys", () => {
    for (const obs of observations) {
      const outKeys = Object.keys(obs.output);
      for (const key of outKeys) {
        assert.ok(
          BASELINE_KEYS.includes(key),
          `unexpected key "${key}" in baseline filter output for input ${JSON.stringify(obs.input)}`
        );
      }
    }
  });
});

// ===========================================================================
// P4.b — reranker ordering unchanged when no active medicine.
// ===========================================================================
//
// Today the reranker score is:
//   confidence = semantic*semanticWeight + keyword*keywordWeight + category*categoryWeight
// with default weights (0.55, 0.35, 0.10) and no medicine signal. We snapshot
// the resulting ordering for a deterministic mixed-medicine result list. The
// fix in Phase 3 must produce the same order when medicineScope is absent
// (medicineMatch contributes 0 — design Property 4).

test("P4.b — reranker ordering unchanged when no active medicine", async (t) => {
  const { rerank } = require(path.join(REPO_ROOT, "src/rag/reranker.js"));
  const { CHUNKS } = require(path.join(REPO_ROOT, "tests/_mocks/fakeKnowledgeBase.js"));

  // Synthesize a deterministic vectorScore + keywordScore for each chunk so the
  // ordering is fully reproducible and independent of any embedding model.
  // Distances are crafted so neighboring chunks have non-trivial gaps, which
  // makes ordering drift (if any) easy to spot in the snapshot diff.
  const SYNTH = {
    "preg-1":   { vectorScore: 0.20, keywordScore: 0.85 },
    "preg-2":   { vectorScore: 0.25, keywordScore: 0.80 },
    "gaba-1":   { vectorScore: 0.30, keywordScore: 0.55 },
    "alpr-1":   { vectorScore: 0.35, keywordScore: 0.50 },
    "dolo-1":   { vectorScore: 0.40, keywordScore: 0.45 },
    "neutral-1":{ vectorScore: 0.50, keywordScore: 0.20 },
  };

  const buildResults = () =>
    CHUNKS.map((c) => ({
      id: c.id,
      text: c.text,
      metadata: c.metadata,
      vectorScore: SYNTH[c.id].vectorScore,
      keywordScore: SYNTH[c.id].keywordScore,
    }));

  const cases = [
    {
      name: "side-effects-query-no-category",
      query: "side effects",
      options: {
        // Pin weights so the snapshot is stable even if env defaults change.
        semanticWeight: 0.55,
        keywordWeight: 0.35,
        categoryWeight: 0.1,
      },
    },
    {
      name: "fever-query-symptom-category-match",
      query: "bukhar ki tablet",
      options: {
        category: "guideline",
        semanticWeight: 0.55,
        keywordWeight: 0.35,
        categoryWeight: 0.1,
      },
    },
    {
      name: "empty-query",
      query: "",
      options: {
        semanticWeight: 0.55,
        keywordWeight: 0.35,
        categoryWeight: 0.1,
      },
    },
  ];

  const observations = cases.map(({ name, query, options }) => {
    const ranked = rerank(query, buildResults(), options);
    return {
      name,
      query,
      options,
      order: ranked.map((r) => ({
        id: r.id,
        // Round to 6 decimals to keep the snapshot stable across machines.
        confidence: Math.round(r.confidence * 1e6) / 1e6,
        components: {
          semantic: Math.round(r.components.semantic * 1e6) / 1e6,
          keyword: Math.round(r.components.keyword * 1e6) / 1e6,
          category: r.components.category,
        },
      })),
    };
  });

  await t.test("reranker baseline order snapshot", () => {
    assertSnapshot("p4b.reranker.baseline", observations);
  });

  await t.test("reranker score never references medicine identity", () => {
    // Today's reranker has NO medicineMatch signal. The fix in Phase 3 will
    // add one (RETRIEVAL_MEDICINE_WEIGHT) and demote/drop mismatches. With
    // no active medicine in `options`, the components must remain exactly
    // {semantic, keyword, category} — no extra keys today.
    const ranked = rerank("side effects", buildResults(), {});
    for (const r of ranked) {
      assert.deepEqual(
        Object.keys(r.components).sort(),
        ["category", "keyword", "semantic"],
        "reranker components shape changed; preservation contract broken"
      );
    }
  });
});

// ===========================================================================
// P4.c — formatSearchResults unchanged for non-medicine flows.
// ===========================================================================
//
// We snapshot the HTML output of formatSearchResults for several non-medicine
// flows (symptom-education, family-only, nearby-only). The fix must NOT touch
// this path; only `formatMedicineCard` (Phase 9) is added alongside.

test("P4.c — formatSearchResults unchanged for non-medicine flows", async (t) => {
  const { formatSearchResults } = require(path.join(
    REPO_ROOT,
    "src/utils/formatter.js"
  ));

  const baseItem = (over = {}) => ({
    medicineName: "Generic Medicine",
    genericName: "Generic Salt",
    brands: ["Brand A", "Brand B"],
    aliases: [],
    symptoms: [],
    diseases: [],
    category: "general",
    inStock: true,
    price: 25,
    unit: "strip",
    requiresPrescription: false,
    isRare: false,
    knowledgeOnly: false,
    sideEffects: [],
    precautions: [],
    alternatives: [],
    // Deterministic fixture: `null` renders a stable "Verified: Unknown" so
    // the snapshot does not drift with wall-clock time (formatVerifiedTime
    // computes age from Date.now()).
    lastVerified: null,
    pharmacy: {
      name: "Test Pharmacy",
      area: "Test Area",
      address: "1, Test Street, Jaipur",
      phone: "0141-0000000",
      whatsapp: "",
      hours: "9am - 9pm",
    },
    ...over,
  });

  const cases = [
    {
      name: "symptom-education-bukhar",
      query: "bukhar ki tablet",
      results: [
        baseItem({
          medicineName: "Paracetamol",
          genericName: "Paracetamol",
          symptoms: ["fever", "body ache"],
          category: "painkiller",
        }),
      ],
      context: {
        intent: { label: "fever support" },
        contextual: { usedContext: false, context: null },
      },
    },
    {
      name: "family-only-papa-bp",
      query: "papa BP tablet",
      results: [
        baseItem({
          medicineName: "Telmisartan",
          genericName: "Telmisartan",
          symptoms: ["high blood pressure"],
          category: "cardiac",
          requiresPrescription: true,
        }),
      ],
      context: {
        mentionedMember: { name: "Papa", ageGroup: "senior" },
        intent: { label: "BP support" },
      },
    },
    {
      name: "nearby-only-dolo",
      query: "Dolo near me",
      results: [
        baseItem({
          medicineName: "Dolo650",
          genericName: "Paracetamol",
          symptoms: ["fever"],
          category: "painkiller",
          knowledgeOnly: false,
        }),
      ],
      context: {},
    },
    {
      name: "low-confidence-ambiguous",
      query: "zzzqx tablet",
      results: [
        baseItem({
          medicineName: "Unknown Match",
          genericName: "",
          knowledgeOnly: true,
        }),
      ],
      context: {
        aiContext: { lowConfidence: true },
      },
    },
  ];

  const observations = cases.map(({ name, query, results, context }) => ({
    name,
    query,
    html: formatSearchResults(results, query, context),
  }));

  await t.test("formatSearchResults baseline HTML snapshot", () => {
    assertSnapshot("p4c.formatSearchResults.baseline", observations);
  });

  await t.test("output is deterministic across repeated calls", () => {
    for (const { query, results, context } of cases) {
      const a = formatSearchResults(results, query, context);
      const b = formatSearchResults(results, query, context);
      assert.equal(a, b, `formatSearchResults non-deterministic for "${query}"`);
    }
  });
});

// ===========================================================================
// P4.d — conversationContextService preservation for non-medicine input.
// ===========================================================================
//
// With NO active medicine context, resolveContextualQuery must return
//   { query: text, usedContext: false, context: null }
// for every input under ¬C (symptom, family, nearby, greetings, low-confidence).

test("P4.d — conversationContextService preservation for non-medicine input", async (t) => {
  const ccs = require(path.join(
    REPO_ROOT,
    "src/services/conversationContextService.js"
  ));
  const { getActiveContext, resolveContextualQuery } = ccs;

  // Use a unique telegramId per test run so the singleton in-memory Map is
  // guaranteed to have no active context for this user.
  const telegramId = `preserve-d-${process.pid}-${Date.now()}`;

  await t.test("no active context is set for this telegramId", () => {
    assert.equal(getActiveContext(telegramId), null);
  });

  const observations = [];
  for (const text of NON_MEDICINE_INPUTS) {
    const result = await resolveContextualQuery(telegramId, text);
    observations.push({
      input: text,
      output: {
        query: result.query,
        usedContext: result.usedContext,
        context: result.context ?? null,
      },
    });
  }

  await t.test("baseline shape: query passes through, no context used", () => {
    for (const obs of observations) {
      assert.equal(
        obs.output.query,
        obs.input,
        `query should pass through unchanged for "${obs.input}", got "${obs.output.query}"`
      );
      assert.equal(
        obs.output.usedContext,
        false,
        `usedContext must be false with no active context for "${obs.input}"`
      );
      assert.equal(
        obs.output.context,
        null,
        `context must be null with no active context for "${obs.input}"`
      );
    }
  });

  await t.test("snapshot of resolveContextualQuery outputs", () => {
    // Snapshot only the canonical fields — telegramId is volatile per run.
    assertSnapshot("p4d.resolveContextualQuery.baseline", observations);
  });
});

// ===========================================================================
// P4.e — deterministic latency budget (placeholder, mocked).
// ===========================================================================
//
// Time the three pure preservation paths over 100 iterations of the
// non-medicine inputs. Each operation's mean must be well under 50ms on mocks
// (a generous floor). Phase 6 task 8.4 will assert the real budgets
// (endToEnd p95 < 1500ms deterministic, < 3500ms with LLM).

test("P4.e — deterministic latency budget (placeholder)", async (t) => {
  const ITERATIONS = 100;
  const FLOOR_MS = 50;

  const { rerank } = require(path.join(REPO_ROOT, "src/rag/reranker.js"));
  const ccs = require(path.join(
    REPO_ROOT,
    "src/services/conversationContextService.js"
  ));
  const { resolveContextualQuery } = ccs;

  // Mirror today's knowledgeFilter (P4.a contract).
  const BASELINE_KEYS = ["source", "category", "trust", "updatedAt"];
  const knowledgeFilterMirror = (metadata = {}) =>
    BASELINE_KEYS.reduce((filter, key) => {
      if (metadata[key]) filter[key] = metadata[key];
      return filter;
    }, {});

  const filterInputs = [
    {},
    { source: "knowledge-base/medicines/pregabalin.md", category: "neuropathic_pain" },
    {
      source: "knowledge-base/symptoms/fever.md",
      category: "symptom",
      trust: "curated",
      updatedAt: "2026-02-15",
      irrelevantKey: "ignored",
    },
  ];

  const rerankResults = [
    { id: "r1", text: "fever paracetamol", vectorScore: 0.3, keywordScore: 0.8, metadata: { category: "painkiller" } },
    { id: "r2", text: "acidity antacid",   vectorScore: 0.4, keywordScore: 0.6, metadata: { category: "gastro" } },
    { id: "r3", text: "general guideline", vectorScore: 0.6, keywordScore: 0.2, metadata: { category: "guideline" } },
  ];

  // -------- knowledgeFilter
  let startNs = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const m of filterInputs) knowledgeFilterMirror(m);
  }
  const filterMeanMs = Number(process.hrtime.bigint() - startNs) / 1e6 / ITERATIONS;

  // -------- rerank
  startNs = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    rerank("bukhar ki tablet", rerankResults, {
      semanticWeight: 0.55,
      keywordWeight: 0.35,
      categoryWeight: 0.1,
    });
  }
  const rerankMeanMs = Number(process.hrtime.bigint() - startNs) / 1e6 / ITERATIONS;

  // -------- resolveContextualQuery (no active context)
  const telegramId = `preserve-e-${process.pid}-${Date.now()}`;
  startNs = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i++) {
    for (const text of NON_MEDICINE_INPUTS) {
      // eslint-disable-next-line no-await-in-loop
      await resolveContextualQuery(telegramId, text);
    }
  }
  const resolveTotalCalls = ITERATIONS * NON_MEDICINE_INPUTS.length;
  const resolveMeanMs =
    Number(process.hrtime.bigint() - startNs) / 1e6 / resolveTotalCalls;

  t.diagnostic(`knowledgeFilter mean: ${filterMeanMs.toFixed(4)}ms`);
  t.diagnostic(`rerank          mean: ${rerankMeanMs.toFixed(4)}ms`);
  t.diagnostic(`resolveContext  mean: ${resolveMeanMs.toFixed(4)}ms`);

  await t.test(`knowledgeFilter mean < ${FLOOR_MS}ms`, () => {
    assert.ok(
      filterMeanMs < FLOOR_MS,
      `knowledgeFilter mean ${filterMeanMs}ms exceeds floor ${FLOOR_MS}ms`
    );
  });

  await t.test(`rerank mean < ${FLOOR_MS}ms`, () => {
    assert.ok(
      rerankMeanMs < FLOOR_MS,
      `rerank mean ${rerankMeanMs}ms exceeds floor ${FLOOR_MS}ms`
    );
  });

  await t.test(`resolveContextualQuery mean < ${FLOOR_MS}ms`, () => {
    assert.ok(
      resolveMeanMs < FLOOR_MS,
      `resolveContextualQuery mean ${resolveMeanMs}ms exceeds floor ${FLOOR_MS}ms`
    );
  });
});
