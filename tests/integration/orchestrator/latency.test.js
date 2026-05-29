"use strict";

/**
 * Phase 6 / Task 8.5 — integration test for parallelism, cache hit/miss,
 * latency budgets, and two-stage env-flag scaffolding.
 *
 *   - `tool.latency` events are emitted per-tool by toolExecutor (Task 8.1).
 *   - `latency.toolExecutor` / `latency.evidenceCollector` /
 *     `latency.provider` / `latency.endToEnd` events are emitted by the
 *     orchestrator (Task 8.4).
 *   - The retrieval slot of the response cache (Task 8.2) is consulted
 *     before the parallel fan-out and skipped on cache hit.
 *   - The two-stage send scaffolding in `src/bot/commands/search.js`
 *     (Task 8.3) exposes its env-flag helpers for this test.
 *
 * Budgets asserted on mocked deps:
 *   endToEnd.p95 < 1500ms (deterministic-only)
 *   endToEnd.p95 < 3500ms (LLM enabled)
 *
 * **Validates: Requirements 2.9, 3.4**
 *
 * No real Mongo / Chroma / Groq / network is touched. The toolRegistry is
 * shimmed so each "tool" is a controllable sleep, and `globalThis.fetch` is
 * replaced for the LLM subtest.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { stubModule, REPO_ROOT } = require("../../_mocks/installShims");
const eventBus = require(path.join(REPO_ROOT, "src/events/eventBus.js"));
const responseCache = require(path.join(REPO_ROOT, "src/cache/responseCache.js"));
const {
  createMedicineContext,
} = require(path.join(REPO_ROOT, "src/context/medicineContext.js"));

// ---------------------------------------------------------------------------
// Tunable mock latencies. Subtests can flip these via the closure variables
// rather than re-stubbing the module each time.
// ---------------------------------------------------------------------------
const mockState = {
  medicineKnowledgeMs: 0,
  memoryMs: 0,
  knowledgeMs: 0,
  // The shimmed tools record how often their `execute` was invoked. This is
  // how the cache-hit subtest verifies that `retrieveKnowledge` was NOT
  // called the second time around.
  callCount: { searchMedicineKnowledge: 0, retrieveRelevantMemory: 0, retrieveKnowledge: 0 },
};

const sleep = (ms) =>
  new Promise((resolve) => {
    if (!ms || ms <= 0) resolve();
    else setTimeout(resolve, ms);
  });

const FAKE_TOOL_REGISTRY = {
  searchMedicineKnowledge: {
    name: "searchMedicineKnowledge",
    execute: async () => {
      mockState.callCount.searchMedicineKnowledge += 1;
      await sleep(mockState.medicineKnowledgeMs);
      return {
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
      };
    },
  },
  retrieveRelevantMemory: {
    name: "retrieveRelevantMemory",
    execute: async () => {
      mockState.callCount.retrieveRelevantMemory += 1;
      await sleep(mockState.memoryMs);
      return { facts: [], confidence: 0.0 };
    },
  },
  retrieveKnowledge: {
    name: "retrieveKnowledge",
    execute: async () => {
      mockState.callCount.retrieveKnowledge += 1;
      await sleep(mockState.knowledgeMs);
      return {
        context: [
          {
            text: "Pregabalin causes dizziness",
            metadata: { medicine: "Pregabalin" },
            confidence: 0.85,
          },
        ],
        confidence: 0.85,
        lowConfidence: false,
      };
    },
  },
};

stubModule("src/ai/toolRegistry.js", {
  getTool: (name) => FAKE_TOOL_REGISTRY[name] || null,
  listTools: () => Object.values(FAKE_TOOL_REGISTRY),
  toLangChainTools: () => [],
  tools: FAKE_TOOL_REGISTRY,
});

// Workflow planner — fixed plan that requests medicine + memory + rag.
stubModule("src/orchestrator/workflowPlanner.js", {
  planWorkflow: ({ query }) => ({
    query,
    entities: { medicine: "Pregabalin" },
    routes: [{ tool: "rag", confidence: 0.9 }],
    location: null,
    toolSequence: ["medicineKnowledge", "memory", "knowledge"],
    execute: { rag: true, medicine: true, memory: true, family: false, nearby: false },
  }),
});

// Identity-passthrough merger so we do not depend on safety/debug fields.
stubModule("src/orchestrator/responseMerger.js", {
  mergeWorkflowResponse: ({ providerResult, evidence, plan, query, orchestrationLatencyMs }) => ({
    query,
    plan,
    generated: providerResult,
    evidence,
    orchestrationLatencyMs,
  }),
});

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

// Now require the real orchestrator (which pulls the real toolExecutor +
// evidenceCollector through the shimmed registry above).
const { runMediFastWorkflow } = require(path.join(
  REPO_ROOT,
  "src/orchestrator/orchestrator.js"
));

// ---------------------------------------------------------------------------
// Helpers — env + fetch save/restore, latency event recorder, p95.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  "ENABLE_LLM_SYNTHESIS",
  "GROQ_API_KEY",
  "GROQ_MODEL",
  "LLM_PROVIDER",
  "AI_PROVIDER",
  "ENABLE_TWO_STAGE_SEND",
  "LLM_EDIT_BUDGET_MS",
  "TYPING_THRESHOLD_MS",
];

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

const recordLatencyEvents = () => {
  const events = {
    "tool.latency": [],
    "latency.toolExecutor": [],
    "latency.evidenceCollector": [],
    "latency.provider": [],
    "latency.endToEnd": [],
  };
  const handlers = {};
  for (const name of Object.keys(events)) {
    handlers[name] = (payload) => events[name].push(payload);
    eventBus.on(name, handlers[name]);
  }
  const detach = () => {
    for (const name of Object.keys(events)) {
      eventBus.removeListener(name, handlers[name]);
    }
  };
  return { events, detach };
};

const p95 = (samples) => {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  // Inclusive p95 — for 5 samples, idx = ceil(5*0.95) - 1 = 4 (the max).
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[Math.max(0, idx)];
};

const resetMockState = () => {
  mockState.medicineKnowledgeMs = 0;
  mockState.memoryMs = 0;
  mockState.knowledgeMs = 0;
  mockState.callCount = {
    searchMedicineKnowledge: 0,
    retrieveRelevantMemory: 0,
    retrieveKnowledge: 0,
  };
  responseCache.clear();
};

// ===========================================================================
// 1. Parallelism — independent tools fan out via Promise.all.
// ===========================================================================

test("Task 8.1 parallelism — toolExecutor latency < sum of tool sleeps", async (t) => {
  const envSnap = snapshotEnv();
  process.env.ENABLE_LLM_SYNTHESIS = "false";
  resetMockState();
  // Each independent tool sleeps 200ms — sequential would be ≥600ms; the
  // parallel toolExecutor should be <500ms with comfortable headroom.
  mockState.medicineKnowledgeMs = 200;
  mockState.memoryMs = 200;
  mockState.knowledgeMs = 200;

  const { events, detach } = recordLatencyEvents();
  t.after(() => {
    detach();
    restoreEnv(envSnap);
    resetMockState();
  });

  await runMediFastWorkflow({
    query: "side effects",
    profile: null,
    telegramId: "u-1",
  });

  assert.equal(events["latency.toolExecutor"].length, 1, "toolExecutor latency event must be emitted exactly once");
  const toolExecLatency = events["latency.toolExecutor"][0].latencyMs;
  assert.ok(
    toolExecLatency < 500,
    `parallel toolExecutor latency must be < 500ms (3x200ms sequential would be ≥600ms), got ${toolExecLatency}ms`
  );

  // All three independent tools must have been entered.
  const toolEvents = events["tool.latency"].filter((e) =>
    ["searchMedicineKnowledge", "retrieveRelevantMemory", "retrieveKnowledge"].includes(e.tool)
  );
  assert.equal(toolEvents.length, 3, "each parallel tool must emit a tool.latency event");
});

// ===========================================================================
// 2. Cache hit/miss correctness.
// ===========================================================================

test("Task 8.2 cache — second turn for the same medicine emits a cache-hit tool.latency with 0ms", async (t) => {
  const envSnap = snapshotEnv();
  process.env.ENABLE_LLM_SYNTHESIS = "false";
  resetMockState();
  mockState.knowledgeMs = 50; // make the miss observable

  const { events, detach } = recordLatencyEvents();
  t.after(() => {
    detach();
    restoreEnv(envSnap);
    resetMockState();
  });

  // First turn — miss → calls retrieveKnowledge once and stores the result.
  await runMediFastWorkflow({
    query: "Pregabalin",
    profile: null,
    telegramId: "u-1",
  });
  assert.equal(
    mockState.callCount.retrieveKnowledge,
    1,
    "first turn must invoke retrieveKnowledge"
  );

  // Second turn — same telegramId + same normalized medicine query → hit.
  await runMediFastWorkflow({
    query: "Pregabalin",
    profile: null,
    telegramId: "u-1",
  });
  assert.equal(
    mockState.callCount.retrieveKnowledge,
    1,
    "second turn must NOT re-invoke retrieveKnowledge (cache hit)"
  );

  // The cache-hit emission shape: latencyMs===0 AND cacheHit===true.
  const knowledgeLatencies = events["tool.latency"].filter((e) => e.tool === "retrieveKnowledge");
  assert.equal(knowledgeLatencies.length, 2, "two retrieveKnowledge tool.latency events expected");
  const hit = knowledgeLatencies[1];
  assert.equal(hit.cacheHit, true, "second event should be flagged cacheHit:true");
  assert.equal(hit.latencyMs, 0, "second event should report 0ms latency");
});

// ===========================================================================
// 3. Latency budgets — deterministic-only.
// ===========================================================================

test("Task 8.4 deterministic budget — endToEnd.p95 < 1500ms on mocked deps", async (t) => {
  const envSnap = snapshotEnv();
  process.env.ENABLE_LLM_SYNTHESIS = "false";
  resetMockState();
  // Modest sleeps so each end-to-end run is well under budget.
  mockState.medicineKnowledgeMs = 30;
  mockState.memoryMs = 30;
  mockState.knowledgeMs = 30;

  const { events, detach } = recordLatencyEvents();
  t.after(() => {
    detach();
    restoreEnv(envSnap);
    resetMockState();
  });

  for (let i = 0; i < 5; i += 1) {
    responseCache.clear(); // force a cache miss every run for honest p95 sampling
    // Vary telegramId so the cache key is unique each iteration.
    await runMediFastWorkflow({
      query: "side effects",
      profile: null,
      telegramId: `u-deterministic-${i}`,
    });
  }

  const samples = events["latency.endToEnd"]
    .filter((e) => e.llmEnabled === false)
    .map((e) => e.latencyMs);
  assert.equal(samples.length, 5, "five endToEnd samples expected on deterministic-only path");
  const p95Latency = p95(samples);
  assert.ok(
    p95Latency < 1500,
    `deterministic endToEnd.p95 must be < 1500ms, got ${p95Latency}ms (samples: ${JSON.stringify(samples)})`
  );
});

// ===========================================================================
// 4. Latency budgets — LLM enabled.
// ===========================================================================

test("Task 8.4 LLM budget — endToEnd.p95 < 3500ms with LLM enabled (mocked Groq)", async (t) => {
  const envSnap = snapshotEnv();
  process.env.ENABLE_LLM_SYNTHESIS = "true";
  process.env.GROQ_API_KEY = "x";
  process.env.LLM_PROVIDER = "groq";
  resetMockState();
  mockState.medicineKnowledgeMs = 30;
  mockState.memoryMs = 30;
  mockState.knowledgeMs = 30;

  // Simulated Groq round-trip: ~200ms per call.
  const restoreFetch = installFetchStub(async () => {
    await sleep(200);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Pregabalin can cause dizziness in some people." } }],
      }),
      text: async () => "",
    };
  });

  const { events, detach } = recordLatencyEvents();
  t.after(() => {
    detach();
    restoreFetch();
    restoreEnv(envSnap);
    resetMockState();
  });

  for (let i = 0; i < 5; i += 1) {
    responseCache.clear();
    await runMediFastWorkflow({
      query: "side effects",
      profile: null,
      telegramId: `u-llm-${i}`,
    });
  }

  const samples = events["latency.endToEnd"]
    .filter((e) => e.llmEnabled === true)
    .map((e) => e.latencyMs);
  assert.equal(samples.length, 5, "five endToEnd samples expected on LLM path");
  const p95Latency = p95(samples);
  // 3500ms is the contracted budget; we run with comfortable headroom on
  // mocked deps. If a slow CI box ever borderlines this number, raise the
  // threshold to 5000ms here — the underlying contract being verified is
  // Property 5 / Property 4 (graceful degradation + preservation), not a
  // wall-clock racing bar.
  assert.ok(
    p95Latency < 3500,
    `LLM endToEnd.p95 must be < 3500ms, got ${p95Latency}ms (samples: ${JSON.stringify(samples)})`
  );

  // Provider events report Groq specifically.
  const providerEvents = events["latency.provider"];
  assert.ok(providerEvents.length === 5, "five provider latency events expected");
  for (const e of providerEvents) {
    assert.equal(e.provider, "groq", "provider event should report groq");
  }
});

// ===========================================================================
// 5. Two-stage scaffold — env-flag helpers behave per spec.
// ===========================================================================

test("Task 8.3 two-stage scaffold — env-flag helpers expose spec defaults and overrides", async (t) => {
  const envSnap = snapshotEnv();
  // Clear any caller-set values so we observe true defaults.
  delete process.env.ENABLE_TWO_STAGE_SEND;
  delete process.env.LLM_EDIT_BUDGET_MS;
  delete process.env.TYPING_THRESHOLD_MS;
  t.after(() => restoreEnv(envSnap));

  const { __internals } = require(path.join(REPO_ROOT, "src/bot/commands/search.js"));
  const { TWO_STAGE_SEND_ENABLED, LLM_EDIT_BUDGET_MS, TYPING_THRESHOLD_MS } = __internals;

  // Default ON.
  assert.equal(TWO_STAGE_SEND_ENABLED(), true, "two-stage send is ON by default");
  assert.equal(LLM_EDIT_BUDGET_MS(), 2500, "LLM edit budget defaults to 2500ms");
  assert.equal(TYPING_THRESHOLD_MS(), 800, "typing threshold defaults to 800ms");

  // Explicit "false" disables.
  process.env.ENABLE_TWO_STAGE_SEND = "false";
  assert.equal(TWO_STAGE_SEND_ENABLED(), false, "ENABLE_TWO_STAGE_SEND=false disables the scaffold");
  // Anything else keeps it on.
  process.env.ENABLE_TWO_STAGE_SEND = "true";
  assert.equal(TWO_STAGE_SEND_ENABLED(), true);
  process.env.ENABLE_TWO_STAGE_SEND = "anything-else";
  assert.equal(
    TWO_STAGE_SEND_ENABLED(),
    true,
    "any value other than the literal string 'false' keeps the scaffold ON"
  );

  // Numeric overrides are honored.
  process.env.LLM_EDIT_BUDGET_MS = "1234";
  process.env.TYPING_THRESHOLD_MS = "10";
  assert.equal(LLM_EDIT_BUDGET_MS(), 1234);
  assert.equal(TYPING_THRESHOLD_MS(), 10);
});
