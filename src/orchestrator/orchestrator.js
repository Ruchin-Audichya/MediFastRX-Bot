const { createProvider } = require("../providers");
const { planWorkflow } = require("./workflowPlanner");
const { executeWorkflowTools } = require("./toolExecutor");
const { mergeWorkflowResponse } = require("./responseMerger");
const { collectEvidence, estimateEvidenceSize } = require("./evidenceCollector");
const { getActiveContext } = require("../services/conversationContextService");
const eventBus = require("../events/eventBus");

const llmSynthesisEnabled = () => process.env.ENABLE_LLM_SYNTHESIS === "true";

// Task 7.3 — deterministic medicine-card stub used when synthesis is OFF /
// fails / times out. This is intentionally lightweight and pulls fields from
// the validated `evidence.medicineContext` + `evidence.ragContext.context` so
// every wired layer (context, evidence, enrichment) participates in the
// fallback. Phase 11.2 swaps this stub for the real `formatMedicineCard`
// from `src/utils/formatter.js`; the orchestrator's contract (a string
// `providerResult.text`) does not change.
const renderDeterministicCard = (evidence = {}) => {
  const med = evidence && evidence.medicineContext && evidence.medicineContext.medicine;
  if (!med || !med.medicineName) {
    // No active medicine — preservation: return an empty string and let the
    // existing low-confidence/fallback hint (computed below) take over.
    return "";
  }

  const lines = [];
  const headline = med.genericName && med.genericName !== med.medicineName
    ? `${med.medicineName} (${med.genericName})`
    : med.medicineName;
  lines.push(headline);

  if (Array.isArray(med.symptoms) && med.symptoms.length) {
    const symptomNames = med.symptoms
      .slice(0, 3)
      .map((s) => (s && typeof s === "object" ? s.name || s.symptom : s))
      .filter(Boolean);
    if (symptomNames.length) lines.push(`Used for: ${symptomNames.join(", ")}.`);
  }

  if (Array.isArray(med.sideEffects) && med.sideEffects.length) {
    const effectNames = med.sideEffects
      .slice(0, 3)
      .map((s) => (s && typeof s === "object" ? s.effect || s.name : s))
      .filter(Boolean);
    if (effectNames.length) lines.push(`Common side effects: ${effectNames.join(", ")}.`);
  }

  const alternatives = Array.isArray(evidence.medicineContext.alternatives)
    ? evidence.medicineContext.alternatives
        .map((a) => a && a.medicineName)
        .filter(Boolean)
        .slice(0, 3)
    : [];
  if (alternatives.length) lines.push(`Alternatives: ${alternatives.join(", ")}.`);

  // Validated retrieved evidence — surface up to two short lines so RAG
  // output is never silently dropped on the deterministic path.
  const ragItems = (evidence.ragContext && Array.isArray(evidence.ragContext.context)
    ? evidence.ragContext.context
    : [])
    .filter((c) => c && c.belongsToActiveMedicine !== false)
    .slice(0, 2)
    .map((c) => String(c.text || "").trim())
    .filter((line) => line.length > 3);
  if (ragItems.length) lines.push(...ragItems);

  // Enrichment — inventory / forecast — included only when present.
  const enrichment = (med.enrichment && typeof med.enrichment === "object") ? med.enrichment : {};
  const inventoryItems = enrichment.inventory && Array.isArray(enrichment.inventory.items)
    ? enrichment.inventory.items
    : [];
  if (inventoryItems.length) {
    const top = inventoryItems[0] || {};
    const distance = top.distanceKm != null ? `${top.distanceKm} km` : null;
    const stock = top.inStock ? " — in stock" : "";
    const where = top.pharmacyName || "a pharmacy nearby";
    lines.push(`Nearby availability: ${where}${distance ? ` (${distance})` : ""}${stock}.`);
  }
  if (enrichment.forecast && enrichment.forecast.demandLevel) {
    lines.push(`Forecast: ${enrichment.forecast.demandLevel} demand expected.`);
  }

  if (med.prescriptionRequired) lines.push("Prescription required.");

  return lines.join("\n").trim();
};

const runMediFastWorkflow = async ({ query, profile, telegramId, location = null, intent = {}, mentionedMember = null } = {}) => {
  const startedAt = Date.now();
  const plan = planWorkflow({ query, profile, location });

  // Phase 6 / Task 8.4 — emit per-stage latency diagnostics so the budget
  // assertions in Task 8.5 can observe each stage independently. Wrapping is
  // additive: tool ordering, evidence shape, and the deterministic-fallback
  // decision tree from Task 7.3 are unchanged.
  const toolExecutorStartedAt = Date.now();
  const toolResults = await executeWorkflowTools({ plan, telegramId, profile });
  eventBus.emitSafe("latency.toolExecutor", {
    latencyMs: Date.now() - toolExecutorStartedAt,
  });

  const activeMedicine = telegramId ? getActiveContext(telegramId) : null;
  const evidenceCollectorStartedAt = Date.now();
  const evidence = collectEvidence({
    query,
    plan,
    toolResults,
    activeMedicine,
    // explicitMedicines reserved for future multi-medicine intent (3.6); empty for now.
    explicitMedicines: [],
  });
  eventBus.emitSafe("latency.evidenceCollector", {
    latencyMs: Date.now() - evidenceCollectorStartedAt,
  });
  const knowledgeContext = toolResults.knowledge?.value?.context || [];
  const memoryFacts = toolResults.memory?.value?.facts || [];
  const fallbackHint = evidence.ragContext.lowConfidence || evidence.medicineContext.message
    ? "I do not have enough confident evidence for this part. Please share the exact medicine name or symptom details."
    : "";

  // Task 7.3 — compute the deterministic card once. It is reused as either
  // the primary path (synthesis OFF) or the fallback (Groq fail/timeout).
  const deterministicText = renderDeterministicCard(evidence);

  const shouldSynthesize =
    llmSynthesisEnabled() &&
    (knowledgeContext.length > 0 || memoryFacts.length > 0 || evidence.medicineContext.medicine);

  let providerResult;
  const providerStartedAt = Date.now();
  if (shouldSynthesize) {
    const provider = createProvider();
    providerResult = await provider.generate({
      prompt: query,
      fallback: fallbackHint,
      context: knowledgeContext,
      memory: memoryFacts,
      evidence,
    });
    // If the LLM call failed (timeout / 401 / network) or produced no text,
    // fall back deterministically. Every wired layer still reaches the user
    // because `deterministicText` already includes context + evidence +
    // enrichment when an active medicine is present.
    if (providerResult.ok === false || !String(providerResult.text || "").trim()) {
      providerResult = {
        ...providerResult,
        text: deterministicText || providerResult.text || fallbackHint || "",
        provider: "deterministic",
        model: deterministicText ? "deterministic-card-fallback" : "no-llm-synthesis",
        ok: true,
        fallbackUsed: true,
      };
    }
  } else {
    providerResult = {
      text: deterministicText || fallbackHint || "",
      provider: "deterministic",
      model: deterministicText ? "deterministic-card" : "no-llm-synthesis",
      latencyMs: 0,
      ok: true,
      skipped: true,
    };
  }
  eventBus.emitSafe("latency.provider", {
    latencyMs: Date.now() - providerStartedAt,
    provider: providerResult?.provider || null,
    model: providerResult?.model || null,
    fallbackUsed: Boolean(providerResult?.fallbackUsed),
  });
  const orchestrationLatencyMs = Date.now() - startedAt;

  eventBus.emitSafe("latency.endToEnd", {
    latencyMs: orchestrationLatencyMs,
    llmEnabled: llmSynthesisEnabled(),
    fallbackUsed: Boolean(providerResult?.fallbackUsed),
  });

  eventBus.emitSafe("orchestration.completed", {
    telegramId,
    query,
    toolsExecuted: toolResults.__trace?.map((item) => item.tool) || [],
    toolCount: toolResults.__trace?.length || 0,
    failedWorkflow: Object.values(toolResults).some((result) => result?.ok === false),
    evidenceSize: estimateEvidenceSize(evidence),
    provider: providerResult.provider,
    providerModel: providerResult.model,
    providerLatencyMs: providerResult.latencyMs || 0,
    orchestrationLatencyMs,
    llmSynthesisEnabled: llmSynthesisEnabled(),
    llmSynthesisSkipped: Boolean(providerResult.skipped),
    fallbackUsed: Boolean(providerResult.fallbackUsed),
  });

  return mergeWorkflowResponse({
    query,
    plan,
    toolResults,
    providerResult,
    evidence,
    orchestrationLatencyMs,
    intent,
    mentionedMember,
  });
};

module.exports = {
  llmSynthesisEnabled,
  runMediFastWorkflow,
};
