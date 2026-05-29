"use strict";

// Deterministic in-memory knowledge base used by the bug-condition exploration
// test. Each chunk carries `metadata.medicine` / `metadata.generic` so the test
// can assert whether the surfaced evidence actually belongs to the resolved
// medicine. The chunks are intentionally a mixture of medicines so that an
// unscoped retriever (the current bug) returns contamination on a query like
// "side effects".

const CHUNKS = [
  {
    id: "preg-1",
    text: "Pregabalin commonly causes dizziness, drowsiness, weight gain, and dry mouth as side effects.",
    metadata: {
      source: "knowledge-base/medicines/pregabalin.md",
      sourceType: "medicine",
      medicine: "Pregabalin",
      generic: "Pregabalin",
      alias: "Lyrica",
      category: "neuropathic_pain",
      trust: "curated",
    },
  },
  {
    id: "preg-2",
    text: "Pregabalin side effects: sleepiness, blurred vision, peripheral edema. Do not stop abruptly.",
    metadata: {
      source: "knowledge-base/medicines/pregabalin.md",
      sourceType: "medicine",
      medicine: "Pregabalin",
      generic: "Pregabalin",
      alias: "Lyrica",
      category: "neuropathic_pain",
      trust: "curated",
    },
  },
  {
    id: "gaba-1",
    text: "Gabapentin side effects include dizziness, fatigue, and ataxia. Mechanism overlaps with Pregabalin.",
    metadata: {
      source: "knowledge-base/medicines/gabapentin.md",
      sourceType: "medicine",
      medicine: "Gabapentin",
      generic: "Gabapentin",
      category: "neuropathic_pain",
      trust: "curated",
    },
  },
  {
    id: "alpr-1",
    text: "Alprazolam side effects include sedation, drowsiness, and memory impairment.",
    metadata: {
      source: "knowledge-base/medicines/alprazolam.md",
      sourceType: "medicine",
      medicine: "Alprazolam",
      generic: "Alprazolam",
      category: "anxiolytic",
      trust: "curated",
    },
  },
  {
    id: "dolo-1",
    text: "Dolo650 (Paracetamol) side effects are minimal at recommended doses; rare liver toxicity at overdose.",
    metadata: {
      source: "knowledge-base/medicines/dolo650.md",
      sourceType: "medicine",
      medicine: "Dolo650",
      generic: "Paracetamol",
      category: "analgesic",
      trust: "curated",
    },
  },
  {
    id: "neutral-1",
    text: "Always discuss potential side effects with a qualified physician before starting any new medicine.",
    metadata: {
      source: "knowledge-base/guidelines/general.md",
      sourceType: "guideline",
      medicine: null,
      generic: null,
      category: "guideline",
      trust: "curated",
    },
  },
];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "for",
  "from",
  "is",
  "of",
  "the",
  "to",
  "side",
]);

const tokenize = (text = "") =>
  String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !STOPWORDS.has(token));

const overlap = (a = [], b = []) => {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  const matches = a.filter((token) => setB.has(token)).length;
  return matches / a.length;
};

// Mimics the buggy `retrieveKnowledge` shape: returns top-K chunks scored only
// by raw question overlap, with NO medicine-scoped filter applied. This is the
// exact behavior of `src/orchestrator/toolExecutor.js` today, which calls
// `retrieveKnowledge({ question: plan.query })` without medicine metadata.
const fakeRetrieveKnowledge = async ({ question, metadata = {}, k = 5 } = {}) => {
  const queryTokens = tokenize(question);
  // Deterministic ordering: score, then chunk id (stable tiebreaker).
  const scored = CHUNKS.map((chunk) => {
    const textTokens = tokenize(chunk.text);
    // A small bias for "side effects" so the bug query reliably surfaces
    // multiple medicines in the top-K.
    const sideEffectsBoost = /side\s*effects?/i.test(question) && /side\s*effects?/i.test(chunk.text) ? 0.4 : 0;
    const baseScore = overlap(queryTokens, textTokens);
    return {
      ...chunk,
      _score: baseScore + sideEffectsBoost,
    };
  })
    .filter((chunk) => chunk._score > 0)
    .sort((a, b) => b._score - a._score || a.id.localeCompare(b.id))
    .slice(0, k);

  // Optional metadata equality filter (matches today's `where` semantics for
  // `source/category/trust/updatedAt` only). The bug is that the medicine
  // metadata is NOT in the filter, so a "side effects" query returns mixed
  // medicines.
  const metaKeys = ["source", "category", "trust", "updatedAt"];
  const filtered = scored.filter((chunk) => {
    return metaKeys.every((key) => {
      if (metadata[key] == null) return true;
      return chunk.metadata[key] === metadata[key];
    });
  });

  const context = filtered.map((chunk) => ({
    text: chunk.text,
    metadata: chunk.metadata,
    score: chunk._score,
    confidence: Math.min(1, chunk._score),
    sourceType: chunk.metadata.sourceType,
  }));

  return {
    context,
    sources: context.map((item) => item.metadata),
    confidence: context[0]?.confidence || 0,
    lowConfidence: (context[0]?.confidence || 0) < 0.4,
  };
};

// Deterministic stand-in for `searchMedicineKnowledge`. Returns a high-confidence
// resolution for queries that look like Pregabalin / Dolo650 / Telmisartan; an
// unknown result otherwise. The exploration test only relies on Pregabalin.
const KNOWN = {
  pregabalin: {
    medicine: {
      _id: "med-pregabalin",
      medicineName: "Pregabalin",
      genericName: "Pregabalin",
      aliases: ["Lyrica"],
      salts: ["Pregabalin"],
      brands: ["Lyrica"],
      category: "neuropathic_pain",
      sideEffects: ["dizziness", "drowsiness", "weight gain"],
      symptoms: ["nerve pain"],
      prescriptionRequired: true,
    },
    confidence: 0.92,
    relationships: [
      { type: "same_class", from: "Pregabalin", to: "Gabapentin", confidence: 0.6 },
    ],
  },
  dolo650: {
    medicine: {
      _id: "med-dolo650",
      medicineName: "Dolo650",
      genericName: "Paracetamol",
      aliases: ["Calpol", "Crocin"],
      salts: ["Paracetamol"],
      brands: ["Dolo650"],
      category: "analgesic",
      sideEffects: ["nausea (rare)"],
      symptoms: ["fever", "pain"],
      prescriptionRequired: false,
    },
    confidence: 0.95,
    relationships: [],
  },
  telmisartan: {
    medicine: {
      _id: "med-telmisartan",
      medicineName: "Telmisartan",
      genericName: "Telmisartan",
      aliases: ["Telma"],
      salts: ["Telmisartan"],
      brands: ["Telma"],
      category: "antihypertensive",
      sideEffects: ["dizziness"],
      symptoms: ["high blood pressure"],
      prescriptionRequired: true,
    },
    confidence: 0.9,
    relationships: [],
  },
};

const fakeSearchMedicineKnowledge = async ({ query }) => {
  const key = String(query || "").toLowerCase().trim();
  const hit = Object.entries(KNOWN).find(([slug]) => key.includes(slug));
  if (!hit) {
    return {
      medicine: null,
      alternatives: [],
      relationships: [],
      confidence: 0,
      suggestions: [],
      message: "I could not confidently identify this medicine.",
    };
  }
  const [, payload] = hit;
  return {
    medicine: payload.medicine,
    alternatives: [],
    relationships: payload.relationships,
    confidence: payload.confidence,
    suggestions: [],
    message: null,
  };
};

module.exports = {
  CHUNKS,
  fakeRetrieveKnowledge,
  fakeSearchMedicineKnowledge,
};
