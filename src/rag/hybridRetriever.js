const Fuse = require("fuse.js");
const { loadKnowledgeBase } = require("./documentLoader");
const { chunkDocuments } = require("./chunker");
const { retrieve } = require("./retriever");
const { rerank } = require("./reranker");
const eventBus = require("../events/eventBus");

const DEFAULT_TOP_K = 5;

const metadataKey = (metadata = {}) => `${metadata.source || ""}:${metadata.chunkIndex ?? ""}:${metadata.page ?? ""}:${metadata.row ?? ""}`;

const keywordRetrieve = async (query, { k = DEFAULT_TOP_K } = {}) => {
  const documents = await loadKnowledgeBase();
  const chunks = await chunkDocuments(documents);
  const fuse = new Fuse(chunks, {
    keys: ["text", "metadata.category", "metadata.source"],
    includeScore: true,
    threshold: 0.45,
    ignoreLocation: true,
  });
  const results = fuse.search(query).slice(0, k).map(({ item, score }) => ({
    text: item.text,
    metadata: item.metadata,
    keywordScore: Math.max(0, 1 - (score || 0)),
    sourceType: "keyword",
  }));
  eventBus.emitSafe("retrieval.completed", { type: "keyword", query, hitCount: results.length });
  return results;
};

const mergeResults = (vectorResults = [], keywordResults = []) => {
  const map = new Map();
  [...vectorResults, ...keywordResults].forEach((result) => {
    const key = metadataKey(result.metadata) || result.text.slice(0, 120);
    const existing = map.get(key);
    if (!existing) {
      map.set(key, { ...result });
      return;
    }
    map.set(key, {
      ...existing,
      ...result,
      vectorScore: existing.vectorScore ?? result.vectorScore,
      keywordScore: Math.max(existing.keywordScore || 0, result.keywordScore || 0),
      sourceType: existing.sourceType === result.sourceType ? existing.sourceType : "hybrid",
    });
  });
  return [...map.values()];
};

const hybridRetrieve = async (query, options = {}) => {
  const startedAt = Date.now();
  const {
    k = DEFAULT_TOP_K,
    collectionName,
    metadata = {},
    category,
    medicineScope = null,
  } = options;

  const [vectorResults, keywordResults] = await Promise.all([
    // Phase 5.4: medicine identity flows into the vector retrieve so Chroma's
    // $or filter or the local post-filter can scope results to the active
    // medicine. Keyword retrieval is text-only and does not need the scope.
    retrieve(query, { collectionName, k, metadata, medicineScope }),
    keywordRetrieve(query, { k }),
  ]);

  const normalizedVector = vectorResults.map((result) => ({
    ...result,
    vectorScore: result.score,
    confidence: result.confidence,
    sourceType: "vector",
  }));
  const merged = mergeResults(normalizedVector, keywordResults);
  // Pass medicineScope through to rerank so the medicineMatch weight (5.5)
  // can soft-scope ordering. The merged list is intentionally NOT pre-filtered
  // — over-fetch + reranker handle scoping while preserving recall.
  const ranked = rerank(query, merged, { category, medicineScope }).slice(0, k);

  eventBus.emitSafe("retrieval.completed", {
    type: "hybrid",
    query,
    hitCount: ranked.length,
    latencyMs: Date.now() - startedAt,
    confidence: ranked[0]?.confidence || 0,
  });

  return ranked;
};

module.exports = {
  hybridRetrieve,
  keywordRetrieve,
  mergeResults,
};
