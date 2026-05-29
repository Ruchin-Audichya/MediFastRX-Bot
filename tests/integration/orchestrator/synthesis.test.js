"use strict";

/**
 * Task 7.4 — integration test for synthesis flow + deterministic fallback.
 *
 *   Property 5 (Graceful Degradation): for any Groq failure / timeout /
 *   disabled state, the system MUST NOT change the deterministic medicine
 *   identity and MUST still produce a response (deterministic card and/or
 *   deterministic evidence).
 *
 * **Validates: Requirements 2.9, 3.3, 3.7**
 *
 * This test drives `runMediFastWorkflow` end-to-end with the upstream stages
 * (workflow planner, tool executor, response merger, conversation context)
 * shimmed via `tests/_mocks/installShims.js`. It exercises the real
 * orchestrator + provider + base prompt builder paths so that the
 * deterministic-card fallback is genuinely produced by `renderDeterministicCard`
 * inside the orchestrator.
 *
 * No real Mongo / Chroma / Groq / network is touched. `globalThis.fetch` is
 * stubbed and restored per subtest. Env vars are restored per subtest.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { stubModule, REPO_ROOT } = require("../../_mocks/installShims");
const {
  createMedicineContext,
} = require(path.join(REPO_ROOT, "src/context/medicineContext.js"));

// ---------------------------------------------------------------------------
// Shims — installed BEFORE requiring the orchestrator so it picks them up.
// ---------------------------------------------------------------------------

const buildPlan = (query) => ({
  query,
  entities: { medicine: "Pregabalin" },
  routes: [{ tool: "rag", confidence: 0.9 }],
  location: null,
  toolSequence: ["medicineKnowledge", "knowledge"],
  execute: { rag: true, medicine: true, memory: false, family: false, nearby: false },
});

stubModule("src/orchestrator/workflowPlanner.js", {
  planWorkflow: ({ query }) => buildPlan(query),
});

const TOOL_RESULTS = {
  medicineKnowledge: {
    ok: true,
    value: {
      medicine: {
        medicineName: "Pregabalin",
        genericName: "Pregabalin",
        aliases: ["Lyrica"],
        salts: ["Pregabalin"],
        category: "neuropathic_pain",
        symptoms: ["nerve pain"],
        sideEffects: [{ effect: "dizziness" }],
      },
      alternatives: [{ medicineName: "Gabapentin" }],
      relationships: [{ type: "same_class", from: "Pregabalin", to: "Gabapentin" }],
      confidence: 0.9,
    },
  },
  knowledge: {
    ok: true,
    value: {
      context: [
        {
          text: "Pregabalin causes dizziness",
          metadata: { medicine: "Pregabalin" },
          confidence: 0.85,
        },
      ],
      confidence: 0.85,
      lowConfidence: false,
    },
  },
  __trace: [
    { tool: "searchMedicineKnowledge", ok: true },
    { tool: "retrieveKnowledge", ok: true },
  ],
};

stubModule("src/orchestrator/toolExecutor.js", {
  executeWorkflowTools: async () => TOOL_RESULTS,
});

// Identity-passthrough merger so subtests can assert on the orchestrator's
// raw shape without reimplementing the safety/debug fields.
stubModule("src/orchestrator/responseMerger.js", {
  mergeWorkflowResponse: ({ providerResult, evidence, plan, query, orchestrationLatencyMs }) => ({
    query,
    plan,
    generated: providerResult,
    evidence,
    orchestrationLatencyMs,
  }),
});

// Conversation context — return a real frozen MedicineContext via the
// production factory so the evidence-integrity guard runs over it.
const ACTIVE_CONTEXT = createMedicineContext({
  resolution: {
    medicine: {
      _id: "med-pregabalin",
      medicineName: "Pregabalin",
      genericName: "Pregabalin",
      aliases: ["Lyrica"],
      salts: ["Pregabalin"],
      brands: ["Lyrica"],
      category: "neuropathic_pain",
    },
    confidence: 0.92,
    method: "direct knowledge match",
  },
  conversationId: "u-1",
  userId: "u-1",
  now: 1_700_000_000_000,
});

stubModule("src/services/conversationContextService.js", {
  getActiveContext: () => ACTIVE_CONTEXT,
  getActiveMedicineScope: () => ({
    medicineName: "Pregabalin",
    genericName: "Pregabalin",
    aliases: ["Lyrica"],
    salts: ["Pregabalin"],
    category: "neuropathic_pain",
  }),
  setActiveMedicineContext: () => ACTIVE_CONTEXT,
  resolveContextualQuery: async (_id, text) => ({
    query: text,
    usedContext: false,
    context: ACTIVE_CONTEXT,
  }),
  clearActiveContext: () => true,
});

// AFTER shims — require the real orchestrator so it picks up the stubs above.
const { runMediFastWorkflow } = require(path.join(
  REPO_ROOT,
  "src/orchestrator/orchestrator.js"
));

// ---------------------------------------------------------------------------
// Per-subtest env + fetch save/restore.
// ---------------------------------------------------------------------------

const ENV_KEYS = ["ENABLE_LLM_SYNTHESIS", "GROQ_API_KEY", "GROQ_MODEL", "LLM_PROVIDER", "AI_PROVIDER"];

const snapshotEnv = () => {
  const snap = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
};

const restoreEnv = (snap) => {
  for (const k of ENV_KEYS) {
    if (snap[k] === undefined) delete process.env[k];
    else process.env[k] = snap[k];
  }
};

const installFetchStub = (impl) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    if (original === undefined) delete globalThis.fetch;
    else globalThis.fetch = original;
  };
};

// ===========================================================================
// 1. Synthesis OFF → deterministic card.
// ===========================================================================

test("Property 5 — synthesis OFF produces a deterministic card", async (t) => {
  const envSnap = snapshotEnv();
  process.env.ENABLE_LLM_SYNTHESIS = "false";
  // Make sure no fetch is called even by accident — fail loudly if it is.
  const restoreFetch = installFetchStub(async () => {
    throw new Error("fetch must not be called when synthesis is OFF");
  });
  t.after(() => {
    restoreFetch();
    restoreEnv(envSnap);
  });

  const result = await runMediFastWorkflow({
    query: "side effects",
    profile: null,
    telegramId: "u-1",
  });

  assert.equal(result.generated.provider, "deterministic", "provider must be deterministic");
  assert.equal(result.generated.skipped, true, "skipped flag must be set when synthesis is off");
  assert.ok(
    typeof result.generated.text === "string" && result.generated.text.length > 0,
    "deterministic text must be non-empty"
  );
  assert.ok(
    /Pregabalin/.test(result.generated.text),
    `deterministic card should mention the active medicine, got: ${result.generated.text}`
  );
});

// ===========================================================================
// 2. Synthesis ON + Groq fails (network) → deterministic-card-fallback.
// ===========================================================================

test("Property 5 — Groq network failure falls back deterministically", async (t) => {
  const envSnap = snapshotEnv();
  process.env.ENABLE_LLM_SYNTHESIS = "true";
  process.env.GROQ_API_KEY = "x";
  process.env.LLM_PROVIDER = "groq";
  const restoreFetch = installFetchStub(async () => {
    throw new Error("network down");
  });
  t.after(() => {
    restoreFetch();
    restoreEnv(envSnap);
  });

  const result = await runMediFastWorkflow({
    query: "side effects",
    profile: null,
    telegramId: "u-1",
  });

  assert.equal(result.generated.fallbackUsed, true, "fallbackUsed must be true on network failure");
  assert.equal(result.generated.provider, "deterministic", "provider must be deterministic on fallback");
  assert.equal(
    result.generated.model,
    "deterministic-card-fallback",
    `model must be deterministic-card-fallback, got: ${result.generated.model}`
  );
  assert.ok(
    /Pregabalin/.test(result.generated.text),
    `fallback text should mention Pregabalin, got: ${result.generated.text}`
  );

  // Property 5 — identity is unchanged: evidence shape preserved.
  assert.ok(result.evidence, "evidence object should be present");
  assert.ok(result.evidence.medicineContext, "evidence.medicineContext should exist");
  assert.equal(
    result.evidence.medicineContext.medicine.medicineName,
    "Pregabalin",
    "active medicine identity must be preserved through the fallback"
  );
  assert.equal(
    result.evidence.medicineContext.medicine.genericName,
    "Pregabalin",
    "generic identity must be preserved through the fallback"
  );
  // ragContext shape preserved (validated chunk surfaced through the integrity guard).
  assert.ok(Array.isArray(result.evidence.ragContext.context), "ragContext.context must be an array");
});

// ===========================================================================
// 3. Synthesis ON + Groq returns empty text → deterministic fallback.
// ===========================================================================

test("Property 5 — Groq empty response falls back deterministically", async (t) => {
  const envSnap = snapshotEnv();
  process.env.ENABLE_LLM_SYNTHESIS = "true";
  process.env.GROQ_API_KEY = "x";
  process.env.LLM_PROVIDER = "groq";
  const restoreFetch = installFetchStub(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: "" } }] }),
    text: async () => "",
  }));
  t.after(() => {
    restoreFetch();
    restoreEnv(envSnap);
  });

  const result = await runMediFastWorkflow({
    query: "side effects",
    profile: null,
    telegramId: "u-1",
  });

  assert.equal(result.generated.fallbackUsed, true, "fallbackUsed must be true on empty content");
  assert.equal(result.generated.provider, "deterministic", "provider must be deterministic on fallback");
  assert.equal(result.generated.model, "deterministic-card-fallback");
  assert.ok(
    /Pregabalin/.test(result.generated.text),
    `fallback text should mention Pregabalin, got: ${result.generated.text}`
  );
  assert.equal(
    result.evidence.medicineContext.medicine.medicineName,
    "Pregabalin",
    "active medicine identity preserved on empty-response fallback"
  );
});

// ===========================================================================
// 4. Synthesis ON + Groq returns text → use LLM text (sanitized).
// ===========================================================================

test("synthesis ON + valid Groq response uses LLM text (sanitized)", async (t) => {
  const envSnap = snapshotEnv();
  process.env.ENABLE_LLM_SYNTHESIS = "true";
  process.env.GROQ_API_KEY = "x";
  process.env.LLM_PROVIDER = "groq";
  const restoreFetch = installFetchStub(async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "Pregabalin can cause dizziness in some people." } }],
    }),
    text: async () => "",
  }));
  t.after(() => {
    restoreFetch();
    restoreEnv(envSnap);
  });

  const result = await runMediFastWorkflow({
    query: "side effects",
    profile: null,
    telegramId: "u-1",
  });

  assert.equal(result.generated.provider, "groq", `provider should be groq, got: ${result.generated.provider}`);
  assert.ok(
    !result.generated.fallbackUsed,
    `fallbackUsed should be falsy on success, got: ${result.generated.fallbackUsed}`
  );
  assert.equal(
    result.generated.text,
    "Pregabalin can cause dizziness in some people.",
    "Groq text should be returned verbatim through the sanitizer"
  );
  // Identity unchanged — evidence still carries Pregabalin.
  assert.equal(result.evidence.medicineContext.medicine.medicineName, "Pregabalin");
});
