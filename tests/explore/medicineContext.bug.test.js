"use strict";

/**
 * Medicine-context-integrity REGRESSION test (formerly the bug-exploration
 * artifact).
 *
 *   Property 1 — Bug Condition: When a medicine has been resolved with
 *   confidence >= MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD, every downstream stage
 *   (RAG retrieval, evidence collection, follow-up resolution, context switch)
 *   SHALL operate scoped to that medicine.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
 *
 * HISTORY: this file originally drove the UNFIXED pipeline and was expected to
 * FAIL — the failures were the counterexamples that confirmed the bug. The
 * fix has since landed (Phases 1–4: MedicineContext, follow-up engine,
 * medicine-aware retrieval, evidence-integrity guard). The test now drives the
 * FIXED pipeline and asserts the corrected behavior. Permanent property-based
 * coverage also lives in `tests/property/p1-p3`.
 *
 * The test deliberately bypasses MongoDB, ChromaDB, Groq, and the network:
 *   - `src/ai/toolRegistry.js` is stubbed with deterministic in-memory fakes.
 *   - `src/medicine/medicineNormalizer.js` is stubbed so the conversation
 *     service's deterministic resolver never reaches Mongo (which previously
 *     caused 10s buffer-timeout hangs per follow-up).
 * Both stubs are installed via `require.cache` BEFORE the production modules
 * under test are required.
 */

const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { stubModule, REPO_ROOT } = require("../_mocks/installShims");
const {
  CHUNKS,
  fakeRetrieveKnowledge,
  fakeSearchMedicineKnowledge,
} = require("../_mocks/fakeKnowledgeBase");

// ----------------------------------------------------------------------------
// Stub 1 — production tool registry. Installed BEFORE the orchestrator modules
// are required so they pick up our fake `getTool` and never reach
// Mongo/Chroma/Groq. The fake `retrieveKnowledge` mirrors the production
// signature `({ question, metadata, medicineScope })` and intentionally
// returns a MIXED-medicine result for "side effects" — exactly the raw recall
// the evidence-integrity guard must then scope down to the active medicine.
// ----------------------------------------------------------------------------

const toolMap = {
  searchMedicineKnowledge: {
    name: "searchMedicineKnowledge",
    execute: ({ query }) => fakeSearchMedicineKnowledge({ query }),
  },
  retrieveKnowledge: {
    name: "retrieveKnowledge",
    execute: ({ question, metadata, medicineScope }) =>
      fakeRetrieveKnowledge({ question, metadata, medicineScope, k: 5 }),
  },
  retrieveRelevantMemory: {
    name: "retrieveRelevantMemory",
    execute: async () => ({ facts: [], confidence: 0 }),
  },
  recommendNearbyPharmacies: {
    name: "recommendNearbyPharmacies",
    execute: async () => ({ ranked: [], radiusKm: 5 }),
  },
};

stubModule("src/ai/toolRegistry.js", {
  getTool: (name) => toolMap[name],
  listTools: () => Object.values(toolMap).map(({ execute, ...rest }) => rest),
  toLangChainTools: () => [],
  tools: toolMap,
});

// ----------------------------------------------------------------------------
// Stub 2 — deterministic `normalizeMedicineQuery`. The conversation service
// uses this to detect an explicit NEW medicine vs a follow-up. We resolve a
// small known set (Pregabalin / Dolo650 / Telmisartan) at high confidence and
// return a non-medicine result for everything else (so follow-up phrasings are
// treated as follow-ups, not new medicines). No Mongo, no network, no hang.
// ----------------------------------------------------------------------------

const KNOWN_RESOLUTIONS = {
  pregabalin: { medicineName: "Pregabalin", genericName: "Pregabalin", aliases: ["Lyrica"] },
  dolo650: { medicineName: "Dolo650", genericName: "Paracetamol", aliases: ["Crocin"] },
  telmisartan: { medicineName: "Telmisartan", genericName: "Telmisartan", aliases: ["Telma"] },
};

const fakeNormalizeMedicineQuery = async (query) => {
  const key = String(query || "").toLowerCase().trim();
  const hit = Object.entries(KNOWN_RESOLUTIONS).find(([slug]) => key.includes(slug));
  if (!hit) {
    return {
      type: "unknown",
      normalizedQuery: query,
      confidence: 0.2,
      medicine: null,
      reason: "no match",
      method: "stub",
    };
  }
  const [, medicine] = hit;
  return {
    type: "medicine",
    normalizedQuery: medicine.medicineName,
    confidence: 0.92,
    medicine: { _id: `med-${medicine.medicineName}`, ...medicine },
    reason: "stub direct match",
    method: "stub",
  };
};

stubModule("src/medicine/medicineNormalizer.js", {
  normalizeMedicineQuery: fakeNormalizeMedicineQuery,
  // The conversation service only consumes `normalizeMedicineQuery`; other
  // exports are present for require-shape parity.
  rebuildMedicineKnowledgeIndex: async () => ({ count: 0, rebuiltAt: new Date() }),
  normalizeMedicineRecord: (r) => r,
});

// Now require production modules — they will see the stubbed registry/resolver.
const { executeWorkflowTools } = require(path.join(
  REPO_ROOT,
  "src/orchestrator/toolExecutor.js"
));
const { collectEvidence } = require(path.join(
  REPO_ROOT,
  "src/orchestrator/evidenceCollector.js"
));
const conversationContextService = require(path.join(
  REPO_ROOT,
  "src/services/conversationContextService.js"
));

const {
  setActiveMedicineContext,
  getActiveContext,
  clearActiveContext,
  resolveContextualQuery,
} = conversationContextService;

// ---------------------------------------------------------------------------
// Sequence A — RAG / Evidence contamination is ELIMINATED under an active
// Pregabalin context. Even though raw retrieval returns mixed medicines
// (Gabapentin / Alprazolam / Dolo650), the evidence-integrity guard scopes the
// surfaced evidence to Pregabalin and reports the dropped contamination.
// ---------------------------------------------------------------------------

test("Sequence A — RAG/evidence is scoped to the active medicine (Pregabalin)", async (t) => {
  const telegramId = "explore-A";
  clearActiveContext(telegramId);
  setActiveMedicineContext(telegramId, {
    medicineName: "Pregabalin",
    genericName: "Pregabalin",
    query: "Pregabalin",
  });
  const activeMedicine = getActiveContext(telegramId);

  const plan = {
    query: "side effects",
    entities: { medicine: "Pregabalin", normalizedMedicineQuery: "Pregabalin" },
    routes: [{ tool: "rag" }, { tool: "medicine" }],
    execute: { family: false, medicine: true, memory: false, rag: true, nearby: false },
  };

  const toolResults = await executeWorkflowTools({ plan, telegramId, profile: null });
  const evidence = collectEvidence({
    query: plan.query,
    plan,
    toolResults,
    activeMedicine,
  });

  const ragItems = evidence.ragContext.context;

  await t.test("every surfaced RAG chunk belongs to the active medicine", () => {
    const contaminated = ragItems.filter((item) => {
      const tag = (item.medicine || item.generic || "").toLowerCase();
      if (!tag) return false; // neutral / guideline chunks are allowed
      return tag !== "pregabalin";
    });
    assert.deepEqual(
      contaminated.map((c) => ({ medicine: c.medicine, generic: c.generic })),
      [],
      "expected zero contaminated chunks under active Pregabalin context, got: " +
        JSON.stringify(contaminated, null, 2)
    );
  });

  await t.test("evidence.ragContext exposes a contamination report", () => {
    assert.ok(
      evidence.ragContext.contamination,
      "expected evidence.ragContext.contamination report from the integrity guard"
    );
    assert.ok(
      evidence.ragContext.contamination.dropped > 0,
      "expected the guard to drop at least one contaminating chunk"
    );
  });

  await t.test("sanity: the fake KB really seeds contaminating chunks", () => {
    assert.equal(
      CHUNKS.some((c) => c.metadata.medicine === "Gabapentin"),
      true,
      "fakeKnowledgeBase must seed at least one Gabapentin chunk"
    );
  });
});

// ---------------------------------------------------------------------------
// Sequence B — Follow-up phrasings outside the old hardcoded regex set now
// resolve against the active medicine.
// ---------------------------------------------------------------------------

test("Sequence B — follow-up phrasings resolve against the active medicine", async (t) => {
  const telegramId = "explore-B";
  clearActiveContext(telegramId);
  setActiveMedicineContext(telegramId, {
    medicineName: "Pregabalin",
    genericName: "Pregabalin",
    query: "Pregabalin",
  });

  const followUps = ["can I take it daily?", "can my father use it?", "what is the generic?"];

  for (const follow of followUps) {
    await t.test(`follow-up resolves to Pregabalin: "${follow}"`, async () => {
      const result = await resolveContextualQuery(telegramId, follow);
      const resolvedQuery = String(result.query || "").toLowerCase();
      assert.equal(
        result.usedContext,
        true,
        `expected usedContext=true for follow-up "${follow}", got ${JSON.stringify(result)}`
      );
      assert.ok(
        resolvedQuery.includes("pregabalin"),
        `expected resolved query to reference Pregabalin for "${follow}", got "${result.query}"`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Sequence C — Context switch on an explicit new medicine. The conversation
// service signals a switch (usedContext=false) when the user names a new
// medicine; once the caller stores that context (as search.js does after a
// successful search), follow-ups resolve to the NEW medicine.
// ---------------------------------------------------------------------------

test("Sequence C — explicit new medicine switches context away from Pregabalin", async (t) => {
  const telegramId = "explore-C";

  await t.test(
    "'Telmisartan side effects' does NOT resolve to Pregabalin",
    async () => {
      clearActiveContext(telegramId);
      setActiveMedicineContext(telegramId, {
        medicineName: "Pregabalin",
        genericName: "Pregabalin",
        query: "Pregabalin",
      });
      const result = await resolveContextualQuery(telegramId, "Telmisartan side effects");
      const resolvedQuery = String(result.query || "").toLowerCase();
      assert.ok(
        !resolvedQuery.includes("pregabalin"),
        `expected resolved query NOT to reference Pregabalin, got "${result.query}" (usedContext=${result.usedContext})`
      );
    }
  );

  await t.test(
    "after the caller stores the new medicine, follow-ups resolve to Telmisartan",
    async () => {
      clearActiveContext(telegramId);
      setActiveMedicineContext(telegramId, {
        medicineName: "Pregabalin",
        genericName: "Pregabalin",
        query: "Pregabalin",
      });

      // User explicitly names a new medicine → service signals a switch.
      const switchTurn = await resolveContextualQuery(telegramId, "Telmisartan");
      assert.equal(
        switchTurn.usedContext,
        false,
        "explicit new medicine should signal a context switch (usedContext=false)"
      );

      // Production wiring: search.js stores the new context after a successful
      // search. Simulate that here.
      setActiveMedicineContext(telegramId, {
        medicineName: "Telmisartan",
        genericName: "Telmisartan",
        query: "Telmisartan",
      });

      const followUp = await resolveContextualQuery(telegramId, "what does it do?");
      const resolvedQuery = String(followUp.query || "").toLowerCase();
      assert.ok(
        !resolvedQuery.includes("pregabalin"),
        `expected follow-up NOT to reference Pregabalin, got "${followUp.query}"`
      );
      assert.ok(
        resolvedQuery.includes("telmisartan"),
        `expected follow-up to reference Telmisartan, got "${followUp.query}"`
      );
    }
  );
});
