const crypto = require("crypto");
const { ChromaClient } = require("chromadb");
const { createEmbeddings } = require("./embeddings");
const { DEFAULT_STORAGE_PATH, getLocalCollection } = require("./localVectorStore");
const eventBus = require("../events/eventBus");
const logger = require("../utils/logger");

const DEFAULT_COLLECTION = process.env.CHROMA_KNOWLEDGE_COLLECTION || "medifast_knowledge";
const DEFAULT_MEMORY_COLLECTION = process.env.CHROMA_MEMORY_COLLECTION || "medifast_memory";
const DEFAULT_LOCAL_PATH = process.env.CHROMA_LOCAL_PATH || DEFAULT_STORAGE_PATH;

const getVectorMode = () => {
  if (process.env.VECTOR_MODE === "local") return "local";
  if (process.env.CHROMA_URL) return "remote";
  return "local";
};

const getVectorStoragePath = () => (getVectorMode() === "local" ? DEFAULT_LOCAL_PATH : null);

const createChromaClient = () =>
  (() => {
    const url = new URL(process.env.CHROMA_URL || "http://localhost:8000");
    return new ChromaClient({
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      ssl: url.protocol === "https:",
    });
  })();

const getCollection = async (name = DEFAULT_COLLECTION) => {
  if (getVectorMode() === "local") {
    return getLocalCollection({ name, storagePath: getVectorStoragePath() });
  }
  const client = createChromaClient();
  return client.getOrCreateCollection({ name });
};

const stableId = (prefix, value) =>
  `${prefix}_${crypto.createHash("sha1").update(String(value)).digest("hex")}`;

const distanceToConfidence = (distance) => {
  if (typeof distance !== "number") return 0.5;
  return Math.max(0, Math.min(1, 1 - distance));
};

// Phase 5.3: medicine-aware retrieval helpers. These are env-tunable so the
// over-fetch behavior can be dialed in without code changes; defaults match
// the design (`k * 3`, capped at 30).
const RETRIEVAL_OVERFETCH_MULTIPLIER = Number(process.env.RETRIEVAL_OVERFETCH_MULTIPLIER || 3);
const RETRIEVAL_OVERFETCH_CAP = Number(process.env.RETRIEVAL_OVERFETCH_CAP || 30);

const lowerTrim = (v) => {
  if (v === null || v === undefined) return "";
  return String(v).trim().toLowerCase();
};

// Build a Chroma `where` $or clause from a medicineScope plus the existing
// equality filters. Returns the merged where (or undefined when both are
// empty). Medicine-scoped fields on `metadata` are stripped — they belong in
// the $or, not as equality filters, otherwise Chroma would AND them.
const buildWhereClause = (metadata = {}, medicineScope = null) => {
  const baseEntries = Object.entries(metadata || {}).filter(
    ([key]) => !["medicine", "generic", "alias"].includes(key)
  );
  const baseFilter = Object.fromEntries(baseEntries);

  if (!medicineScope || typeof medicineScope !== "object") {
    return Object.keys(baseFilter).length ? baseFilter : undefined;
  }

  const orClauses = [];
  if (medicineScope.medicineName) orClauses.push({ medicine: medicineScope.medicineName });
  if (
    medicineScope.genericName &&
    lowerTrim(medicineScope.genericName) !== lowerTrim(medicineScope.medicineName)
  ) {
    orClauses.push({ generic: medicineScope.genericName });
  }
  for (const alias of medicineScope.aliases || []) {
    if (alias) orClauses.push({ alias });
  }

  if (orClauses.length === 0) {
    return Object.keys(baseFilter).length ? baseFilter : undefined;
  }

  // Chroma supports $and at the top level when combining a base equality
  // filter with an $or clause. When there is no base filter, the $or stands
  // alone (or collapses to a single equality clause when only one is present).
  const orPart = orClauses.length === 1 ? orClauses[0] : { $or: orClauses };
  if (Object.keys(baseFilter).length === 0) return orPart;
  return { $and: [baseFilter, orPart] };
};

// Build a Set of lowercased identity tokens for post-filtering on the local
// vector store. Returns null when the scope yields no tokens (no filtering).
const buildIdentityTokens = (medicineScope) => {
  if (!medicineScope || typeof medicineScope !== "object") return null;
  const tokens = new Set();
  const add = (v) => {
    const s = lowerTrim(v);
    if (s) tokens.add(s);
  };
  add(medicineScope.medicineName);
  add(medicineScope.genericName);
  (medicineScope.aliases || []).forEach(add);
  (medicineScope.salts || []).forEach(add);
  return tokens.size ? tokens : null;
};

// Match a chunk's metadata.medicine/generic/alias against the scope tokens.
// Neutral chunks (no medicine identity on metadata) pass through — same
// contract as `belongsToActiveMedicine` in MedicineContext (Property 4).
const matchesIdentity = (metadata, tokens) => {
  if (!tokens) return true;
  const cand = ["medicine", "generic", "alias"]
    .map((k) => lowerTrim(metadata?.[k]))
    .filter(Boolean);
  if (cand.length === 0) return true;
  return cand.some((c) => tokens.has(c));
};

const upsertChunks = async (chunks, { collectionName = DEFAULT_COLLECTION } = {}) => {
  if (!chunks.length) return { count: 0, collectionName };

  const embeddings = createEmbeddings();
  const collection = await getCollection(collectionName);
  const vectors = await embeddings.embedDocuments(chunks.map((chunk) => chunk.text));
  const ids = chunks.map((chunk) => stableId("chunk", chunk.id));

  await collection.upsert({
    ids,
    documents: chunks.map((chunk) => chunk.text),
    embeddings: vectors,
    metadatas: chunks.map((chunk) => chunk.metadata),
  });

  return { count: chunks.length, collectionName, vectorMode: getVectorMode(), storagePath: getVectorStoragePath() };
};

const retrieve = async (query, { collectionName = DEFAULT_COLLECTION, k = 4, metadata = {}, medicineScope = null } = {}) => {
  try {
    const embeddings = createEmbeddings();
    const collection = await getCollection(collectionName);
    const queryEmbedding = await embeddings.embedQuery(query);

    const mode = getVectorMode();
    // Local store can't express $or, so we over-fetch and post-filter to keep
    // recall while honoring the scope. Remote (Chroma) handles the OR clause
    // server-side via `where`, so no over-fetch is needed.
    const overfetchK = medicineScope && mode === "local"
      ? Math.min(Math.max(k, 1) * RETRIEVAL_OVERFETCH_MULTIPLIER, RETRIEVAL_OVERFETCH_CAP)
      : k;

    const where = mode === "remote"
      ? buildWhereClause(metadata, medicineScope)
      : (Object.keys(metadata || {}).length
          // Local store: drop medicine-scoped fields from metadata so Chroma-style
          // `$or` semantics aren't faked into AND-equality the local store can't
          // satisfy. Identity is enforced via post-filter below.
          ? Object.fromEntries(
              Object.entries(metadata).filter(
                ([key]) => !["medicine", "generic", "alias"].includes(key)
              )
            )
          : undefined);

    const response = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: overfetchK,
      where,
    });

    const documents = response.documents?.[0] || [];
    const metadatas = response.metadatas?.[0] || [];
    const distances = response.distances?.[0] || [];
    let results = documents.map((text, index) => ({
      text,
      metadata: metadatas[index] || {},
      score: distances[index],
      confidence: distanceToConfidence(distances[index]),
    }));

    // Local-store post-filter: Chroma already filtered server-side via $or.
    if (mode === "local" && medicineScope) {
      const tokens = buildIdentityTokens(medicineScope);
      if (tokens) {
        results = results.filter((r) => matchesIdentity(r.metadata, tokens));
      }
    }

    if (results.length > k) results = results.slice(0, k);

    eventBus.emitSafe("retrieval.completed", {
      type: collectionName === DEFAULT_MEMORY_COLLECTION ? "memory" : "knowledge",
      query,
      hitCount: results.length,
      scoped: Boolean(medicineScope),
    });

    return results;
  } catch (error) {
    logger.warn(`Vector retrieval unavailable: ${error.message}`);
    eventBus.emitSafe("retrieval.completed", {
      type: collectionName === DEFAULT_MEMORY_COLLECTION ? "memory" : "knowledge",
      query,
      hitCount: 0,
      error: error.message,
    });
    return [];
  }
};

module.exports = {
  DEFAULT_COLLECTION,
  DEFAULT_MEMORY_COLLECTION,
  DEFAULT_LOCAL_PATH,
  buildIdentityTokens,
  buildWhereClause,
  distanceToConfidence,
  getCollection,
  getVectorMode,
  getVectorStoragePath,
  matchesIdentity,
  retrieve,
  stableId,
  upsertChunks,
};
