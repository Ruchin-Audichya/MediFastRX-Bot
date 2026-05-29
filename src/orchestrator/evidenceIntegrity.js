"use strict";

// Evidence integrity guard — Phase 4 of medicine-context-integrity bugfix.
// Validates evidence items against the active medicine identity (canonical
// MedicineContext) and produces a contamination report.
//
// **Validates: Requirements 1.6, 2.6, 3.1, 3.2, 3.6**
//
// Pure module — no I/O, no Mongo, no LLM. Inputs are normalized objects;
// outputs are plain JSON-safe values.

const { belongsToActiveMedicine } = require("../context/medicineContext");

const DEFAULT_DROPPED_EXAMPLES_CAP = 5;
const ALLOWED_GRAPH_TYPES = new Set([
  "same_generic",
  "alternative",
  "alternatives",
  "substitute",
  "substitutes",
  "brand_of",
  "generic_of",
]);

const lowerTrim = (v) => {
  if (v === null || v === undefined) return "";
  const s = String(v).trim().toLowerCase();
  return s;
};

const isInExplicitSet = (meta, explicitTokens) => {
  if (!explicitTokens || explicitTokens.size === 0) return false;
  for (const key of ["medicine", "generic", "alias"]) {
    const tok = lowerTrim(meta?.[key]);
    if (tok && explicitTokens.has(tok)) return true;
  }
  return false;
};

const buildExplicitTokens = (explicitMedicines = []) => {
  const set = new Set();
  for (const name of explicitMedicines) {
    const tok = lowerTrim(name);
    if (tok) set.add(tok);
  }
  return set;
};

const isAllowedRelationship = (item, allowedRelationships) => {
  if (!allowedRelationships) return true; // default: any relationship type permitted
  const allowed = allowedRelationships instanceof Set
    ? new Set([...allowedRelationships].map(lowerTrim))
    : new Set((Array.isArray(allowedRelationships) ? allowedRelationships : []).map(lowerTrim));
  const t = lowerTrim(item?.type);
  return t ? allowed.has(t) : false;
};

const summarizeContamination = (item, reason) => ({
  medicine: item?.metadata?.medicine ?? item?.medicine ?? null,
  generic: item?.metadata?.generic ?? item?.generic ?? null,
  alias: item?.metadata?.alias ?? item?.alias ?? null,
  reason,
});

const validateEvidence = ({
  items = [],
  activeMedicine = null,
  allowedRelationships = null,
  explicitMedicines = [],
  itemKind = "rag", // "rag" | "alternative" | "relationship"
  droppedExamplesCap = DEFAULT_DROPPED_EXAMPLES_CAP,
} = {}) => {
  const list = Array.isArray(items) ? items : [];
  const explicitTokens = buildExplicitTokens(explicitMedicines);

  // No-op pass-through (Property 4): tag everything as belonging, no drops.
  if (!activeMedicine || activeMedicine.activeStatus !== "active") {
    const kept = list.map((item) => ({ ...item, belongsToActiveMedicine: true }));
    return {
      kept,
      dropped: [],
      report: {
        total: list.length,
        kept: kept.length,
        dropped: 0,
        downWeighted: 0,
        activeMedicine: null,
        droppedExamples: [],
        itemKind,
      },
    };
  }

  const kept = [];
  const dropped = [];
  const droppedExamples = [];
  let downWeighted = 0;

  for (const item of list) {
    let belongs;
    let reason;
    if (itemKind === "relationship") {
      // Relationships are allowed when their `type` is in the allowed set.
      belongs = isAllowedRelationship(item, allowedRelationships);
      reason = belongs ? null : `disallowed relationship type: ${item?.type ?? "unknown"}`;
    } else {
      // Default tag from canonical MedicineContext.
      belongs = belongsToActiveMedicine(activeMedicine, item);
      reason = belongs ? null : "metadata medicine/generic/alias does not match active medicine";
    }

    if (!belongs && isInExplicitSet(item?.metadata || item, explicitTokens)) {
      // Explicit multi-medicine request (3.6) bypasses contamination drop.
      kept.push({ ...item, belongsToActiveMedicine: false, explicitlyRequested: true });
      continue;
    }

    if (!belongs) {
      dropped.push(item);
      if (droppedExamples.length < droppedExamplesCap) {
        droppedExamples.push(summarizeContamination(item, reason));
      }
      continue;
    }
    kept.push({ ...item, belongsToActiveMedicine: true });
  }

  return {
    kept,
    dropped,
    report: {
      total: list.length,
      kept: kept.length,
      dropped: dropped.length,
      downWeighted,
      activeMedicine: {
        medicineName: activeMedicine.medicineName,
        genericName: activeMedicine.genericName,
      },
      droppedExamples,
      itemKind,
    },
  };
};

const mergeReports = (...reports) => {
  const merged = {
    total: 0,
    kept: 0,
    dropped: 0,
    downWeighted: 0,
    activeMedicine: null,
    droppedExamples: [],
    byKind: {},
  };
  for (const r of reports.filter(Boolean)) {
    merged.total += r.total || 0;
    merged.kept += r.kept || 0;
    merged.dropped += r.dropped || 0;
    merged.downWeighted += r.downWeighted || 0;
    merged.activeMedicine = merged.activeMedicine || r.activeMedicine || null;
    if (Array.isArray(r.droppedExamples) && r.droppedExamples.length) {
      merged.droppedExamples.push(...r.droppedExamples);
    }
    if (r.itemKind) {
      merged.byKind[r.itemKind] = {
        total: r.total || 0,
        kept: r.kept || 0,
        dropped: r.dropped || 0,
      };
    }
  }
  if (merged.droppedExamples.length > DEFAULT_DROPPED_EXAMPLES_CAP) {
    merged.droppedExamples = merged.droppedExamples.slice(0, DEFAULT_DROPPED_EXAMPLES_CAP);
  }
  return merged;
};

module.exports = {
  ALLOWED_GRAPH_TYPES,
  validateEvidence,
  mergeReports,
};
