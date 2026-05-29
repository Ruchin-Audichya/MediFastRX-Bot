// Phase 6 / Task 8.1 — independent tools run in parallel.
//
// Today the workflow runs every tool sequentially. This module now resolves
// the tools whose inputs are independent (`searchMedicineKnowledge`,
// `retrieveRelevantMemory`, `retrieveKnowledge`) via `Promise.all`, while
// keeping `recommendNearbyPharmacies` strictly after `medicineKnowledge` —
// nearby depends on the resolved identity AND the user's location.
//
// Trade-off: because RAG runs in parallel with `medicineKnowledge`, the
// `medicineScope` for the parallel `retrieveKnowledge` call cannot be derived
// from this turn's `medicineKnowledge` (we cannot wait). It is built from the
// previously stored active MedicineContext (`getActiveMedicineScope`). This
// means the FIRST turn of a brand-new medicine cannot benefit from
// current-turn confidence in RAG scoping — identical to today's first-turn
// behavior (preservation). Subsequent turns get scoped retrieval end-to-end
// because `search.js` calls `setActiveMedicineContext` after this turn.
//
// Per-tool latency diagnostics are emitted via
// `eventBus.emitSafe("tool.latency", { tool, latencyMs, ok })` so the budgets
// asserted in Task 8.4 can observe individual tool timings.
//
// Phase 6 / Task 8.2 — per-user response cache.
//
// `src/cache/responseCache.js` provides a small TTL+LRU cache keyed by
// `(telegramId, normalizedMedicineQuery)`. We check it BEFORE issuing the RAG
// call and store the retrieval result on miss, so repeated turns about the
// same medicine reuse the validated chunks within the TTL window.

const { getTool } = require("../ai/toolRegistry");
const { getActiveMedicineScope } = require("../services/conversationContextService");
const responseCache = require("../cache/responseCache");
const eventBus = require("../events/eventBus");

const MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD = Number(
  process.env.MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD || 0.6
);

// Build a medicineScope to thread into RAG retrieval (Phase 5 of the
// medicine-context-integrity bugfix). Returns `null` when there is no active
// MedicineContext AND the deterministic medicine-knowledge result for THIS
// turn is below the confidence threshold — preserving today's exact RAG call
// shape (`{ question: plan.query }`).
//
// NOTE (Phase 6): in the parallel path we no longer have access to this
// turn's `medicineKnowledgeResult` before issuing the RAG call, so the
// `medicineKnowledgeResult` branch is effectively dead in
// `executeWorkflowTools`. It is preserved so any future direct caller can
// still pass a freshly-resolved medicine without a stored active context.
const buildMedicineScope = ({ telegramId, medicineKnowledgeResult }) => {
  // Prefer the active stored MedicineContext (carries aliases / salts / brands).
  if (telegramId) {
    const active = getActiveMedicineScope(telegramId);
    if (active && active.medicineName) return active;
  }
  // Otherwise derive a synthetic scope from the deterministic resolver result
  // returned by `searchMedicineKnowledge` in this same turn — but only when
  // its confidence clears the threshold. (Used by future callers; parallel
  // path inside `executeWorkflowTools` does not pass `medicineKnowledgeResult`.)
  const value = medicineKnowledgeResult?.value;
  if (
    value &&
    Number(value.confidence || 0) >= MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD &&
    value.medicine
  ) {
    const m = value.medicine;
    return {
      medicineName: m.medicineName || null,
      genericName: m.genericName || m.medicineName || null,
      aliases: Array.isArray(m.aliases) ? m.aliases : [],
      salts: Array.isArray(m.salts) ? m.salts : [],
      category: m.category || null,
    };
  }
  return null;
};

const safeExecute = async (toolName, payload) => {
  const tool = getTool(toolName);
  if (!tool) return { ok: false, error: `Tool not registered: ${toolName}` };
  try {
    return {
      ok: true,
      value: await tool.execute(payload),
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  }
};

// Wrap a tool invocation so per-tool latency is emitted regardless of success
// or failure. The returned shape is exactly what `safeExecute` returns, so
// callers don't have to special-case anything.
const runWithLatency = async (toolName, run) => {
  const t0 = Date.now();
  let out;
  try {
    out = await run();
  } catch (error) {
    // `safeExecute` already swallows tool errors; this catch only fires if
    // `run` itself throws (e.g., synchronous setup error). Keep the shape
    // consistent with `safeExecute`.
    out = { ok: false, error: error?.message || String(error) };
  }
  const latencyMs = Date.now() - t0;
  eventBus.emitSafe("tool.latency", {
    tool: toolName,
    latencyMs,
    ok: out?.ok !== false,
  });
  return out;
};

const executeWorkflowTools = async ({ plan, telegramId, profile }) => {
  const results = {};
  const executionTrace = [];
  const medicineQuery =
    plan.entities?.medicine ||
    plan.entities?.normalizedMedicineQuery ||
    plan.query;
  const normalizedQuery = String(medicineQuery || "").trim().toLowerCase();

  // ------------------------------------------------------------------
  // Sync tier — `family` is just a profile passthrough.
  // ------------------------------------------------------------------
  if (plan.execute.family) {
    results.family = { ok: true, value: profile };
    executionTrace.push({ tool: "family", ok: true });
  }

  // ------------------------------------------------------------------
  // Parallel tier — independent tools.
  // ------------------------------------------------------------------
  const parallelTasks = [];
  const parallelNames = [];

  if (plan.execute.medicine) {
    parallelTasks.push(
      runWithLatency("searchMedicineKnowledge", () =>
        safeExecute("searchMedicineKnowledge", { query: medicineQuery })
      )
    );
    parallelNames.push("medicineKnowledge");
  }

  if (plan.execute.memory && telegramId) {
    parallelTasks.push(
      runWithLatency("retrieveRelevantMemory", () =>
        safeExecute("retrieveRelevantMemory", {
          telegramId: String(telegramId),
          query: plan.query,
        })
      )
    );
    parallelNames.push("memory");
  }

  // RAG: try the per-user response cache first; on miss issue the call.
  let ragCacheHit = false;
  if (plan.execute.rag) {
    const cachedRetrieval =
      telegramId && normalizedQuery
        ? responseCache.get({
            telegramId,
            normalizedMedicineQuery: normalizedQuery,
            slot: "retrieval",
          })
        : null;

    if (cachedRetrieval) {
      ragCacheHit = true;
      // Synthesize the same `{ ok, value }` shape `safeExecute` returns so
      // downstream code path is identical; emit a 0ms latency event so
      // observability still records the "tool" call.
      eventBus.emitSafe("tool.latency", {
        tool: "retrieveKnowledge",
        latencyMs: 0,
        ok: true,
        cacheHit: true,
      });
      parallelTasks.push(
        Promise.resolve({ ok: true, value: cachedRetrieval })
      );
      parallelNames.push("knowledge");
    } else {
      // Build scope from the previously stored active MedicineContext only —
      // we cannot wait for this turn's `medicineKnowledge` because RAG runs
      // in parallel with it. See header note for the trade-off.
      const medicineScope = buildMedicineScope({
        telegramId,
        medicineKnowledgeResult: null,
      });
      parallelTasks.push(
        runWithLatency("retrieveKnowledge", () =>
          safeExecute("retrieveKnowledge", {
            question: plan.query,
            ...(medicineScope ? { medicineScope } : {}),
          })
        )
      );
      parallelNames.push("knowledge");
    }
  }

  if (parallelTasks.length > 0) {
    const settled = await Promise.all(parallelTasks);
    for (let i = 0; i < parallelNames.length; i++) {
      const name = parallelNames[i];
      const value = settled[i];
      results[name] = value;
      const traceTool =
        name === "medicineKnowledge"
          ? "searchMedicineKnowledge"
          : name === "memory"
          ? "retrieveRelevantMemory"
          : "retrieveKnowledge";
      executionTrace.push({ tool: traceTool, ok: value?.ok !== false });
    }
  }

  // Cache the freshly-computed retrieval result for subsequent turns of the
  // same medicine. Only cache successful, non-empty results to avoid pinning
  // empty responses behind a TTL window.
  if (
    !ragCacheHit &&
    telegramId &&
    normalizedQuery &&
    results.knowledge &&
    results.knowledge.ok &&
    results.knowledge.value
  ) {
    responseCache.set({
      telegramId,
      normalizedMedicineQuery: normalizedQuery,
      slot: "retrieval",
      value: results.knowledge.value,
    });
  }

  // ------------------------------------------------------------------
  // Sequential tier — `recommendNearbyPharmacies` depends on resolved
  // medicine identity AND the user's location.
  // ------------------------------------------------------------------
  if (plan.execute.nearby) {
    results.nearby = await runWithLatency("recommendNearbyPharmacies", () =>
      safeExecute("recommendNearbyPharmacies", {
        telegramId,
        latitude: plan.location.latitude,
        longitude: plan.location.longitude,
        medicineQuery,
        medicineKnowledge: results.medicineKnowledge?.value,
      })
    );
    executionTrace.push({
      tool: "recommendNearbyPharmacies",
      ok: results.nearby?.ok !== false,
    });
  }

  results.__trace = executionTrace;
  return results;
};

module.exports = {
  executeWorkflowTools,
  safeExecute,
};
