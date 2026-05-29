"use strict";

/**
 * Bug condition exploration test for the "medicine context integrity" bugfix.
 *
 *   Property 1 — Bug Condition: When a medicine has been resolved with
 *   confidence >= MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD, every downstream stage
 *   (RAG retrieval, evidence collection, follow-up resolution, context switch)
 *   SHALL operate scoped to that medicine.
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8**
 *
 * IMPORTANT: This test runs against the UNFIXED pipeline. It is designed to
 * FAIL — the failures are the counterexamples that confirm the bug exists.
 * Do NOT "fix" this test or the production code from inside this file. The
 * bugfix lands in subsequent tasks (Phases 1–4), which will turn these
 * assertions green.
 *
 * Test framework: node:test (built-in, no new deps).
 *
 * The test deliberately bypasses MongoDB, ChromaDB, Groq, and the network by
 * pre-populating `require.cache` for `src/ai/toolRegistry.js` with deterministic
 * in-memory fakes BEFORE requiring `src/orchestrator/toolExecutor.js`.
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
// Install shims for the production tool registry. We must do this BEFORE the
// orchestrator modules are required, so they pick up our fake `getTool` and
// never reach Mongo/Chroma/Groq.
// ----------------------------------------------------------------------------

const toolMap = {
  searchMedicineKnowledge: {
    name: "searchMedicineKnowledge",
    execute: ({ query }) => fakeSearchMedicineKnowledge({ query }),
  },
  retrieveKnowledge: {
    name: "retrieveKnowledge",
    // Mirror the production signature: `({ question, metadata })`. The bug is
    // that `toolExecutor` calls this WITHOUT a `medicineScope` and without any
    // medicine-scoped metadata, so the fake (like the real retriever) returns
    // a mixed-medicine result for queries like "side effects".
    execute: ({ question, metadata }) =>
      fakeRetrieveKnowledge({ question, metadata, k: 5 }),
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

// Now require production modules — they will see the stubbed registry.
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

const { setActiveMedicineContext, resolveContextualQuery } =
  conversationContextService;

// ---------------------------------------------------------------------------
// Sequence A — RAG / Evidence contamination under an active Pregabalin context.
// ---------------------------------------------------------------------------
//
// Bug clauses 1.2, 1.3, 1.6:
//   * `toolExecutor` calls `retrieveKnowledge({ question: plan.query })` with
//     raw text and no medicine metadata filter.
//   * `reranker` has no medicine signal.
//   * `evidenceCollector` does not validate metadata against the resolved
//     medicine.
//
// On UNFIXED code we expect Gabapentin / Alprazolam chunks to leak into
// `evidence.ragContext.context` even though the active medicine is Pregabalin.

test("Sequence A — RAG/evidence contamination under active Pregabalin", async (t) => {
  const telegramId = "explore-A";
  setActiveMedicineContext(telegramId, {
    medicineName: "Pregabalin",
    genericName: "Pregabalin",
    query: "Pregabalin",
  });

  const plan = {
    query: "side effects",
    entities: {
      medicine: "Pregabalin",
      normalizedMedicineQuery: "Pregabalin",
    },
    routes: [{ tool: "rag" }, { tool: "medicine" }],
    execute: {
      family: false,
      medicine: true,
      memory: false,
      rag: true,
      nearby: false,
    },
  };

  const toolResults = await executeWorkflowTools({
    plan,
    telegramId,
    profile: null,
  });
  const evidence = collectEvidence({
    query: plan.query,
    plan,
    toolResults,
  });

  const ragItems = evidence.ragContext.context;
  const activeMedicine = "Pregabalin";

  // Capture the contaminated chunks for the failure message — these are the
  // counterexamples that prove the bug exists.
  const contaminated = ragItems.filter((item) => {
    const tag = (item.medicine || item.generic || "").toLowerCase();
    if (!tag) return false; // neutral / guideline chunks are allowed
    return tag !== activeMedicine.toLowerCase();
  });

  await t.test(
    "every surfaced RAG chunk belongs to the active medicine (Pregabalin)",
    () => {
      assert.deepEqual(
        contaminated.map((c) => ({
          medicine: c.medicine,
          generic: c.generic,
          source: c.source,
        })),
        [],
        "expected zero contaminated chunks under active Pregabalin context, got: " +
          JSON.stringify(contaminated, null, 2)
      );
    }
  );

  await t.test(
    "evidence.ragContext should expose a contamination report (none present today)",
    () => {
      assert.ok(
        evidence.ragContext.contamination,
        "expected evidence.ragContext.contamination report after evidence-integrity guard; " +
          "today the field is undefined — confirming clause 1.6 (evidence not validated)."
      );
    }
  );

  // Sanity: the fake KB really does contain the contaminating chunks. If this
  // sanity check ever fails we know the test setup itself drifted, not the bug.
  const sanityHasGabapentin = CHUNKS.some(
    (c) => c.metadata.medicine === "Gabapentin"
  );
  assert.equal(
    sanityHasGabapentin,
    true,
    "fakeKnowledgeBase must seed at least one Gabapentin chunk"
  );
});

// ---------------------------------------------------------------------------
// Sequence B — Follow-up loss outside the hardcoded regex set.
// ---------------------------------------------------------------------------
//
// Bug clauses 1.4, 1.5: the current `resolveContextualQuery` uses a small
// regex set that misses "can I take it daily?", "can my father use it?",
// and "what is the generic?". Each of those should resolve against the active
// Pregabalin context but does not.

test("Sequence B — Follow-up phrasings outside the hardcoded regex set", async (t) => {
  const telegramId = "explore-B";
  setActiveMedicineContext(telegramId, {
    medicineName: "Pregabalin",
    genericName: "Pregabalin",
    query: "Pregabalin",
  });

  const followUps = [
    "can I take it daily?",
    "can my father use it?",
    "what is the generic?",
  ];

  for (const follow of followUps) {
    await t.test(`follow-up resolves to Pregabalin: "${follow}"`, async () => {
      const result = await resolveContextualQuery(telegramId, follow);
      const resolvedQuery = String(result.query || "").toLowerCase();
      const activeMedicine = "pregabalin";

      assert.equal(
        result.usedContext,
        true,
        `expected usedContext=true for follow-up "${follow}", got ` +
          JSON.stringify(result)
      );
      assert.ok(
        resolvedQuery.includes(activeMedicine),
        `expected resolved query to reference Pregabalin for follow-up "${follow}", ` +
          `got query="${result.query}"`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// Sequence C — Context switch failure for medicines outside the hardcoded
// regex (e.g., "Telmisartan").
// ---------------------------------------------------------------------------
//
// Bug clauses 1.7, 1.8: `hasExplicitMedicineLikeText` only knows a small list
// of medicines (dolo, crocin, pregabalin, alprax, modafinil, telma, montek,
// aciloc, glycomet, ...). Anything else (Telmisartan, Atorvastatin, Cetirizine,
// ...) is misrouted as a follow-up against the previously active medicine.

test("Sequence C — Context switch failure for medicines outside the regex", async (t) => {
  const telegramId = "explore-C";
  setActiveMedicineContext(telegramId, {
    medicineName: "Pregabalin",
    genericName: "Pregabalin",
    query: "Pregabalin",
  });

  await t.test(
    "explicit new medicine ('Telmisartan side effects') should NOT resolve to Pregabalin",
    async () => {
      const result = await resolveContextualQuery(
        telegramId,
        "Telmisartan side effects"
      );
      const resolvedQuery = String(result.query || "").toLowerCase();

      // The user explicitly named Telmisartan. The pipeline must either treat
      // this as a fresh medicine query (usedContext=false) or rewrite it as
      // "side effects of Telmisartan". On unfixed code it rewrites to
      // "side effects of Pregabalin" — that is the bug.
      assert.ok(
        !resolvedQuery.includes("pregabalin"),
        `expected resolved query NOT to reference Pregabalin when user said "Telmisartan side effects", ` +
          `got query="${result.query}", usedContext=${result.usedContext}`
      );
      // And, if the system did rewrite, it should reference Telmisartan.
      if (result.usedContext) {
        assert.ok(
          resolvedQuery.includes("telmisartan"),
          `usedContext=true but resolved query did not mention Telmisartan: query="${result.query}"`
        );
      }
    }
  );

  await t.test(
    "follow-up after typing 'Telmisartan' should resolve against Telmisartan, not Pregabalin",
    async () => {
      // Simulate: user types only "Telmisartan" (a fresh medicine). The current
      // pipeline does not switch the active context here because
      // `hasExplicitMedicineLikeText("Telmisartan")` returns false — neither the
      // hardcoded regex nor the long-word (>12 chars) fallback fires.
      await resolveContextualQuery(telegramId, "Telmisartan");

      // Then the user asks a generic follow-up. On a fixed pipeline this would
      // resolve against Telmisartan; on unfixed code it still resolves against
      // Pregabalin.
      const followUp = await resolveContextualQuery(telegramId, "what does it do?");
      const resolvedQuery = String(followUp.query || "").toLowerCase();

      assert.ok(
        !resolvedQuery.includes("pregabalin"),
        `expected follow-up after "Telmisartan" NOT to reference Pregabalin, ` +
          `got query="${followUp.query}", context=${JSON.stringify(followUp.context)}`
      );
      assert.ok(
        resolvedQuery.includes("telmisartan"),
        `expected follow-up after "Telmisartan" to reference Telmisartan, ` +
          `got query="${followUp.query}"`
      );
    }
  );

  await t.test(
    "explicit Dolo650 turn followed by 'what does it do?' should resolve to Dolo650",
    async () => {
      // Reset context to Pregabalin to keep this sub-case independent.
      setActiveMedicineContext(telegramId, {
        medicineName: "Pregabalin",
        genericName: "Pregabalin",
        query: "Pregabalin",
      });

      // Step 1: user explicitly names a new medicine. With the current
      // `hasExplicitMedicineLikeText` regex, "Dolo650" does NOT match `\bdolo\b`
      // (digits attach as word chars and break the boundary), and the
      // long-word fallback requires length > 12.
      await resolveContextualQuery(telegramId, "Now tell me about Dolo650");

      // Step 2: the production search.js path would only call
      // setActiveMedicineContext AFTER a successful searchMedicine. We do NOT
      // simulate that here, because the bug under test is the conversation
      // service's own ability to detect a context switch.
      const followUp = await resolveContextualQuery(telegramId, "what does it do?");
      const resolvedQuery = String(followUp.query || "").toLowerCase();

      assert.ok(
        !resolvedQuery.includes("pregabalin"),
        `expected follow-up after "Now tell me about Dolo650" NOT to reference Pregabalin, ` +
          `got query="${followUp.query}", context=${JSON.stringify(followUp.context)}`
      );
    }
  );
});
