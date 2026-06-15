const Fuse = require("fuse.js");
const Inventory = require("../models/Inventory");
require("../models/Pharmacy");
const SosRequest = require("../models/SosRequest");
const medicineCache = require("../cache/medicineCache");
const { searchMedicineKnowledge } = require("../medicine/medicineKnowledgeService");
const { expandMedicineQuery } = require("./medicineAliasService");
const { detectIntent } = require("./intentEngine");
const logger = require("../utils/logger");

// Fuse.js configuration for fuzzy medicine name search
const FUSE_OPTIONS = {
  keys: [
    { name: "medicineName", weight: 0.6 },
    { name: "genericName", weight: 0.25 },
    { name: "brand", weight: 0.15 },
  ],
  threshold: 0.4,       // 0 = perfect match, 1 = match anything
  distance: 100,
  includeScore: true,
  minMatchCharLength: 3,
  shouldSort: true,
  ignoreLocation: true,
};

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const liveInventorySearchEnabled = () => process.env.ENABLE_LIVE_INVENTORY_SEARCH === "true";

/**
 * Search for medicines across all pharmacies.
 * Returns results sorted by: in-stock first, then best fuzzy match.
 */
const uniqueById = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const id = item._id.toString();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const mapInventoryResult = (item, score = 0.5) => ({
  id: item._id.toString(),
  medicineName: item.medicineName,
  genericName: item.genericName || null,
  brand: item.brand || null,
  price: item.price || null,
  unit: item.unit,
  inStock: item.inStock,
  quantity: item.quantity,
  requiresPrescription: item.requiresPrescription,
  isRare: item.isRare,
  category: item.category,
  lastVerified: item.lastVerified,
  matchScore: score,
  pharmacy: {
    id: item.pharmacy._id.toString(),
    name: item.pharmacy.name,
    area: item.pharmacy.area,
    address: item.pharmacy.address,
    phone: item.pharmacy.contact?.phone || null,
    whatsapp: item.pharmacy.contact?.whatsapp || null,
    hours: item.pharmacy.is24x7 ? "Open 24×7" : item.pharmacy.openingHours,
  },
});

const CATEGORY_MAP = {
  "pain/fever": "painkiller",
  "mental health": "neurological",
  neurology: "neurological",
  antibiotic: "antibiotic",
  acidity: "gastro",
  allergy: "respiratory",
  "cough/cold": "respiratory",
  diabetes: "antidiabetic",
  "blood pressure": "cardiac",
  cholesterol: "cardiac",
  nausea: "gastro",
};

const normalizeCategory = (category = "other") =>
  CATEGORY_MAP[String(category).toLowerCase()] || String(category || "other").toLowerCase();

const chooseDisplayName = (medicine = {}, query = "") => {
  const normalizedQuery = query.toLowerCase().trim();
  const candidates = [
    medicine.medicineName,
    ...(medicine.brands || []),
    ...(medicine.aliases || []),
    ...(medicine.commonSpellings || []),
    medicine.genericName,
  ].filter(Boolean);
  return (
    candidates.find((name) => String(name).toLowerCase() === normalizedQuery) ||
    candidates.find((name) => String(name).toLowerCase().includes(normalizedQuery) || normalizedQuery.includes(String(name).toLowerCase())) ||
    medicine.genericName ||
    medicine.medicineName ||
    query
  );
};

const mapKnowledgeResult = (knowledge, query) => {
  const medicine = knowledge?.medicine;
  if (!medicine) return null;
  const displayName = chooseDisplayName(medicine, query);
  const brand = medicine.brands?.find((name) => name === displayName) || medicine.brands?.[0] || medicine.medicineName;
  return {
    id: `knowledge:${medicine._id || medicine.knowledgeKey || medicine.genericName || query}`,
    medicineName: displayName,
    genericName: medicine.genericName || medicine.salts?.[0] || null,
    brand,
    price: null,
    unit: "knowledge",
    inStock: false,
    quantity: null,
    requiresPrescription: Boolean(medicine.prescriptionRequired),
    isRare: false,
    category: normalizeCategory(medicine.category),
    lastVerified: medicine.updatedAt || medicine.sourceMetadata?.importedAt || null,
    matchScore: Math.max(0.05, 1 - (knowledge.confidence || medicine.confidence || 0.75)),
    confidence: knowledge.confidence || medicine.confidence || 0.75,
    knowledgeOnly: true,
    alternatives: knowledge.alternatives || [],
    brands: medicine.brands || [],
    aliases: medicine.aliases || [],
    symptoms: medicine.symptoms || [],
    diseases: medicine.diseases || [],
    sideEffects: medicine.sideEffects || [],
    precautions: medicine.precautions || [],
    pharmacy: {
      id: "knowledge",
      name: "Medicine knowledge match",
      area: "No live pharmacy stock confirmed",
      address: "Use Nearby Pharmacy to check stores around you.",
      phone: null,
      whatsapp: null,
      hours: "Knowledge only",
    },
  };
};

const searchKnowledgeFallback = async (query) => {
  try {
    const aliasExpansion = expandMedicineQuery(query);
    if (aliasExpansion.alias) {
      const aliasMedicine = {
        medicineName: aliasExpansion.alias.brands?.[0] || aliasExpansion.alias.salt,
        genericName: aliasExpansion.alias.salt,
        brands: aliasExpansion.alias.brands || [],
        aliases: aliasExpansion.alias.commonSpellings || [],
        category: aliasExpansion.alias.category,
        prescriptionRequired: Boolean(aliasExpansion.alias.rxRequired),
        confidence: 0.9,
      };
      return {
        results: [mapKnowledgeResult({ medicine: aliasMedicine, confidence: 0.9, alternatives: [] }, query)],
        suggestions: [],
      };
    }
    const knowledge = await searchMedicineKnowledge({ query });
    const result = mapKnowledgeResult(knowledge, query);
    return {
      results: result ? [result] : [],
      suggestions: knowledge?.suggestions || [],
    };
  } catch (error) {
    logger.warn(`Medicine knowledge fallback failed: ${error.message}`);
    // Mongo unreachable (or knowledge service threw) — use the in-memory
    // curated fallback catalog so the bot never hard-fails on a lookup.
    try {
      const { findFallbackMedicine, toKnowledgeShape } = require("../medicine/fallbackCatalog");
      const rec = findFallbackMedicine(query);
      if (rec) {
        const shaped = toKnowledgeShape(rec);
        const mapped = mapKnowledgeResult(shaped, query);
        if (mapped) {
          logger.info(`Served "${query}" from in-memory fallback catalog (Mongo unavailable).`);
          return { results: [mapped], suggestions: [] };
        }
      }
    } catch (fallbackErr) {
      logger.warn(`In-memory fallback catalog failed: ${fallbackErr.message}`);
    }
    return { results: [], suggestions: [] };
  }
};

const searchMedicine = async (query, options = {}) => {
  if (!query || query.trim().length < 2) {
    return { results: [], sos: false, query };
  }

  const trimmedQuery = query.trim();
  const inferredIntent = options.key || options.confidence ? options : detectIntent(trimmedQuery);
  const primaryQuery = inferredIntent?.confidence && inferredIntent.confidence !== "medicine"
    ? inferredIntent.normalizedQuery
    : trimmedQuery;
  const searchTerms = [
    primaryQuery,
    trimmedQuery,
    ...(inferredIntent.searchTerms || []),
    ...(options.searchTerms || []),
  ].filter(Boolean);
  const categories = [...new Set([...(inferredIntent.categories || []), ...(options.categories || [])])];
  const cached = medicineCache.get(primaryQuery, { searchTerms, categories });
  if (cached) return { ...cached, cacheHit: true };

  if (!liveInventorySearchEnabled()) {
    const knowledgeFallback = await searchKnowledgeFallback(primaryQuery);
    return medicineCache.set(primaryQuery, { searchTerms, categories }, {
      results: knowledgeFallback.results,
      suggestions: knowledgeFallback.suggestions,
      sos: knowledgeFallback.results.length === 0,
      knowledgeOnly: knowledgeFallback.results.length > 0,
      query: primaryQuery,
    });
  }

  const inventoryLimit = Number(process.env.SEARCH_INVENTORY_PREFILTER_LIMIT || 250);
  const textSearch = searchTerms
    .map((term) => String(term || "").trim())
    .filter((term) => term.length >= 2)
    .slice(0, 8)
    .join(" ");
  const inventoryFilter = {
    inStock: true,
    ...(textSearch || categories.length
      ? {
          $or: [
            ...(textSearch ? [{ $text: { $search: textSearch } }] : []),
            ...(categories.length ? [{ category: { $in: categories } }] : []),
          ],
        }
      : {}),
  };

  const candidateInventory = await Inventory.find(inventoryFilter)
    .limit(inventoryLimit)
    .populate("pharmacy", "name area address contact openingHours is24x7 isActive")
    .lean();

  // Filter out entries where pharmacy is inactive
  const activeInventory = candidateInventory.filter(
    (item) => item.pharmacy && item.pharmacy.isActive
  );

  if (activeInventory.length === 0) {
    const knowledgeFallback = await searchKnowledgeFallback(primaryQuery);
    return medicineCache.set(primaryQuery, { searchTerms, categories }, {
      results: knowledgeFallback.results,
      suggestions: knowledgeFallback.suggestions,
      sos: knowledgeFallback.results.length === 0,
      knowledgeOnly: knowledgeFallback.results.length > 0,
      query: primaryQuery,
    });
  }

  // Run Fuse.js fuzzy search
  const fuse = new Fuse(activeInventory, FUSE_OPTIONS);
  const fuseResults = uniqueById(
    searchTerms.flatMap((term) => fuse.search(term).map((result) => ({
      ...result.item,
      _matchScore: result.score,
    })))
  );

  const categoryResults = categories.length
    ? activeInventory
        .filter((item) => categories.includes(item.category))
        .map((item) => ({ ...item, _matchScore: 0.55 }))
    : [];

  const combinedResults = uniqueById([...fuseResults, ...categoryResults]);

  if (combinedResults.length === 0) {
    const knowledgeFallback = await searchKnowledgeFallback(primaryQuery);
    if (knowledgeFallback.results.length > 0) {
      return medicineCache.set(primaryQuery, { searchTerms, categories }, {
        results: knowledgeFallback.results,
        suggestions: knowledgeFallback.suggestions,
        sos: false,
        knowledgeOnly: true,
        query: primaryQuery,
      });
    }

    // No match found — check if this is a known rare medicine
    const rareMatch = await Inventory.findOne({
      isRare: true,
      medicineNameLower: { $regex: trimmedQuery.toLowerCase(), $options: "i" },
    });

    return medicineCache.set(primaryQuery, { searchTerms, categories }, {
      results: [],
      suggestions: knowledgeFallback.suggestions,
      sos: true, // trigger SOS flow
      isRare: !!rareMatch,
      query: primaryQuery,
    });
  }

  // Map to clean result objects
  const results = combinedResults
    .map((item) => mapInventoryResult(item, item._matchScore))
    .sort((a, b) => a.matchScore - b.matchScore);

  // Check if any result is a rare medicine
  const hasRare = results.some((r) => r.isRare);

  return medicineCache.set(primaryQuery, { searchTerms, categories }, {
    results,
    sos: results.length === 0,
    hasRare,
    query: primaryQuery,
  });
};

/**
 * Search across ALL inventory (in-stock + out-of-stock) for admin use.
 */
const searchMedicineFull = async (query) => {
  const allInventory = await Inventory.find()
    .populate("pharmacy", "name area address contact openingHours is24x7")
    .lean();

  const fuse = new Fuse(allInventory, FUSE_OPTIONS);
  return fuse.search(query).map(({ item }) => item);
};

/**
 * Create an SOS request and log it.
 */
const createSosRequest = async ({ medicineName, telegramId, username, firstName, area, contact }) => {
  try {
    // Avoid duplicate open SOS for same medicine from same user
    const existing = await SosRequest.findOne({
      medicineName: { $regex: medicineName, $options: "i" },
      "requestedBy.telegramId": String(telegramId),
      status: "open",
    });

    if (existing) {
      return { created: false, request: existing };
    }

    const request = await SosRequest.create({
      medicineName,
      requestedBy: { telegramId: String(telegramId), username, firstName },
      area,
      contact,
    });

    return { created: true, request };
  } catch (error) {
    logger.error(`SOS creation error: ${error.message}`);
    throw error;
  }
};

/**
 * Get all open SOS requests (for admin).
 */
const getOpenSosRequests = async () => {
  return SosRequest.find({ status: "open" }).sort({ createdAt: -1 }).lean();
};

module.exports = {
  searchMedicine,
  searchMedicineFull,
  createSosRequest,
  getOpenSosRequests,
};
