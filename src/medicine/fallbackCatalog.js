"use strict";

// In-memory curated fallback catalog. Loaded lazily from the committed
// data/medicine-sources/*.json files. Used ONLY when MongoDB is unreachable
// so the bot never hard-fails on a medicine lookup during a demo or outage.
//
// This is a resilience layer, not the source of truth — Mongo remains primary.
// The fallback matches on medicineName / generic / brands / aliases /
// commonSpellings with a simple normalized-substring + token strategy.

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger");

const SOURCES_DIR = path.join(__dirname, "..", "..", "data", "medicine-sources");

let CACHE = null;

const normalize = (v = "") =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const loadCatalog = () => {
  if (CACHE) return CACHE;
  const records = [];
  try {
    const files = fs.existsSync(SOURCES_DIR)
      ? fs.readdirSync(SOURCES_DIR).filter((f) => f.endsWith(".json"))
      : [];
    for (const file of files) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(SOURCES_DIR, file), "utf8"));
        const arr = Array.isArray(raw) ? raw : raw.records || raw.medicines || [];
        for (const r of arr) {
          if (r && r.medicineName) records.push(r);
        }
      } catch (e) {
        logger.warn(`Fallback catalog: skipped ${file}: ${e.message}`);
      }
    }
  } catch (e) {
    logger.warn(`Fallback catalog load failed: ${e.message}`);
  }
  // Pre-compute a normalized token blob per record for fast matching.
  CACHE = records.map((r) => {
    const tokens = new Set();
    const add = (v) => {
      const n = normalize(v);
      if (n) {
        tokens.add(n);
        n.split(" ").forEach((t) => t && tokens.add(t));
      }
    };
    add(r.medicineName);
    add(r.genericName);
    (r.salts || []).forEach(add);
    (r.brands || []).forEach(add);
    (r.aliases || []).forEach(add);
    (r.commonSpellings || []).forEach(add);
    (r.symptoms || []).forEach(add);
    return { record: r, tokens };
  });
  logger.info(`Fallback catalog ready: ${CACHE.length} curated records.`);
  return CACHE;
};

// Returns a single best-match medicine record (catalog shape) or null.
const findFallbackMedicine = (query) => {
  const q = normalize(query);
  if (!q || q.length < 2) return null;
  const catalog = loadCatalog();
  if (!catalog.length) return null;

  const qTokens = q.split(" ").filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const entry of catalog) {
    let score = 0;
    // Exact-ish: whole query is a known token.
    if (entry.tokens.has(q)) score += 5;
    // Token overlap.
    for (const t of qTokens) {
      if (entry.tokens.has(t)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = entry.record;
    }
  }
  if (!best || bestScore === 0) return null;
  return best;
};

// Shape a fallback record like searchMedicineKnowledge().medicine output so
// downstream code is unchanged.
const toKnowledgeShape = (record) => {
  if (!record) return null;
  return {
    medicine: {
      _id: null,
      medicineName: record.medicineName,
      genericName: record.genericName || record.salts?.[0] || record.medicineName,
      salts: record.salts || [],
      brands: record.brands || [],
      aliases: record.aliases || [],
      category: record.category || "other",
      symptoms: record.symptoms || [],
      sideEffects: (record.sideEffects || []).map((s) =>
        typeof s === "string" ? { effect: s } : s
      ),
      precautions: record.precautions || [],
      prescriptionRequired: Boolean(record.prescriptionRequired),
      confidence: record.confidence || 0.8,
    },
    alternatives: [],
    relationships: [],
    confidence: record.confidence || 0.8,
    suggestions: [],
    message: null,
    source: "fallback-catalog",
  };
};

module.exports = { findFallbackMedicine, toKnowledgeShape, loadCatalog, _normalize: normalize };
