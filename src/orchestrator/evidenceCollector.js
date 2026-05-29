"use strict";

// Evidence collector — Phase 4 wiring of medicine-context-integrity bugfix.
// When a frozen MedicineContext is supplied via `activeMedicine`, RAG /
// alternatives / relationships paths are validated through the integrity
// guard, contamination is reported, and a single analytics event is emitted.
// When `activeMedicine` is null/expired, behavior is byte-for-byte identical
// to today (preservation contract — see tests/preserve/medicineContext.*).

const {
  validateEvidence,
  mergeReports,
  ALLOWED_GRAPH_TYPES,
} = require("./evidenceIntegrity");
const eventBus = require("../events/eventBus");

const compactMedicine = (medicine = {}) => {
  if (!medicine) return null;
  return {
    medicineName: medicine.medicineName || null,
    genericName: medicine.genericName || null,
    salts: medicine.salts?.slice?.(0, 5) || [],
    brands: medicine.brands?.slice?.(0, 5) || [],
    aliases: medicine.aliases?.slice?.(0, 5) || [],
    company: medicine.company || null,
    category: medicine.category || null,
    symptoms: medicine.symptoms?.slice?.(0, 5) || [],
    sideEffects: medicine.sideEffects?.slice?.(0, 5) || [],
    prescriptionRequired: Boolean(medicine.prescriptionRequired),
  };
};

const compactRelationships = (relationships = [], activeMedicine = null) => {
  const relValidation = validateEvidence({
    items: relationships || [],
    activeMedicine,
    allowedRelationships: ALLOWED_GRAPH_TYPES,
    itemKind: "relationship",
  });
  const compact = relValidation.kept.slice(0, 10).map((item) => ({
    type: item.type || item.relation || "related",
    from: item.from || item.source || item.medicine || null,
    to: item.to || item.target || item.value || null,
    confidence: item.confidence || null,
  }));
  return { compact, report: relValidation.report };
};

const compactMemory = (memory = {}) =>
  (memory.facts || []).slice(0, 8).map((fact) => ({
    type: fact.type,
    entity: fact.entity,
    value: fact.value,
    confidence: fact.confidence || null,
    source: fact.source || "memory",
  }));

const compactRag = (knowledge = {}, activeMedicine = null, explicitMedicines = []) => {
  const ragValidation = validateEvidence({
    items: knowledge.context || [],
    activeMedicine,
    explicitMedicines,
    itemKind: "rag",
  });
  const compact = ragValidation.kept.slice(0, 5).map((item) => ({
    text: String(item.text || "").slice(0, 700),
    confidence: item.confidence || item.score || null,
    source: item.metadata?.source || null,
    sourceType: item.metadata?.sourceType || null,
    medicine: item.metadata?.medicine || null,
    generic: item.metadata?.generic || null,
    category: item.metadata?.category || null,
    sideEffects: item.metadata?.sideEffects || null,
    trust: item.metadata?.trust || null,
    belongsToActiveMedicine: item.belongsToActiveMedicine,
    explicitlyRequested: item.explicitlyRequested || false,
  }));
  return { compact, report: ragValidation.report };
};

const compactAlternatives = (alternatives = [], activeMedicine = null) => {
  const altValidation = validateEvidence({
    items: alternatives || [],
    activeMedicine,
    itemKind: "alternative",
  });
  const compact = altValidation.kept.slice(0, 5).map(compactMedicine);
  return { compact, report: altValidation.report };
};

const compactPharmacies = (nearby = {}) =>
  (nearby.ranked || nearby.pharmacies || []).slice(0, 5).map((pharmacy) => ({
    name: pharmacy.name,
    distanceKm: pharmacy.distanceKm,
    score: pharmacy.score,
    address: pharmacy.address,
    confidence: pharmacy.confidence,
    inventoryConfidence: pharmacy.inventoryConfidence,
    medicineConfidence: pharmacy.medicineConfidence,
    openStatus: pharmacy.openStatus,
    source: pharmacy.source,
    popularityScore: pharmacy.popularityScore,
    searchSuccessScore: pharmacy.searchSuccessScore,
  }));

const collectEvidence = ({
  query = "",
  plan = {},
  toolResults = {},
  activeMedicine = null,
  explicitMedicines = [],
} = {}) => {
  const medicineResult = toolResults.medicineKnowledge?.value || {};
  const memoryResult = toolResults.memory?.value || {};
  const knowledgeResult = toolResults.knowledge?.value || {};
  const nearbyResult = toolResults.nearby?.value || {};
  const errors = Object.fromEntries(
    Object.entries(toolResults)
      .filter(([, result]) => result.ok === false)
      .map(([name, result]) => [name, result.error])
  );

  const ragOut = compactRag(knowledgeResult, activeMedicine, explicitMedicines);
  const altsOut = compactAlternatives(medicineResult.alternatives || [], activeMedicine);
  const relsOut = compactRelationships(medicineResult.relationships || [], activeMedicine);
  const contamination = mergeReports(ragOut.report, altsOut.report, relsOut.report);

  const evidence = {
    userQuery: query,
    entities: plan.entities || {},
    routes: plan.routes || [],
    medicineContext: {
      medicine: compactMedicine(medicineResult.medicine),
      alternatives: altsOut.compact,
      relationships: relsOut.compact,
      message: medicineResult.message || null,
      confidence: medicineResult.confidence || 0,
    },
    memoryContext: {
      facts: compactMemory(memoryResult),
      confidence: memoryResult.confidence || 0,
    },
    pharmacyContext: {
      source: nearbyResult.osmHydrated ? "Mongo Geo + OpenStreetMap live refresh" : nearbyResult.ranked ? "Mongo Geo" : null,
      radiusKm: nearbyResult.radiusKm || null,
      expandedRadius: Boolean(nearbyResult.expandedRadius),
      osmHydrated: Boolean(nearbyResult.osmHydrated),
      inventoryMatchCount: nearbyResult.inventoryMatchCount || 0,
      confidenceQuality: nearbyResult.confidenceQuality || 0,
      pharmacies: compactPharmacies(nearbyResult),
    },
    ragContext: {
      context: ragOut.compact,
      sources: (knowledgeResult.sources || []).slice(0, 5),
      confidence: knowledgeResult.confidence || 0,
      lowConfidence: Boolean(knowledgeResult.lowConfidence),
      contamination,
    },
    confidenceScores: {
      medicine: medicineResult.confidence || 0,
      memory: memoryResult.confidence || 0,
      rag: knowledgeResult.confidence || 0,
      pharmacy: nearbyResult.ranked?.[0]?.score || 0,
    },
    toolErrors: errors,
  };

  // Single analytics event when contamination was actually detected on an
  // active medicine context. No-op pass-through paths emit nothing — the
  // preservation contract demands silence when there is no scope.
  if (
    activeMedicine &&
    activeMedicine.activeStatus === "active" &&
    contamination.dropped > 0
  ) {
    eventBus.emitSafe("evidence.contamination", {
      query,
      dropped: contamination.dropped,
      total: contamination.total,
      byKind: contamination.byKind,
      activeMedicine: contamination.activeMedicine,
      droppedExamples: contamination.droppedExamples,
    });
  }

  return evidence;
};

const estimateEvidenceSize = (evidence) =>
  Buffer.byteLength(JSON.stringify(evidence || {}), "utf8");

module.exports = {
  collectEvidence,
  estimateEvidenceSize,
};
