"use strict";

// Pure factory + helpers for the canonical MedicineContext object.
// See design `### 1. MedicineContext model`. No I/O, no Mongo, no logger.
// `now` is injected so callers can assert idempotency under a fixed clock.

const ENRICHMENT_KEYS = ["inventory", "forecast", "substitutes", "pharmacies"];

const toStringOrNull = (value) => {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && typeof value.toString === "function") {
    const s = value.toString();
    return s && s !== "[object Object]" ? s : null;
  }
  return null;
};

const dedupeStrings = (values) => {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    if (raw === undefined || raw === null) continue;
    const trimmed = String(raw).trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
};

const clamp01 = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
};

const compactRelationships = (rels) => {
  if (!Array.isArray(rels)) return [];
  return rels.slice(0, 10).map((r) => {
    const item = r && typeof r === "object" ? r : {};
    return Object.freeze({
      type: toStringOrNull(item.type),
      from: toStringOrNull(item.from),
      to: toStringOrNull(item.to),
      confidence: clamp01(item.confidence),
    });
  });
};

const buildEnrichment = (partial = {}) => {
  const out = { inventory: null, forecast: null, substitutes: null, pharmacies: null };
  if (partial && typeof partial === "object") {
    for (const key of ENRICHMENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(partial, key)) {
        const value = partial[key];
        out[key] = value === null || value === undefined
          ? null
          : (typeof value === "object" ? Object.freeze(value) : value);
      }
    }
  }
  return Object.freeze(out);
};

const freezeContext = (fields) => {
  Object.freeze(fields.aliases);
  Object.freeze(fields.salts);
  Object.freeze(fields.brands);
  Object.freeze(fields.graphRelationships);
  return Object.freeze(fields);
};

function createMedicineContext({ resolution, conversationId = null, userId = null, now = Date.now() } = {}) {
  if (!resolution || typeof resolution !== "object") {
    throw new TypeError("createMedicineContext: resolution must be an object");
  }
  const med = resolution.medicine && typeof resolution.medicine === "object" ? resolution.medicine : {};
  const medicineName =
    toStringOrNull(med.medicineName) ||
    toStringOrNull(med.genericName) ||
    toStringOrNull(resolution.normalizedQuery);
  const genericName = toStringOrNull(med.genericName) || medicineName;
  const category = toStringOrNull(med.category);
  const ts = Number(now);

  return freezeContext({
    medicineId: toStringOrNull(med._id),
    medicineName,
    genericName,
    aliases: dedupeStrings(med.aliases || []),
    salts: dedupeStrings(med.salts || []),
    category: category ? category.toLowerCase() : null,
    brands: dedupeStrings(med.brands || []),
    graphRelationships: compactRelationships(resolution.relationships || []),
    confidence: clamp01(resolution.confidence),
    source: toStringOrNull(resolution.method) || toStringOrNull(resolution.reason) || "unknown",
    timestamp: ts,
    updatedAt: ts,
    conversationId: toStringOrNull(conversationId),
    userId: toStringOrNull(userId),
    activeStatus: "active",
    enrichment: buildEnrichment(),
  });
}

function getMedicineScope(ctx) {
  if (!ctx || ctx.activeStatus !== "active") return null;
  return {
    medicineName: ctx.medicineName,
    genericName: ctx.genericName,
    aliases: Array.isArray(ctx.aliases) ? ctx.aliases.slice() : [],
    salts: Array.isArray(ctx.salts) ? ctx.salts.slice() : [],
    category: ctx.category,
  };
}

function isFresh(ctx, ttlMs, now = Date.now()) {
  if (!ctx || ctx.activeStatus !== "active") return false;
  const ttl = Number(ttlMs);
  const t = Number(now);
  if (!Number.isFinite(ttl) || !Number.isFinite(t)) return false;
  return t - Number(ctx.updatedAt) <= ttl;
}

function withEnrichment(ctx, partial = {}, now = Date.now()) {
  if (!ctx || typeof ctx !== "object") {
    throw new TypeError("withEnrichment: ctx must be an object");
  }
  const current = ctx.enrichment || {};
  const merged = {
    inventory: current.inventory ?? null,
    forecast: current.forecast ?? null,
    substitutes: current.substitutes ?? null,
    pharmacies: current.pharmacies ?? null,
  };
  if (partial && typeof partial === "object") {
    for (const key of ENRICHMENT_KEYS) {
      if (Object.prototype.hasOwnProperty.call(partial, key)) merged[key] = partial[key];
    }
  }
  return freezeContext({
    medicineId: ctx.medicineId,
    medicineName: ctx.medicineName,
    genericName: ctx.genericName,
    aliases: Array.isArray(ctx.aliases) ? ctx.aliases.slice() : [],
    salts: Array.isArray(ctx.salts) ? ctx.salts.slice() : [],
    category: ctx.category,
    brands: Array.isArray(ctx.brands) ? ctx.brands.slice() : [],
    graphRelationships: Array.isArray(ctx.graphRelationships)
      ? ctx.graphRelationships.map((r) => Object.freeze({ ...r }))
      : [],
    confidence: ctx.confidence,
    source: ctx.source,
    timestamp: ctx.timestamp,
    updatedAt: Number(now),
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    activeStatus: ctx.activeStatus,
    enrichment: buildEnrichment(merged),
  });
}

function belongsToActiveMedicine(ctx, evidenceItem) {
  if (!ctx || ctx.activeStatus !== "active") return true;
  const meta = evidenceItem && evidenceItem.metadata && typeof evidenceItem.metadata === "object"
    ? evidenceItem.metadata
    : (evidenceItem && typeof evidenceItem === "object" ? evidenceItem : {});
  const candidates = ["medicine", "generic", "alias"].map((key) => {
    const v = meta[key];
    if (v === null || v === undefined) return null;
    const s = String(v).trim().toLowerCase();
    return s === "" ? null : s;
  });
  if (candidates.every((v) => v === null)) return true;
  const allowed = new Set();
  const add = (v) => {
    if (v === null || v === undefined) return;
    const s = String(v).trim().toLowerCase();
    if (s) allowed.add(s);
  };
  add(ctx.medicineName);
  add(ctx.genericName);
  (ctx.aliases || []).forEach(add);
  (ctx.salts || []).forEach(add);
  (ctx.brands || []).forEach(add);
  return candidates.some((v) => v !== null && allowed.has(v));
}

module.exports = {
  createMedicineContext,
  getMedicineScope,
  isFresh,
  withEnrichment,
  belongsToActiveMedicine,
};
