const Fuse = require("fuse.js");
const MedicineKnowledge = require("../models/MedicineKnowledge");
const { expandMedicineQuery } = require("../services/medicineAliasService");
const { normalizeQuery } = require("../services/intentEngine");
const { buildMedicineMatcherIndex, matchMedicine } = require("./matching/medicineMatcher");

const CATEGORY_ALIASES = {
  "sugar medicine": "antidiabetic",
  diabetes: "antidiabetic",
  acidity: "gastro",
  gas: "gastro",
  fever: "painkiller",
  cough: "respiratory",
  cold: "respiratory",
  bp: "cardiac",
  "blood pressure": "cardiac",
};

let medicineKnowledgeIndex = null;

const canonicalizeArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  return String(value)
    .split(/[|,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
};

const emptyToNull = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
};

const sideEffectText = (entry) => {
  if (!entry) return null;
  if (typeof entry === "string") return emptyToNull(entry);
  return emptyToNull(entry.effect || entry.text || entry.name);
};

const normalizeSideEffectEntry = (entry, defaults = {}) => {
  const effect = sideEffectText(entry);
  if (!effect) return null;
  const sourceEntry = typeof entry === "object" && entry !== null ? entry : {};
  return {
    effect,
    severity: emptyToNull(sourceEntry.severity ?? defaults.severity),
    frequency: emptyToNull(sourceEntry.frequency ?? defaults.frequency),
    source: emptyToNull(sourceEntry.source ?? defaults.source),
    confidence: Number(sourceEntry.confidence ?? defaults.confidence ?? 0.75),
  };
};

const canonicalizeSideEffects = (value, defaults = {}) => {
  const entries = Array.isArray(value) ? value : canonicalizeArray(value);
  return entries
    .map((entry) => normalizeSideEffectEntry(entry, defaults))
    .filter(Boolean);
};

const medicineKeyFor = (record) => {
  if (record.sourceKind === "product_catalog") {
    return normalizeQuery([record.medicineName, record.genericName, record.company].filter(Boolean).join(" "));
  }
  return normalizeQuery(record.genericName || record.salts?.join(" ") || record.medicineName || record.brands?.[0]);
};

const normalizeMedicineRecord = (record = {}, defaults = {}) => {
  const medicineName = record.medicineName || record.name || record.brand || record.brandName || record.genericName;
  const genericName = record.genericName || record.generic || record.salt || record.salts;
  const normalized = {
    medicineName: emptyToNull(medicineName),
    genericName: emptyToNull(genericName || medicineName),
    salts: canonicalizeArray(record.salts || record.salt || genericName),
    brands: canonicalizeArray(record.brands || record.brand || record.brandName),
    aliases: canonicalizeArray(record.aliases || record.alias),
    alternatives: canonicalizeArray(record.alternatives || record.substitutes || record.substitute),
    company: emptyToNull(record.company || record.manufacturer),
    category: String(record.category || defaults.category || "other").trim().toLowerCase(),
    symptoms: canonicalizeArray(record.symptoms || record.uses || record.useCase),
    sideEffects: canonicalizeSideEffects(record.sideEffects || record.side_effects, {
      source: record.source || defaults.source,
      confidence: record.sideEffectConfidence || defaults.sideEffectConfidence || 0.75,
    }),
    precautions: canonicalizeArray(record.precautions || record.warnings),
    prescriptionRequired: ["true", "yes", "1", true].includes(record.prescriptionRequired ?? record.rxRequired),
    commonSpellings: canonicalizeArray(record.commonSpellings || record.spellings),
    confidence: Number(record.confidence || defaults.confidence || 0.75),
    source: emptyToNull(record.source || defaults.source) || "unknown",
    sourceMetadata: {
      trustLevel: record.trustLevel || defaults.trustLevel || "unknown",
      importedAt: new Date(),
      datasetVersion: record.datasetVersion || defaults.datasetVersion || "unknown",
    },
    sourceKind: record.sourceKind || defaults.sourceKind,
  };
  normalized.knowledgeKey = medicineKeyFor(normalized);
  return normalized;
};

const buildSearchText = (record) =>
  [
    record.medicineName,
    record.genericName,
    ...(record.salts || []),
    ...(record.brands || []),
    ...(record.aliases || []),
    ...(record.alternatives || []),
    ...(record.sideEffects || []).map(sideEffectText),
    ...(record.commonSpellings || []),
    ...(record.symptoms || []),
    record.category,
  ]
    .filter(Boolean)
    .join(" ");

const createKnowledgeIndex = (records = []) => {
  const indexedRecords = records.map((record) => ({ ...record, searchText: buildSearchText(record) }));
  return {
    records: indexedRecords,
    matcher: buildMedicineMatcherIndex(indexedRecords),
    fuse: new Fuse(indexedRecords, {
      keys: ["searchText"],
      includeScore: true,
      threshold: 0.35,
      ignoreLocation: true,
    }),
    rebuiltAt: new Date(),
  };
};

const compactSuggestion = (record = {}, confidence = 0) => ({
  medicineName: record.medicineName,
  genericName: record.genericName,
  brands: (record.brands || []).slice(0, 3),
  aliases: (record.aliases || []).slice(0, 3),
  category: record.category,
  confidence: Math.max(0, Math.min(1, confidence)),
});

const suggestMedicines = (index, query, limit = 3) =>
  (index?.fuse?.search(query) || [])
    .slice(0, limit)
    .map(({ item, score }) => compactSuggestion(item, Math.max(0, Math.min(1, 1 - (score || 0)))));

const rebuildMedicineKnowledgeIndex = async (records = null) => {
  const sourceRecords =
    records || (await MedicineKnowledge.find().limit(Number(process.env.MEDICINE_KNOWLEDGE_INDEX_LIMIT || 300000)).lean());
  medicineKnowledgeIndex = createKnowledgeIndex(sourceRecords);
  return {
    count: medicineKnowledgeIndex.records.length,
    rebuiltAt: medicineKnowledgeIndex.rebuiltAt,
  };
};

const clearMedicineKnowledgeIndex = () => {
  medicineKnowledgeIndex = null;
};

const getMedicineKnowledgeIndex = async () => {
  if (!medicineKnowledgeIndex) {
    await rebuildMedicineKnowledgeIndex();
  }
  return medicineKnowledgeIndex;
};

const escapeRegex = (value = "") => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const compactRegexFor = (value = "") => {
  const compact = normalizeQuery(value).replace(/\s+/g, "");
  if (compact.length < 4 || compact.length > 40) return null;
  return new RegExp(`^${compact.split("").map(escapeRegex).join("[\\s-]*")}$`, "i");
};

const findDirectMedicineMatch = async (query) => {
  const normalized = String(query || "").trim();
  if (!normalized || normalized.length < 2) return null;
  const exact = new RegExp(`^${escapeRegex(normalized)}$`, "i");
  const direct = await MedicineKnowledge.findOne({
    $or: [
      { medicineName: exact },
      { genericName: exact },
      { salts: exact },
      { brands: exact },
      { aliases: exact },
      { commonSpellings: exact },
    ],
  })
    .sort({ confidence: -1, sourceKind: -1, updatedAt: -1 })
    .lean();
  if (direct) return direct;

  const compact = compactRegexFor(normalized);
  if (!compact) return null;
  return MedicineKnowledge.findOne({
    $or: [
      { medicineName: compact },
      { genericName: compact },
      { salts: compact },
      { brands: compact },
      { aliases: compact },
      { commonSpellings: compact },
    ],
  })
    .sort({ confidence: -1, sourceKind: -1, updatedAt: -1 })
    .lean();
};

const findTextMedicineCandidates = async (query, limit = Number(process.env.MEDICINE_TEXT_CANDIDATE_LIMIT || 25)) => {
  const search = normalizeQuery(query)
    .split(" ")
    .filter((token) => token.length >= 3)
    .join(" ");
  if (!search) return [];
  try {
    return MedicineKnowledge.find(
      { $text: { $search: search } },
      { score: { $meta: "textScore" } }
    )
      .sort({ score: { $meta: "textScore" }, confidence: -1 })
      .limit(limit)
      .lean();
  } catch {
    return [];
  }
};

const matchAgainstRecords = async (query, records = []) => {
  const index = createKnowledgeIndex(records);
  if (!index.records.length) return null;
  const matcherResult = await matchMedicine(
    {
      medicineName: query,
      genericName: query,
      brands: [query],
    },
    index.matcher,
    {
      useFuzzy: true,
      useSemantic:
        process.env.LIVE_MEDICINE_SEMANTIC_MATCHING === "true" &&
        process.env.ENABLE_SLOW_SEMANTIC_MATCHING === "true",
    }
  );

  if (matcherResult.confidence >= 0.55 && matcherResult.medicines[0]) {
    return {
      type: "medicine",
      normalizedQuery: matcherResult.medicines[0].genericName || matcherResult.medicines[0].medicineName,
      medicine: matcherResult.medicines[0],
      confidence: matcherResult.confidence,
      reason: matcherResult.reason,
      method: matcherResult.method,
      usedSemantic: matcherResult.usedSemantic,
    };
  }

  const suggestions = suggestMedicines(index, query);
  return {
    type: "unknown",
    normalizedQuery: query,
    confidence: suggestions[0]?.confidence || matcherResult.confidence || 0,
    reason: suggestions.length ? "candidate suggestions below confidence threshold" : "no candidate match",
    method: matcherResult.method,
    usedSemantic: matcherResult.usedSemantic,
    suggestions,
  };
};

const normalizeMedicineQuery = async (query, { records = null } = {}) => {
  const normalized = normalizeQuery(query);
  const categoryMatch = Object.entries(CATEGORY_ALIASES).find(([term]) => normalized.includes(term));
  if (categoryMatch) {
    return {
      type: "category",
      normalizedQuery: categoryMatch[1],
      confidence: 0.78,
      reason: "category alias",
    };
  }

  const aliasExpansion = expandMedicineQuery(query);
  if (aliasExpansion.alias) {
    return {
      type: "medicine",
      normalizedQuery: aliasExpansion.normalizedQuery,
      medicine: {
        genericName: aliasExpansion.alias.salt,
        brands: aliasExpansion.alias.brands || [],
        category: aliasExpansion.alias.category,
      },
      confidence: 0.86,
      reason: "curated alias",
    };
  }

  if (!records) {
    const directMatch = await findDirectMedicineMatch(query);
    if (directMatch) {
      return {
        type: "medicine",
        normalizedQuery: directMatch.genericName || directMatch.medicineName,
        medicine: directMatch,
        confidence: 0.96,
        reason: "direct knowledge match",
        method: "mongo-direct",
      };
    }

    const candidateRecords = await findTextMedicineCandidates(query);
    if (candidateRecords.length) {
      const candidateResult = await matchAgainstRecords(query, candidateRecords);
      if (candidateResult?.type === "medicine") return candidateResult;
      // Otherwise fall through to the in-memory Fuse fuzzy index below — typos
      // like "Prrgabakin" / "dolp" produce zero text-search hits, so the
      // global fuzzy index is the real safety net.
    }
  }

  const index = records ? createKnowledgeIndex(records) : await getMedicineKnowledgeIndex();
  if (!index.records.length) {
    return {
      type: "unknown",
      normalizedQuery: query,
      confidence: 0,
      reason: "no knowledge records",
    };
  }

  const matcherResult = await matchMedicine(
    {
      medicineName: query,
      genericName: query,
      brands: [query],
    },
    index.matcher,
    {
      useFuzzy: true,
      useSemantic:
        process.env.LIVE_MEDICINE_SEMANTIC_MATCHING === "true" &&
        process.env.ENABLE_SLOW_SEMANTIC_MATCHING === "true",
    }
  );

  if (matcherResult.confidence >= 0.55 && matcherResult.medicines[0]) {
    return {
      type: "medicine",
      normalizedQuery: matcherResult.medicines[0].genericName || matcherResult.medicines[0].medicineName,
      medicine: matcherResult.medicines[0],
      confidence: matcherResult.confidence,
      reason: matcherResult.reason,
      method: matcherResult.method,
      usedSemantic: matcherResult.usedSemantic,
    };
  }

  const [best] = index.fuse.search(query);
  if (!best) {
    return {
      type: "unknown",
      normalizedQuery: query,
      confidence: 0,
      reason: "no fuzzy match",
      suggestions: suggestMedicines(index, query),
    };
  }

  const confidence = Math.max(0, Math.min(1, 1 - best.score));
  if (confidence < 0.45) {
    return {
      type: "unknown",
      normalizedQuery: query,
      confidence,
      reason: "low confidence fuzzy match",
      suggestions: suggestMedicines(index, query),
    };
  }

  return {
    type: "medicine",
    normalizedQuery: best.item.genericName || best.item.medicineName,
    medicine: best.item,
    confidence,
    reason: "knowledge fuzzy match",
    method: "fuse",
  };
};

module.exports = {
  CATEGORY_ALIASES,
  buildSearchText,
  canonicalizeArray,
  canonicalizeSideEffects,
  clearMedicineKnowledgeIndex,
  emptyToNull,
  findDirectMedicineMatch,
  findTextMedicineCandidates,
  medicineKeyFor,
  normalizeMedicineQuery,
  normalizeMedicineRecord,
  normalizeSideEffectEntry,
  rebuildMedicineKnowledgeIndex,
  suggestMedicines,
  sideEffectText,
};
