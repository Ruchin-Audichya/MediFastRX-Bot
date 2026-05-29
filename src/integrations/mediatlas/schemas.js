"use strict";

const {
  validateString,
  validateNullableString,
  validateNumber,
  validateNullableNumber,
  validateInteger,
  validateBoolean,
  validateArray,
  validateStringArray,
  validateEnum,
  validateNullableEnum,
  validateIsoDatetime,
  validateNullableIsoDatetime,
  validateIsoDate,
  validateNullableIsoDate,
  validateScore,
  validateNullableScore,
  validateObject,
  validateNullableObject,
} = require("./schemaValidator");

/**
 * AIContextPacket schemas — pinned to the locked sample payload from
 * MediAtlas Sprint 1 handshake. Frozen at schema_version: 1.
 *
 * Lock decisions (reflected here):
 *   - availability, drug, interactions are nullable at section level.
 *     The KEYS must always be present. Missing key === contract violation.
 *   - summary and medicine are always present (non-null).
 *   - summary.best_pharmacy_id, summary.best_pharmacy_name,
 *     summary.nearest_distance_km are nullable when nothing is in stock.
 *   - forecast.forecast (inner object) is nullable when degraded;
 *     the outer forecast section is always present with `status`.
 *   - All datetimes are ISO 8601 UTC; date-only fields use YYYY-MM-DD.
 *   - Scores are floats in [0, 1] with epsilon-tolerance clamping.
 *   - Strict enums: stock_status, match_reason, forecast trend, section status.
 *     New enum values are telegraphed before /openapi.json bumps.
 *   - Object shapes are passthrough (forward-compat additive 1.1.x fields).
 */

const SECTION_STATUS = ["ok", "empty", "degraded"];
const STOCK_STATUS = ["in_stock", "low_stock", "out_of_stock"];
const MATCH_REASON = [
  "exact",
  "exact_brand",
  "exact_generic",
  "alias",
  "salt",
  "fuzzy",
  "semantic",
  "spelling",
  "no_match",
];
const FORECAST_TREND = ["rising", "falling", "stable", "volatile", "unknown"];
const INTERACTION_SEVERITY = ["minor", "moderate", "major"];
const FREQUENCY = ["common", "uncommon", "rare", "very_rare", "unknown"];
const PHARMACY_TYPE = ["chain", "independent", "hospital", "online", "unknown"];
const INVENTORY_TREND = ["rising", "falling", "steady", "volatile", "unknown"];

const validateLocation = (value, path) =>
  validateObject(value, path, {
    latitude: (v, p) => validateNumber(v, p, { min: -90, max: 90 }),
    longitude: (v, p) => validateNumber(v, p, { min: -180, max: 180 }),
  });

const validateMedicine = (value, path, ctx) =>
  validateObject(value, path, {
    query: (v, p) => validateString(v, p),
    resolved_name: (v, p) => validateNullableString(v, p),
    generic: (v, p) => validateNullableString(v, p),
    category: (v, p) => validateNullableString(v, p),
    confidence: (v, p) => validateScore(v, p, ctx),
    match_reason: (v, p) => validateEnum(v, MATCH_REASON, p),
    aliases: (v, p) => validateStringArray(v, p),
  }, ctx);

const validateSummary = (value, path, ctx) =>
  validateObject(value, path, {
    available_nearby: (v, p) => validateBoolean(v, p),
    best_pharmacy_id: (v, p) => validateNullableString(v, p),
    best_pharmacy_name: (v, p) => validateNullableString(v, p),
    nearest_distance_km: (v, p) => validateNullableNumber(v, p, { min: 0, max: 100000 }),
    max_stock_nearby: (v, p) => validateNullableNumber(v, p, { min: 0 }),
    shortage_risk: (v, p) => validateNullableScore(v, p, ctx),
    recommend_substitutes: (v, p) => validateBoolean(v, p),
  }, ctx);

const validatePharmacy = (value, path, ctx) =>
  validateObject(value, path, {
    id: (v, p) => validateString(v, p),
    name: (v, p) => validateString(v, p),
    city: (v, p) => validateNullableString(v, p),
    latitude: (v, p) => validateNumber(v, p, { min: -90, max: 90 }),
    longitude: (v, p) => validateNumber(v, p, { min: -180, max: 180 }),
    rating: (v, p) => validateNullableNumber(v, p, { min: 0, max: 5 }),
    delivery_available: (v, p) => validateBoolean(v, p),
    pharmacy_type: (v, p) => validateEnum(v, PHARMACY_TYPE, p),
  }, ctx);

const validateInventoryItem = (value, path, ctx) =>
  validateObject(value, path, {
    medicine_id: (v, p) => validateString(v, p),
    medicine_name: (v, p) => validateString(v, p),
    canonical_medicine: (v, p) => validateNullableString(v, p),
    generic: (v, p) => validateNullableString(v, p),
    brand: (v, p) => validateNullableString(v, p),
    category: (v, p) => validateNullableString(v, p),
    manufacturer: (v, p) => validateNullableString(v, p),
    stock: (v, p) => validateInteger(v, p),
    stock_status: (v, p) => validateEnum(v, STOCK_STATUS, p),
    pharmacy_id: (v, p) => validateString(v, p),
    pharmacy: validatePharmacy,
    distance_km: (v, p) => validateNumber(v, p, { min: 0, max: 100000 }),
    price: (v, p) => validateNullableNumber(v, p, { min: 0 }),
    availability_confidence: (v, p) => validateScore(v, p, ctx),
    forecast_risk: (v, p) => validateNullableScore(v, p, ctx),
    forecast: (v, p) => validateNullableEnum(v, FORECAST_TREND, p),
    substitutes: (v, p) => validateStringArray(v, p),
    inventory_trend: (v, p) => validateNullableEnum(v, INVENTORY_TREND, p),
    expiry: (v, p) => validateNullableIsoDate(v, p),
    last_updated: (v, p) => validateIsoDatetime(v, p),
    batch_number: (v, p) => validateNullableString(v, p),
  }, ctx);

const validateInventorySection = (value, path, ctx) =>
  validateObject(value, path, {
    status: (v, p) => validateEnum(v, SECTION_STATUS, p),
    detail: (v, p) => validateNullableString(v, p),
    total_in_radius: (v, p) => validateInteger(v, p),
    items: (v, p) => validateArray(v, p, (item, ip) => validateInventoryItem(item, ip, ctx)),
  }, ctx);

const validateSubstituteItem = (value, path, ctx) =>
  validateObject(value, path, {
    medicine_name: (v, p) => validateString(v, p),
    active_ingredient: (v, p) => validateNullableString(v, p),
    score: (v, p) => validateScore(v, p, ctx),
    availability_score: (v, p) => validateScore(v, p, ctx),
    price_score: (v, p) => validateScore(v, p, ctx),
    distance_score: (v, p) => validateScore(v, p, ctx),
    side_effect_similarity: (v, p) => validateScore(v, p, ctx),
    median_price: (v, p) => validateNullableNumber(v, p, { min: 0 }),
    nearby_stock: (v, p) => validateInteger(v, p),
  }, ctx);

const validateSubstitutesSection = (value, path, ctx) =>
  validateObject(value, path, {
    status: (v, p) => validateEnum(v, SECTION_STATUS, p),
    detail: (v, p) => validateNullableString(v, p),
    items: (v, p) => validateArray(v, p, (item, ip) => validateSubstituteItem(item, ip, ctx)),
  }, ctx);

const validateForecastPoint = (value, path, ctx) =>
  validateObject(value, path, {
    date: (v, p) => validateIsoDate(v, p),
    expected_demand: (v, p) => validateNumber(v, p, { min: 0 }),
    lower_bound: (v, p) => validateNumber(v, p, { min: 0 }),
    upper_bound: (v, p) => validateNumber(v, p, { min: 0 }),
    shortage_risk: (v, p) => validateScore(v, p, ctx),
  }, ctx);

const validateForecastInner = (value, path, ctx) =>
  validateObject(value, path, {
    medicine: (v, p) => validateString(v, p),
    city: (v, p) => validateNullableString(v, p),
    trend: (v, p) => validateEnum(v, FORECAST_TREND, p),
    mape: (v, p) => validateNullableNumber(v, p, { min: 0 }),
    rmse: (v, p) => validateNullableNumber(v, p, { min: 0 }),
    points: (v, p) => validateArray(v, p, (item, ip) => validateForecastPoint(item, ip, ctx)),
  }, ctx);

const validateForecastSection = (value, path, ctx) =>
  validateObject(value, path, {
    status: (v, p) => validateEnum(v, SECTION_STATUS, p),
    detail: (v, p) => validateNullableString(v, p),
    forecast: (v, p) => (v === null ? null : validateForecastInner(v, p, ctx)),
  }, ctx);

const validateAvailability = (value, path, ctx) =>
  validateObject(value, path, {
    schema_version: (v, p) => validateInteger(v, p),
    generated_at: (v, p) => validateIsoDatetime(v, p),
    query: (v, p) => validateString(v, p),
    city: (v, p) => validateNullableString(v, p),
    location: (v, p) => (v === null ? null : validateLocation(v, p)),
    partial: (v, p) => validateBoolean(v, p),
    medicine: (v, p) => validateMedicine(v, p, ctx),
    summary: (v, p) => validateSummary(v, p, ctx),
    inventory: (v, p) => validateInventorySection(v, p, ctx),
    substitutes: (v, p) => validateSubstitutesSection(v, p, ctx),
    forecast: (v, p) => validateForecastSection(v, p, ctx),
  }, ctx);

const validateNullableAvailability = (value, path, ctx) =>
  value === null ? null : validateAvailability(value, path, ctx);

const validateSideEffect = (value, path) =>
  validateObject(value, path, {
    effect: (v, p) => validateString(v, p),
    frequency: (v, p) => validateEnum(v, FREQUENCY, p),
  });

const validateProvenance = (value, path) =>
  validateObject(value, path, {
    source: (v, p) => validateString(v, p),
    source_rank: (v, p) => validateInteger(v, p),
    last_updated: (v, p) => validateIsoDatetime(v, p),
  });

const validateMonograph = (value, path, ctx) =>
  validateObject(value, path, {
    ingredient: (v, p) => validateString(v, p),
    drug_class: (v, p) => validateNullableString(v, p),
    aliases: (v, p) => validateStringArray(v, p),
    uses: (v, p) => validateStringArray(v, p),
    mechanism: (v, p) => validateNullableString(v, p),
    side_effects: (v, p) => validateArray(v, p, validateSideEffect),
    contraindications: (v, p) => validateStringArray(v, p),
    warnings: (v, p) => validateStringArray(v, p),
    dosage_forms: (v, p) => validateStringArray(v, p),
    prescription_required: (v, p) => validateBoolean(v, p),
    dosing_note: (v, p) => validateNullableString(v, p),
    provenance: validateProvenance,
  }, ctx);

const validateDrug = (value, path, ctx) =>
  validateObject(value, path, {
    schema_version: (v, p) => validateInteger(v, p),
    generated_at: (v, p) => validateIsoDatetime(v, p),
    query: (v, p) => validateString(v, p),
    resolved_name: (v, p) => validateNullableString(v, p),
    confidence: (v, p) => validateScore(v, p, ctx),
    active_ingredient: (v, p) => validateNullableString(v, p),
    is_combination: (v, p) => validateBoolean(v, p),
    components: (v, p) => validateStringArray(v, p),
    category: (v, p) => validateNullableString(v, p),
    brands: (v, p) => validateStringArray(v, p),
    drug_classes: (v, p) => validateStringArray(v, p),
    uses: (v, p) => validateStringArray(v, p),
    side_effects: (v, p) => validateArray(v, p, validateSideEffect),
    contraindications: (v, p) => validateStringArray(v, p),
    warnings: (v, p) => validateStringArray(v, p),
    dosage_forms: (v, p) => validateStringArray(v, p),
    prescription_required: (v, p) => validateBoolean(v, p),
    dosing_note: (v, p) => validateNullableString(v, p),
    interacts_with: (v, p) => validateStringArray(v, p),
    monographs: (v, p) => validateArray(v, p, (item, ip) => validateMonograph(item, ip, ctx)),
    disclaimer: (v, p) => validateString(v, p, { minLength: 1 }),
  }, ctx);

const validateNullableDrug = (value, path, ctx) =>
  value === null ? null : validateDrug(value, path, ctx);

const validateInteractionPair = (value, path, ctx) =>
  validateObject(value, path, {
    a: (v, p) => validateString(v, p),
    b: (v, p) => validateString(v, p),
    severity: (v, p) => validateEnum(v, INTERACTION_SEVERITY, p),
    description: (v, p) => validateString(v, p),
    mechanism: (v, p) => validateNullableString(v, p),
    recommendation: (v, p) => validateNullableString(v, p),
    confidence: (v, p) => validateScore(v, p, ctx),
  }, ctx);

const validateResolvedMap = (value, path) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    require("./schemaValidator").fail(path, "object<string,string>", value);
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof k !== "string" || typeof v !== "string") {
      require("./schemaValidator").fail(`${path}.${k}`, "string", v);
    }
    out[k] = v;
  }
  return out;
};

const validateInteractions = (value, path, ctx) =>
  validateObject(value, path, {
    schema_version: (v, p) => validateInteger(v, p),
    generated_at: (v, p) => validateIsoDatetime(v, p),
    medicines: (v, p) => validateStringArray(v, p),
    resolved: validateResolvedMap,
    unresolved: (v, p) => validateStringArray(v, p),
    highest_severity: (v, p) => validateNullableEnum(v, INTERACTION_SEVERITY, p),
    interaction_count: (v, p) => validateInteger(v, p),
    interactions: (v, p) => validateArray(v, p, (item, ip) => validateInteractionPair(item, ip, ctx)),
    disclaimer: (v, p) => validateString(v, p, { minLength: 1 }),
  }, ctx);

const validateNullableInteractions = (value, path, ctx) =>
  value === null ? null : validateInteractions(value, path, ctx);

const validateMeta = (value, path, ctx) =>
  validateObject(value, path, {
    partial: (v, p) => validateBoolean(v, p),
    sections_included: (v, p) => validateStringArray(v, p),
    sections_degraded: (v, p) => validateStringArray(v, p),
    request_id: (v, p) => validateNullableString(v, p),
    elapsed_ms: (v, p) => validateNumber(v, p, { min: 0 }),
    schema_version: (v, p) => validateInteger(v, p),
  }, ctx);

const validateAIContextPacket = (raw, ctx = {}) => {
  if (!raw || typeof raw !== "object") {
    require("./schemaValidator").fail("", "AIContextPacket object", raw);
  }
  return validateObject(raw, "", {
    schema_version: (v, p) => validateInteger(v, p),
    generated_at: (v, p) => validateIsoDatetime(v, p),
    query: (v, p) => validateString(v, p),
    city: (v, p) => validateNullableString(v, p),
    location: (v, p) => (v === null ? null : validateLocation(v, p)),
    medicine: (v, p) => validateMedicine(v, p, ctx),
    summary: (v, p) => validateSummary(v, p, ctx),
    availability: (v, p) => validateNullableAvailability(v, p, ctx),
    drug: (v, p) => validateNullableDrug(v, p, ctx),
    interactions: (v, p) => validateNullableInteractions(v, p, ctx),
    facts: (v, p) => validateStringArray(v, p),
    disclaimer: (v, p) => validateString(v, p, { minLength: 1 }),
    meta: (v, p) => validateMeta(v, p, ctx),
  }, ctx);
};

/**
 * Public parse entry point. Accepts an optional context with a clamp warning
 * sink so callers can route warnings into Winston without reaching into the
 * validator.
 */
const parseAIContextPacket = (raw, { onClampWarning } = {}) =>
  validateAIContextPacket(raw, { onClampWarning });

module.exports = {
  parseAIContextPacket,
  // exported for unit tests of nested shapes
  __internal: {
    validateAIContextPacket,
    validateMedicine,
    validateSummary,
    validateAvailability,
    validateDrug,
    validateInteractions,
    validateMeta,
  },
  enums: {
    SECTION_STATUS,
    STOCK_STATUS,
    MATCH_REASON,
    FORECAST_TREND,
    INTERACTION_SEVERITY,
    FREQUENCY,
    PHARMACY_TYPE,
    INVENTORY_TREND,
  },
};
