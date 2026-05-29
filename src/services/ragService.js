const fs = require("fs");
const path = require("path");
const { createProvider } = require("../providers");
const { hybridRetrieve } = require("../rag/hybridRetriever");
const { evaluateRetrieval, recordRetrievalMetric } = require("../rag/evaluator");
const { retrieveRelevantMemory } = require("../memory/semanticMemory");

const KNOWLEDGE_ROOT = path.join(__dirname, "..", "..", "knowledge-base");

const listKnowledgeSources = () => {
  if (!fs.existsSync(KNOWLEDGE_ROOT)) return [];
  return fs.readdirSync(KNOWLEDGE_ROOT, { withFileTypes: true }).flatMap((entry) => {
    const categoryPath = path.join(KNOWLEDGE_ROOT, entry.name);
    if (!entry.isDirectory()) return [];
    return fs
      .readdirSync(categoryPath)
      .filter((file) => /\.(md|txt|csv)$/i.test(file))
      .map((file) => ({
        source: path.join(categoryPath, file),
        category: entry.name,
        trust: "curated",
        updatedAt: null,
      }));
  });
};

// Builds the medicine-scoped portion of the metadata filter (Phase 5 of the
// medicine-context-integrity bugfix). Returns `{}` when no usable scope is
// supplied so the no-scope path stays byte-for-byte identical to today.
//
// Why both `medicine` and `generic`: existing knowledge chunks (see
// `src/rag/medicineKnowledgeIngestion.js` and `tests/_mocks/fakeKnowledgeBase.js`)
// tag chunks with both `metadata.medicine` AND `metadata.generic`. Phase 5.3
// will switch the retriever to OR semantics over these keys; for now we ship
// them as fields the retriever can consume.
const medicineScopeFilter = (medicineScope) => {
  if (!medicineScope || typeof medicineScope !== "object") return {};
  const filter = {};
  const name = (medicineScope.medicineName || "").trim();
  const generic = (medicineScope.genericName || "").trim();
  if (name) filter.medicine = name;
  if (generic && generic.toLowerCase() !== name.toLowerCase()) filter.generic = generic;
  return filter;
};

// Preservation contract (P4.a): the canonical keys array literal
// `["source", "category", "trust", "updatedAt"]` MUST appear verbatim, and the
// reduction MUST be byte-for-byte identical to today when `medicineScope` is
// absent. Medicine keys are added ONLY when a scope is supplied.
const knowledgeFilter = (metadata = {}, medicineScope = null) => {
  const baseKeys = ["source", "category", "trust", "updatedAt"];
  const base = baseKeys.reduce((filter, key) => {
    if (metadata[key]) filter[key] = metadata[key];
    return filter;
  }, {});
  const medicine = medicineScopeFilter(medicineScope);
  return { ...base, ...medicine };
};

const LOW_CONFIDENCE_THRESHOLD = Number(process.env.RETRIEVAL_CONFIDENCE_THRESHOLD || 0.4);

const retrieveKnowledge = async ({ question, metadata = {}, medicineScope = null, k = 4 }) => {
  const startedAt = Date.now();
  const context = await hybridRetrieve(question, {
    k,
    metadata: knowledgeFilter(metadata, medicineScope),
    category: metadata.category,
    // Pass-through for Phase 5.4/5.5 — `hybridRetrieve` ignores unknown keys
    // today, keeping this task incremental and reversible.
    medicineScope,
  });
  const metric = evaluateRetrieval(question, context, {
    retrievalType: "hybrid",
    latencyMs: Date.now() - startedAt,
  });
  await recordRetrievalMetric(metric);

  return {
    context,
    sources: context.map((item) => item.metadata),
    confidence: context[0]?.confidence || 0,
    lowConfidence: (context[0]?.confidence || 0) < LOW_CONFIDENCE_THRESHOLD,
  };
};

const answerFromKnowledgeBase = async (query, metadata = {}) => {
  const knowledge = await retrieveKnowledge({ question: query, metadata });
  const memory = metadata.telegramId
    ? await retrieveRelevantMemory({ telegramId: metadata.telegramId, query })
    : { facts: [] };
  const provider = createProvider();
  const generated = await provider.generate({
    prompt: query,
    fallback: knowledge.lowConfidence
      ? "I could not confidently find a trusted knowledge match for this question."
      : "",
    context: knowledge.context,
    memory: memory.facts,
  });

  return {
    answer: generated.text,
    sources: knowledge.sources.length ? knowledge.sources : listKnowledgeSources(),
    memory: memory.facts,
    context: knowledge.context,
    confidence: knowledge.confidence,
    lowConfidence: knowledge.lowConfidence,
    metadata,
    status: "rag-ready",
    query,
  };
};

module.exports = {
  answerFromKnowledgeBase,
  listKnowledgeSources,
  retrieveKnowledge,
  knowledgeFilter,
  medicineScopeFilter,
};
