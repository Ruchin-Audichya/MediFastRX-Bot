"use strict";

/**
 * P5 — Graceful degradation of external deps.
 *
 * For any Groq failure mode (network throw / non-OK / empty content / disabled),
 * `runMediFastWorkflow` MUST:
 *   - return a result whose `evidence.medicineContext.medicine.medicineName`
 *     equals the active medicine,
 *   - and `generated.text` is non-empty (deterministic card carries through).
 *
 * **Validates: Requirements 2.9, 3.3, 3.7**
 *
 * Mirrors the shim pattern from tests/integration/orchestrator/synthesis.test.js
 * but parameterized over (seed, failureMode, activeMedicine).
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { stubModule, REPO_ROOT } = require("../_mocks/installShims");
const {
  createMedicineContext,
} = require(path.join(REPO_ROOT, "src/context/medicineContext.js"));
const { makeRng, MEDICINES } = require("../_gen");

// ---- Shims (installed BEFORE the orchestrator is required) ----------------

let activeMed = MEDICINES[0]; // mutated per seed

const buildPlan = (query) => ({
  query,
  entities: { medicine: activeMed.medicineName },
  routes: [{ tool: "rag", confidence: 0.9 }],
  location: null,
  toolSequence: ["medicineKnowledge", "knowledge"],
  execute: { rag: true, medicine: true, memory: false, family: false, nearby: false },
});

stubModule("src/orchestrator/workflowPlanner.js", {
  planWorkflow: ({ query }) => buildPlan(query),
});

stubModule("src/orchestrator/toolExecutor.js", {
  executeWorkflowTools: async () => ({
    medicineKnowledge: {
      ok: true,
      value: {
        medicine: { ...activeMed },
        alternatives: [{ medicineName: "Other" }],
        relationships: [],
        confidence: 0.9,
      },
    },
    knowledge: {
      ok: true,
      value: {
        context: [
          {
            text: `${activeMed.medicineName} info`,
            metadata: { medicine: activeMed.medicineName, generic: activeMed.genericName },
            confidence: 0.85,
          },
        ],
        confidence: 0.85,
        lowConfidence: false,
      },
    },
    __trace: [{ tool: "searchMedicineKnowledge", ok: true }, { tool: "retrieveKnowledge", ok: true }],
  }),
});

stubModule("src/orchestrator/responseMerger.js", {
  mergeWorkflowResponse: ({ providerResult, evidence, plan, query, orchestrationLatencyMs }) => ({
    query,
    plan,
    generated: providerResult,
    evidence,
    orchestrationLatencyMs,
  }),
});

let cachedContext = null;
const buildContext = () => createMedicineContext({
  resolution: { medicine: activeMed, confidence: 0.92, method: "p5" },
  conversationId: "p5",
  userId: "p5",
  now: 1_700_000_000_000,
});
stubModule("src/services/conversationContextService.js", {
  getActiveContext: () => cachedContext,
  getActiveMedicineScope: () => ({
    medicineName: activeMed.medicineName,
    genericName: activeMed.genericName,
    aliases: activeMed.aliases || [],
    salts: activeMed.salts || [],
    category: activeMed.category || null,
  }),
  setActiveMedicineContext: () => cachedContext,
  resolveContextualQuery: async (_id, text) => ({
    query: text,
    usedContext: false,
    context: cachedContext,
  }),
  clearActiveContext: () => true,
});

const { runMediFastWorkflow } = require(path.join(REPO_ROOT, "src/orchestrator/orchestrator.js"));

// ---- Helpers --------------------------------------------------------------

const ENV_KEYS = ["ENABLE_LLM_SYNTHESIS", "GROQ_API_KEY", "LLM_PROVIDER", "AI_PROVIDER"];
const snapshotEnv = () => Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
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

const FAILURE_MODES = [
  {
    name: "network-throw",
    setup: (envSnap) => {
      process.env.ENABLE_LLM_SYNTHESIS = "true";
      process.env.GROQ_API_KEY = "x";
      process.env.LLM_PROVIDER = "groq";
      return installFetchStub(async () => { throw new Error("network down"); });
    },
  },
  {
    name: "401-not-ok",
    setup: () => {
      process.env.ENABLE_LLM_SYNTHESIS = "true";
      process.env.GROQ_API_KEY = "x";
      process.env.LLM_PROVIDER = "groq";
      return installFetchStub(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ error: "unauthorized" }),
        text: async () => "unauthorized",
      }));
    },
  },
  {
    name: "empty-content",
    setup: () => {
      process.env.ENABLE_LLM_SYNTHESIS = "true";
      process.env.GROQ_API_KEY = "x";
      process.env.LLM_PROVIDER = "groq";
      return installFetchStub(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "" } }] }),
        text: async () => "",
      }));
    },
  },
  {
    name: "synthesis-disabled",
    setup: () => {
      process.env.ENABLE_LLM_SYNTHESIS = "false";
      return installFetchStub(async () => {
        throw new Error("fetch must not be called when synthesis is OFF");
      });
    },
  },
];

const SEEDS = [1, 7, 42, 137];

test("P5 — every Groq failure mode preserves identity and produces non-empty deterministic text", async (t) => {
  for (const seed of SEEDS) {
    const rng = makeRng(seed);
    activeMed = MEDICINES[Math.floor(rng() * MEDICINES.length) % MEDICINES.length];
    cachedContext = buildContext();

    for (const mode of FAILURE_MODES) {
      const envSnap = snapshotEnv();
      const restoreFetch = mode.setup(envSnap);
      try {
        const result = await runMediFastWorkflow({
          query: "side effects",
          profile: null,
          telegramId: "p5-user",
        });

        // Identity preserved.
        assert.equal(
          result.evidence.medicineContext.medicine.medicineName,
          activeMed.medicineName,
          `seed=${seed} mode=${mode.name}: medicineName must be preserved`,
        );

        // Text non-empty AND mentions the active medicine.
        const text = String(result.generated.text || "");
        assert.ok(
          text.length > 0,
          `seed=${seed} mode=${mode.name}: generated.text must be non-empty`,
        );
        assert.ok(
          text.includes(activeMed.medicineName),
          `seed=${seed} mode=${mode.name}: deterministic card should mention ${activeMed.medicineName}, got: ${text}`,
        );

        // Provider should be deterministic (either skipped or fallback).
        assert.equal(result.generated.provider, "deterministic");
      } finally {
        restoreFetch();
        restoreEnv(envSnap);
      }
    }
  }
});
