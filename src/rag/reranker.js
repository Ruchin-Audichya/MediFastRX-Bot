const STOPWORDS = new Set(["a", "an", "and", "are", "for", "from", "hai", "is", "ka", "ke", "ki", "ko", "me", "of", "the", "to"]);

const tokenize = (text = "") =>
  new Set(
    String(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((token) => token && !STOPWORDS.has(token))
  );

const overlapScore = (query, text) => {
  const queryTokens = tokenize(query);
  if (queryTokens.size === 0) return 0;
  const textTokens = tokenize(text);
  const matches = [...queryTokens].filter((token) => textTokens.has(token)).length;
  return matches / queryTokens.size;
};

const normalizeVectorScore = (score) => {
  if (typeof score !== "number") return 0.5;
  return Math.max(0, Math.min(1, 1 - score));
};

// Phase 5.5: when an active medicine is supplied, boost matches and demote /
// drop mismatches. When no scope is supplied, this signal is `null` and the
// reranker's components/ordering stay byte-for-byte identical to today
// (preservation contract P4.b).
const RETRIEVAL_MEDICINE_WEIGHT = Number(process.env.RETRIEVAL_MEDICINE_WEIGHT || 0.25);
const RETRIEVAL_MISMATCH_DROP_THRESHOLD = Number(
  process.env.RETRIEVAL_MISMATCH_DROP_THRESHOLD || 0.2
);

const medicineMatchScore = (result, medicineScope) => {
  if (!medicineScope) return null;
  const tokens = new Set();
  const add = (v) => {
    if (v === null || v === undefined) return;
    const s = String(v).trim().toLowerCase();
    if (s) tokens.add(s);
  };
  add(medicineScope.medicineName);
  add(medicineScope.genericName);
  (medicineScope.aliases || []).forEach(add);
  (medicineScope.salts || []).forEach(add);
  if (tokens.size === 0) return null;
  const meta = result.metadata || {};
  const candidates = ["medicine", "generic", "alias"]
    .map((k) => meta[k])
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .map((v) => String(v).trim().toLowerCase());
  if (candidates.length === 0) return 0; // neutral chunk — no boost, no demote
  return candidates.some((c) => tokens.has(c)) ? 1 : -1;
};

const rerank = (query, results = [], options = {}) => {
  const {
    category,
    medicineScope = null,
    semanticWeight = Number(process.env.RETRIEVAL_SEMANTIC_WEIGHT || 0.55),
    keywordWeight = Number(process.env.RETRIEVAL_KEYWORD_WEIGHT || 0.35),
    categoryWeight = Number(process.env.RETRIEVAL_CATEGORY_WEIGHT || 0.1),
    medicineWeight = RETRIEVAL_MEDICINE_WEIGHT,
    mismatchDropThreshold = RETRIEVAL_MISMATCH_DROP_THRESHOLD,
  } = options;

  return results
    .map((result) => {
      const semantic = normalizeVectorScore(result.vectorScore ?? result.score);
      const keyword = result.keywordScore ?? overlapScore(query, result.text);
      const categoryMatch = category && result.metadata?.category === category ? 1 : 0;
      const medicineMatch = medicineMatchScore(result, medicineScope); // null | -1 | 0 | 1
      const baseConfidence =
        semantic * semanticWeight +
        keyword * keywordWeight +
        categoryMatch * categoryWeight;
      // Only attach the medicine component when a scope is supplied —
      // preserves the {category, keyword, semantic} components shape for the
      // no-scope case (P4.b preservation).
      const components = medicineMatch === null
        ? { semantic, keyword, category: categoryMatch }
        : { semantic, keyword, category: categoryMatch, medicineMatch };
      const confidence = medicineMatch === null
        ? Math.max(0, Math.min(1, baseConfidence))
        : Math.max(0, Math.min(1, baseConfidence + medicineMatch * medicineWeight));
      return { ...result, score: confidence, confidence, components };
    })
    .filter((r) => {
      // Drop only clear mismatches (medicineMatch === -1) below the configured
      // threshold. Boosted matches and neutral chunks are kept.
      return !(r.components.medicineMatch === -1 && r.confidence < mismatchDropThreshold);
    })
    .sort((a, b) => b.confidence - a.confidence);
};

module.exports = {
  overlapScore,
  rerank,
  medicineMatchScore,
};
