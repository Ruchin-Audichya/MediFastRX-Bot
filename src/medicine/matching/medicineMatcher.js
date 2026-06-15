const fs = require("fs");
const path = require("path");
const Fuse = require("fuse.js");
const { createEmbeddingProvider } = require("../../rag/embeddingProvider");
const {
  diceSimilarity,
  normalizeIdentity,
  tokenOverlap,
  weightedConfidence,
} = require("./confidenceScorer");
const { phoneticKey, editSimilarity, levenshtein } = require("./phonetics");

const SYNONYM_PATH = path.join(__dirname, "..", "..", "..", "data", "medicineSynonyms.json");

let synonymsCache = null;

const loadMedicineSynonyms = () => {
  if (synonymsCache) return synonymsCache;
  if (!fs.existsSync(SYNONYM_PATH)) {
    synonymsCache = new Map();
    return synonymsCache;
  }

  const raw = JSON.parse(fs.readFileSync(SYNONYM_PATH, "utf8"));
  synonymsCache = new Map(
    Object.entries(raw).map(([alias, canonical]) => [
      normalizeIdentity(alias),
      normalizeIdentity(canonical),
    ])
  );
  return synonymsCache;
};

const compactIdentity = (value = "") => normalizeIdentity(value).replace(/\s+/g, "");
const uniqueTerms = (terms = []) =>
  Array.from(
    new Set(
      terms
        .flatMap((term) => {
          const normalized = normalizeIdentity(term);
          const compact = compactIdentity(term);
          return compact && compact !== normalized ? [normalized, compact] : [normalized];
        })
        .filter(Boolean)
    )
  );

const tokensFor = (value = "") =>
  normalizeIdentity(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);

const fieldTerms = (medicine = {}) => ({
  genericName: uniqueTerms([medicine.genericName]),
  salts: uniqueTerms(medicine.salts || []),
  brands: uniqueTerms([medicine.medicineName, ...(medicine.brands || [])]),
  aliases: uniqueTerms(medicine.aliases || []),
  commonSpellings: uniqueTerms(medicine.commonSpellings || []),
});

const addToIndex = (map, key, medicine) => {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(medicine);
};

const addSearchTermToCandidateIndexes = ({ tokenIndex, prefixIndex, phoneticIndex, term, medicine }) => {
  tokensFor(term).forEach((token) => {
    addToIndex(tokenIndex, token, medicine);
    addToIndex(prefixIndex, token.slice(0, 4), medicine);
    // Phonetic bucket so sound-alikes / first-letter typos still generate
    // candidates (e.g. "krocin"→"crocin", "fenytoin"→"phenytoin").
    if (phoneticIndex) {
      const pk = phoneticKey(token);
      if (pk) addToIndex(phoneticIndex, pk, medicine);
    }
  });
};

const medicineSearchText = (medicine = {}) =>
  uniqueTerms([
    medicine.medicineName,
    medicine.genericName,
    ...(medicine.salts || []),
    ...(medicine.brands || []),
    ...(medicine.aliases || []),
    ...(medicine.commonSpellings || []),
  ]).join(" ");

const buildMedicineMatcherIndex = (medicines = []) => {
  const fields = {
    genericName: new Map(),
    salts: new Map(),
    brands: new Map(),
    aliases: new Map(),
    commonSpellings: new Map(),
  };

  medicines.forEach((medicine) => {
    const terms = fieldTerms(medicine);
    Object.entries(terms).forEach(([field, values]) => {
      values.forEach((value) => addToIndex(fields[field], value, medicine));
    });
  });

  const searchable = medicines.map((medicine) => ({
    ...medicine,
    _matcherSearchText: medicineSearchText(medicine),
  }));
  const tokenIndex = new Map();
  const prefixIndex = new Map();
  const phoneticIndex = new Map();
  searchable.forEach((medicine) => {
    addSearchTermToCandidateIndexes({
      tokenIndex,
      prefixIndex,
      phoneticIndex,
      term: medicine._matcherSearchText,
      medicine,
    });
  });

  return {
    fields,
    medicines: searchable,
    tokenIndex,
    prefixIndex,
    phoneticIndex,
  };
};

const candidateTermsForRecord = (record = {}) => ({
  genericName: uniqueTerms([record.genericName]),
  medicineName: uniqueTerms([record.medicineName]),
  brands: uniqueTerms(record.brands || []),
});

const rawQueryForRecord = (record = {}) =>
  [record.genericName, record.medicineName, ...(record.brands || [])]
    .map(normalizeIdentity)
    .filter(Boolean)
    .join(" ");

const expandWithSynonyms = (terms = [], synonyms = loadMedicineSynonyms()) => {
  const expanded = new Set(terms);
  terms.forEach((term) => {
    const canonical = synonyms.get(term);
    if (canonical) expanded.add(canonical);
  });
  return Array.from(expanded);
};

const pushMatches = ({ output, medicines, method, query, confidence }) => {
  medicines.forEach((medicine) => {
    const key = String(medicine._id || medicine.knowledgeKey || medicine.medicineName);
    const previous = output.get(key);
    const candidate = {
      medicine,
      confidence,
      method,
      query,
      reason: `${method} match`,
    };
    if (!previous || candidate.confidence > previous.confidence) output.set(key, candidate);
  });
};

const exactPriorityMatch = (record, index, synonyms = loadMedicineSynonyms()) => {
  const terms = candidateTermsForRecord(record);
  const matches = new Map();

  const priority = [
    { input: terms.genericName, field: "genericName", method: "genericName" },
    { input: terms.genericName, field: "salts", method: "salts" },
    { input: terms.medicineName, field: "brands", method: "brands" },
    { input: terms.brands, field: "brands", method: "brands" },
    { input: [...terms.genericName, ...terms.medicineName, ...terms.brands], field: "aliases", method: "aliases" },
    { input: [...terms.genericName, ...terms.medicineName, ...terms.brands], field: "commonSpellings", method: "commonSpellings" },
  ];

  for (const step of priority) {
    const searchTerms = expandWithSynonyms(step.input, synonyms);
    searchTerms.forEach((term) => {
      pushMatches({
        output: matches,
        medicines: index.fields[step.field].get(term) || [],
        method: step.method,
        query: term,
        confidence: weightedConfidence({ method: step.method }),
      });
    });
    if (matches.size) break;
  }

  if (!matches.size) {
    const allTerms = [...terms.genericName, ...terms.medicineName, ...terms.brands];
    expandWithSynonyms(allTerms, synonyms)
      .filter((term) => !allTerms.includes(term))
      .forEach((term) => {
        ["genericName", "salts", "brands", "aliases", "commonSpellings"].forEach((field) => {
          pushMatches({
            output: matches,
            medicines: index.fields[field].get(term) || [],
            method: "synonym",
            query: term,
            confidence: weightedConfidence({ method: "synonym" }),
          });
        });
      });
  }

  return matches;
};

const fuzzyMatch = (record, index, { candidateLimit = Number(process.env.MEDICINE_MATCHER_FUZZY_CANDIDATE_LIMIT || 500) } = {}) => {
  const query = rawQueryForRecord(record);
  if (!query) return new Map();

  const candidateMap = new Map();
  const addCandidate = (medicine) => {
    candidateMap.set(String(medicine._id || medicine.knowledgeKey || medicine.medicineName), medicine);
  };
  tokensFor(query).forEach((token) => {
    // 1) exact token + 4-char prefix (original recall path)
    (index.tokenIndex.get(token) || []).forEach(addCandidate);
    (index.prefixIndex.get(token.slice(0, 4)) || []).forEach(addCandidate);
    // 2) shorter 3-char prefix so a typo after char 3 still finds candidates
    if (index.prefixIndex.get(token.slice(0, 3))) {
      // prefixIndex is keyed on 4-char; fall back to scanning is too costly, so
      // we rely on the phonetic bucket below for first-letter typos.
    }
    // 3) phonetic bucket — sound-alikes and first-letter typos (the big win)
    if (index.phoneticIndex) {
      const pk = phoneticKey(token);
      (index.phoneticIndex.get(pk) || []).forEach(addCandidate);
    }
  });

  const candidates = Array.from(candidateMap.values()).slice(0, candidateLimit);
  if (!candidates.length) return new Map();

  // Score EVERY generated candidate directly with a blend of Fuse similarity,
  // token overlap, dice, and edit-distance. We do NOT gate on Fuse alone —
  // Fuse's threshold rejects first-character typos ("krocin" vs "crocin"),
  // but the phonetic index already vouched for these candidates, so we let
  // edit-distance / dice carry them.
  const fuse = new Fuse(candidates, {
    keys: ["_matcherSearchText"],
    includeScore: true,
    threshold: 0.6,
    ignoreLocation: true,
    minMatchCharLength: 3,
  });
  const fuseScoreById = new Map();
  fuse.search(query, { limit: 20 }).forEach((r) => {
    fuseScoreById.set(
      String(r.item._id || r.item.knowledgeKey || r.item.medicineName),
      1 - (r.score || 0)
    );
  });

  const matches = new Map();
  for (const item of candidates) {
    const id = String(item._id || item.knowledgeKey || item.medicineName);
    const fuseSim = fuseScoreById.get(id) || 0;
    const overlap = Math.max(
      tokenOverlap(query, item._matcherSearchText),
      diceSimilarity(query, item._matcherSearchText) * 0.5
    );
    const edit = bestEditSimilarity(query, item);
    const qTokens = normalizeIdentity(query).split(" ").filter(Boolean);
    const distinctQ = Array.from(new Set(qTokens));
    const shortSingle = distinctQ.length === 1 && distinctQ[0].length <= 6;
    // Strongest single signal wins — a close typo (edit) or a phonetic/Fuse
    // hit can each clear the bar on its own. For a SHORT single-token query we
    // trust ONLY the edit-distance signal; bigram/dice/Fuse substring overlap
    // alone must not confidently match a short query to a *different* drug
    // ("DemoXL"→"Demo LC", "Pan D"→"Pan 40"). Those stay as suggestions.
    const blended = shortSingle
      ? edit
      : Math.max(fuseSim, edit, diceSimilarity(query, item._matcherSearchText));
    // Short single-token query with only a weak edit match → not a confident
    // match. Skip so it falls through to *suggestions* (handled upstream),
    // never a wrong confident medicine ("DemoXL" must not resolve to "Demo LC").
    if (shortSingle && edit < 0.7) continue;
    const cappedOverlap = shortSingle ? 0 : overlap;
    const confidence = weightedConfidence({ method: "fuzzy", similarity: blended, overlap: cappedOverlap });
    if (confidence < 0.5) continue;
    pushMatches({
      output: matches,
      medicines: [item],
      method: "fuzzy",
      query,
      confidence,
    });
  }
  return matches;
};

// Best edit-distance similarity of the query against the record's key identity
// terms (medicineName/generic/salts/brands/aliases/spellings). Token-aware so a
// multi-word query compares its strongest token.
const bestEditSimilarity = (query, medicine) => {
  const qTokens = normalizeIdentity(query).split(" ").filter((t) => t.length >= 3);
  if (!qTokens.length) return 0;
  const terms = uniqueTerms([
    medicine.medicineName,
    medicine.genericName,
    ...(medicine.salts || []),
    ...(medicine.brands || []),
    ...(medicine.aliases || []),
    ...(medicine.commonSpellings || []),
  ]);
  let best = 0;
  for (const qt of qTokens) {
    for (const term of terms) {
      const tw = term.split(" ")[0];
      const sim = editSimilarity(qt, tw);
      // Length-aware guard: for short tokens (≤6 chars) a single edit is a big
      // semantic difference (e.g. "Pan 40" vs "Pan D", "DemoXL" vs "Demo LC").
      // Require the raw edit distance to be ≤1 for short tokens before trusting
      // a high ratio — otherwise discount it so the result stays a *suggestion*
      // rather than a confident (and possibly wrong) medicine match.
      const shorter = Math.min(qt.length, tw.length);
      let effective = sim;
      if (shorter <= 6) {
        const dist = levenshtein(
          qt.toLowerCase().replace(/[^a-z0-9]/g, ""),
          tw.toLowerCase().replace(/[^a-z0-9]/g, "")
        );
        if (dist > 1) effective = Math.min(sim, 0.3); // weak short typo → suggestion only
      }
      if (effective > best) best = effective;
      if (best >= 0.95) return best;
    }
  }
  return best;
};

const cosineSimilarity = (left = [], right = []) => {
  if (!left.length || !right.length || left.length !== right.length) return 0;
  let dot = 0;
  let leftMag = 0;
  let rightMag = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMag += left[index] ** 2;
    rightMag += right[index] ** 2;
  }
  if (!leftMag || !rightMag) return 0;
  return dot / (Math.sqrt(leftMag) * Math.sqrt(rightMag));
};

const semanticMatch = async (record, index, { limit = 8, embeddingProvider = createEmbeddingProvider() } = {}) => {
  const query = rawQueryForRecord(record);
  if (!query || !index.medicines.length) return new Map();

  const queryVector = await embeddingProvider.embedQuery(query);
  const candidates = [];
  const pool = fuzzyMatch(record, index, { candidateLimit: limit * 10 });
  const medicines = pool.size ? Array.from(pool.values()).map((item) => item.medicine) : index.medicines.slice(0, limit);

  for (const medicine of medicines.slice(0, limit)) {
    const text = medicine._matcherSearchText || medicineSearchText(medicine);
    const vector = await embeddingProvider.embedQuery(text);
    const similarity = cosineSimilarity(queryVector, vector);
    candidates.push({
      medicine,
      confidence: weightedConfidence({ method: "semantic", similarity }),
      similarity,
    });
  }

  const matches = new Map();
  candidates
    .filter((candidate) => candidate.confidence >= 0.5)
    .sort((a, b) => b.confidence - a.confidence)
    .forEach((candidate) => {
      pushMatches({
        output: matches,
        medicines: [candidate.medicine],
        method: "semantic",
        query,
        confidence: candidate.confidence,
      });
    });

  return matches;
};

const mergeMatchMaps = (...maps) => {
  const merged = new Map();
  maps.forEach((map) => {
    map.forEach((match, key) => {
      const previous = merged.get(key);
      if (!previous || match.confidence > previous.confidence) merged.set(key, match);
    });
  });
  return merged;
};

const matchMedicine = async (record = {}, index, options = {}) => {
  const exact = exactPriorityMatch(record, index);
  let merged = exact;
  let usedSemantic = false;

  if (!merged.size && options.useFuzzy !== false) {
    merged = fuzzyMatch(record, index, options);
  }

  if ((!merged.size || Math.max(...Array.from(merged.values()).map((item) => item.confidence)) < 0.8) && options.useSemantic) {
    try {
      const semantic = await semanticMatch(record, index, options);
      usedSemantic = semantic.size > 0;
      merged = mergeMatchMaps(merged, semantic);
    } catch {
      // Semantic matching is optional; deterministic matching remains the fallback.
    }
  }

  const matches = Array.from(merged.values()).sort((a, b) => b.confidence - a.confidence);
  const bestConfidence = matches[0]?.confidence || 0;
  return {
    confidence: bestConfidence,
    reason: matches[0]?.reason || "no medicine match",
    method: matches[0]?.method || "none",
    usedSemantic,
    medicines: matches.map((match) => match.medicine),
    matches,
  };
};

module.exports = {
  buildMedicineMatcherIndex,
  candidateTermsForRecord,
  compactIdentity,
  cosineSimilarity,
  exactPriorityMatch,
  expandWithSynonyms,
  fuzzyMatch,
  loadMedicineSynonyms,
  matchMedicine,
  semanticMatch,
  uniqueTerms,
};
