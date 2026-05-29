"use strict";

/**
 * mediatlasMapper — converts a validated MediAtlas AIContextPacket
 * (snake_case on the wire) into MediFast's internal camelCase shape used
 * by the evidenceCollector, safety guard, and Telegram formatter.
 *
 * Locked behavior:
 *   - top-level `medicine` and `availability.medicine` are the same shape
 *     intentionally; we dedupe by reference equality on
 *     (resolved_name + generic + match_reason). The packet's top-level
 *     view wins; availability.medicine is dropped from the mapped output.
 *   - `summary` is flattened into the mapped envelope so the safety guard
 *     can read availability flags without indexing through availability.
 *   - `availability`, `drug`, `interactions` may be null. The mapped output
 *     keeps the same nullability — null means "section degraded or
 *     skipped", NOT "no result".
 *   - `summary.best_pharmacy_*` and `summary.nearest_distance_km` are
 *     null when nothing is in stock; mapper preserves nulls verbatim.
 *   - The mapper never invents fields. If the packet is missing a value
 *     it surfaces null, not a default.
 *
 * Output shape is documented inline below and used by the contextTool's
 * evidence-collector projection in a later sprint.
 */

const camel = (snake) => {
  if (!snake || typeof snake !== "string") return snake;
  return snake.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
};

const mapMedicine = (m) =>
  m
    ? {
        query: m.query,
        resolvedName: m.resolved_name,
        generic: m.generic,
        category: m.category,
        confidence: m.confidence,
        matchReason: m.match_reason,
        aliases: m.aliases || [],
      }
    : null;

const medicineFingerprint = (m) =>
  m ? `${m.resolvedName || ""}|${m.generic || ""}|${m.matchReason || ""}` : "";

const mapSummary = (s) =>
  s
    ? {
        availableNearby: s.available_nearby,
        bestPharmacyId: s.best_pharmacy_id,
        bestPharmacyName: s.best_pharmacy_name,
        nearestDistanceKm: s.nearest_distance_km,
        maxStockNearby: s.max_stock_nearby,
        shortageRisk: s.shortage_risk,
        recommendSubstitutes: s.recommend_substitutes,
      }
    : null;

const mapPharmacy = (p) =>
  p
    ? {
        id: p.id,
        name: p.name,
        city: p.city,
        latitude: p.latitude,
        longitude: p.longitude,
        rating: p.rating,
        deliveryAvailable: p.delivery_available,
        pharmacyType: p.pharmacy_type,
      }
    : null;

const mapInventoryItem = (item) => ({
  medicineId: item.medicine_id,
  medicineName: item.medicine_name,
  canonicalMedicine: item.canonical_medicine,
  generic: item.generic,
  brand: item.brand,
  category: item.category,
  manufacturer: item.manufacturer,
  stock: item.stock,
  stockStatus: item.stock_status,
  pharmacyId: item.pharmacy_id,
  pharmacy: mapPharmacy(item.pharmacy),
  distanceKm: item.distance_km,
  price: item.price,
  availabilityConfidence: item.availability_confidence,
  forecastRisk: item.forecast_risk,
  forecast: item.forecast,
  substitutes: item.substitutes || [],
  inventoryTrend: item.inventory_trend,
  expiry: item.expiry,
  lastUpdated: item.last_updated,
  batchNumber: item.batch_number,
});

const mapInventorySection = (section) =>
  section
    ? {
        status: section.status,
        detail: section.detail,
        totalInRadius: section.total_in_radius,
        items: (section.items || []).map(mapInventoryItem),
      }
    : null;

const mapSubstituteItem = (item) => ({
  medicineName: item.medicine_name,
  activeIngredient: item.active_ingredient,
  score: item.score,
  availabilityScore: item.availability_score,
  priceScore: item.price_score,
  distanceScore: item.distance_score,
  sideEffectSimilarity: item.side_effect_similarity,
  medianPrice: item.median_price,
  nearbyStock: item.nearby_stock,
});

const mapSubstitutesSection = (section) =>
  section
    ? {
        status: section.status,
        detail: section.detail,
        items: (section.items || []).map(mapSubstituteItem),
      }
    : null;

const mapForecastPoint = (p) => ({
  date: p.date,
  expectedDemand: p.expected_demand,
  lowerBound: p.lower_bound,
  upperBound: p.upper_bound,
  shortageRisk: p.shortage_risk,
});

const mapForecastInner = (f) =>
  f
    ? {
        medicine: f.medicine,
        city: f.city,
        trend: f.trend,
        mape: f.mape,
        rmse: f.rmse,
        points: (f.points || []).map(mapForecastPoint),
      }
    : null;

const mapForecastSection = (section) =>
  section
    ? {
        status: section.status,
        detail: section.detail,
        forecast: mapForecastInner(section.forecast),
      }
    : null;

const mapAvailability = (a) => {
  if (!a) return null;
  // medicine + summary inside availability are duplicates of top-level by
  // contract; mapper drops them to avoid double-walking in evidenceCollector.
  return {
    schemaVersion: a.schema_version,
    generatedAt: a.generated_at,
    query: a.query,
    city: a.city,
    location: a.location
      ? { latitude: a.location.latitude, longitude: a.location.longitude }
      : null,
    partial: a.partial,
    inventory: mapInventorySection(a.inventory),
    substitutes: mapSubstitutesSection(a.substitutes),
    forecast: mapForecastSection(a.forecast),
  };
};

const mapSideEffect = (e) => ({ effect: e.effect, frequency: e.frequency });

const mapProvenance = (p) => ({
  source: p.source,
  sourceRank: p.source_rank,
  lastUpdated: p.last_updated,
});

const mapMonograph = (m) => ({
  ingredient: m.ingredient,
  drugClass: m.drug_class,
  aliases: m.aliases || [],
  uses: m.uses || [],
  mechanism: m.mechanism,
  sideEffects: (m.side_effects || []).map(mapSideEffect),
  contraindications: m.contraindications || [],
  warnings: m.warnings || [],
  dosageForms: m.dosage_forms || [],
  prescriptionRequired: m.prescription_required,
  dosingNote: m.dosing_note,
  provenance: mapProvenance(m.provenance),
});

const mapDrug = (d) =>
  d
    ? {
        schemaVersion: d.schema_version,
        generatedAt: d.generated_at,
        query: d.query,
        resolvedName: d.resolved_name,
        confidence: d.confidence,
        activeIngredient: d.active_ingredient,
        isCombination: d.is_combination,
        components: d.components || [],
        category: d.category,
        brands: d.brands || [],
        drugClasses: d.drug_classes || [],
        uses: d.uses || [],
        sideEffects: (d.side_effects || []).map(mapSideEffect),
        contraindications: d.contraindications || [],
        warnings: d.warnings || [],
        dosageForms: d.dosage_forms || [],
        prescriptionRequired: d.prescription_required,
        dosingNote: d.dosing_note,
        interactsWith: d.interacts_with || [],
        monographs: (d.monographs || []).map(mapMonograph),
        disclaimer: d.disclaimer,
      }
    : null;

const mapInteractionPair = (p) => ({
  a: p.a,
  b: p.b,
  severity: p.severity,
  description: p.description,
  mechanism: p.mechanism,
  recommendation: p.recommendation,
  confidence: p.confidence,
});

const mapInteractions = (i) =>
  i
    ? {
        schemaVersion: i.schema_version,
        generatedAt: i.generated_at,
        medicines: i.medicines || [],
        resolved: { ...(i.resolved || {}) },
        unresolved: i.unresolved || [],
        highestSeverity: i.highest_severity,
        interactionCount: i.interaction_count,
        interactions: (i.interactions || []).map(mapInteractionPair),
        disclaimer: i.disclaimer,
      }
    : null;

const mapMeta = (meta) =>
  meta
    ? {
        partial: meta.partial,
        sectionsIncluded: meta.sections_included || [],
        sectionsDegraded: meta.sections_degraded || [],
        requestId: meta.request_id,
        elapsedMs: meta.elapsed_ms,
        schemaVersion: meta.schema_version,
      }
    : null;

/**
 * Map a validated AIContextPacket into the MediFast internal envelope.
 * Returns:
 *   {
 *     source: "mediatlas",
 *     schemaVersion, generatedAt, query, city, location,
 *     medicine, summary,
 *     availability, drug, interactions,
 *     facts: [],
 *     disclaimer,
 *     meta,
 *     // confidence convenience block for evidenceCollector
 *     confidence: { medicine, drug, summary }
 *   }
 */
const mapAIContextPacket = (packet) => {
  if (!packet) return null;

  const medicine = mapMedicine(packet.medicine);
  const summary = mapSummary(packet.summary);

  // Defensive dedupe: if availability.medicine resolves to the same identity
  // as the top-level medicine, we strip it during mapping (mapAvailability
  // already drops it). If it differs we log it; in practice MediAtlas's
  // contract guarantees they match.
  const availabilityMedicine = packet.availability?.medicine
    ? mapMedicine(packet.availability.medicine)
    : null;
  if (availabilityMedicine && medicine) {
    if (medicineFingerprint(availabilityMedicine) !== medicineFingerprint(medicine)) {
      // Surfaced via meta so callers can branch; never throw on this.
      packet.__mediatlasMedicineDriftDetected = true;
    }
  }

  const meta = mapMeta(packet.meta);

  return {
    source: "mediatlas",
    schemaVersion: packet.schema_version,
    generatedAt: packet.generated_at,
    query: packet.query,
    city: packet.city,
    location: packet.location
      ? { latitude: packet.location.latitude, longitude: packet.location.longitude }
      : null,
    medicine,
    summary,
    availability: mapAvailability(packet.availability),
    drug: mapDrug(packet.drug),
    interactions: mapInteractions(packet.interactions),
    facts: packet.facts || [],
    disclaimer: packet.disclaimer,
    meta,
    confidence: {
      medicine: medicine?.confidence ?? 0,
      drug: packet.drug?.confidence ?? 0,
      summary:
        summary && summary.availableNearby
          ? Math.max(0, 1 - (summary.shortageRisk ?? 0))
          : 0,
    },
    // Surfaces lifted from meta for ergonomic safety-guard checks.
    isPartial: Boolean(meta?.partial),
    degradedSections: meta?.sectionsDegraded || [],
    medicineDriftDetected: Boolean(packet.__mediatlasMedicineDriftDetected),
  };
};

module.exports = {
  mapAIContextPacket,
  // exported for unit tests
  __internal: {
    mapMedicine,
    mapSummary,
    mapAvailability,
    mapDrug,
    mapInteractions,
    mapMeta,
    medicineFingerprint,
    camel,
  },
};
