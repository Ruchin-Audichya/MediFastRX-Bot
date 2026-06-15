"use strict";

// Apollo Pharmacy medicine search — via a Parse (parse.bot) scraper endpoint.
//
// Verified live (see docs/PARSE_MCP_FINDINGS.md): the scraper returns real
// India-market data — brand name, price, MRP, discount, manufacturer,
// availability, pack size, prescription flag, tags.
//
//   POST {endpoint}/search_medicines
//   headers: X-API-Key: <PARSE_API_KEY>
//   body: { query, pincode }
//   → { status, data: { query, total_results, products: [ {name, sku, price,
//        mrp, discount_percentage, manufacturer, availability, pack_size,
//        is_prescription_required, tags[] } ] } }
//
// HARD RULES (hackathon safety):
//   - Feature-flagged: APOLLO_ENABLED!=true → { ok:false, disabled:true }.
//   - Strict timeout; never throws into the caller.
//   - ENRICHMENT ONLY. Deterministic catalog + sanitized LLM remain the source
//     of truth for safety fields. Apollo's prescription flag is surfaced as
//     supporting info, not the sole authority.

const logger = require("../../utils/logger");

const cfg = () => ({
  enabled: String(process.env.APOLLO_ENABLED || "false").toLowerCase() === "true",
  apiKey: process.env.PARSE_API_KEY || "",
  // Full Parse scraper endpoint for search_medicines.
  endpoint:
    process.env.APOLLO_SEARCH_ENDPOINT ||
    "https://api.parse.bot/scraper/8ba876fe-8b97-44f7-a437-41cdaa0708e8/search_medicines",
  defaultPincode: process.env.APOLLO_DEFAULT_PINCODE || "302001", // Jaipur
  timeoutMs: Number(process.env.APOLLO_TIMEOUT_MS || 7000),
});

const isEnabled = () => {
  const c = cfg();
  return Boolean(c.enabled && c.apiKey && c.endpoint);
};

const normalizeProduct = (p = {}) => ({
  medicineName: p.name || p.medicineName || null,
  sku: p.sku || null,
  price: typeof p.price === "number" ? p.price : p.price ? Number(p.price) : null,
  mrp: typeof p.mrp === "number" ? p.mrp : p.mrp ? Number(p.mrp) : null,
  discountPercentage: p.discount_percentage ?? null,
  manufacturer: p.manufacturer || null,
  availability: p.availability || null,
  inStock: typeof p.availability === "string" ? /in.?stock/i.test(p.availability) : null,
  packSize: p.pack_size || p.packSize || null,
  prescriptionRequired: Boolean(p.is_prescription_required),
  tags: Array.isArray(p.tags) ? p.tags.filter(Boolean) : [],
  source: "apollo",
});

// search(query, { pincode }) → { ok, disabled?, results: [...], source }.
// Never throws.
const search = async (query, { pincode } = {}) => {
  if (!isEnabled()) return { ok: false, disabled: true, results: [], source: "apollo" };
  const c = cfg();
  const q = String(query || "").trim();
  if (q.length < 2) return { ok: false, results: [], source: "apollo" };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), c.timeoutMs);
    let res;
    try {
      res = await fetch(c.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "X-API-Key": c.apiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ query: q, pincode: pincode || c.defaultPincode }),
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      logger.warn(`Apollo search failed: HTTP ${res.status}`);
      return { ok: false, results: [], source: "apollo" };
    }
    const json = await res.json();
    const products = json?.data?.products || json?.products || [];
    const results = products.map(normalizeProduct).filter((r) => r.medicineName);
    return {
      ok: true,
      results: results.slice(0, 6),
      total: json?.data?.total_results ?? results.length,
      source: "apollo",
    };
  } catch (error) {
    logger.warn(`Apollo search error: ${error.message}`);
    return { ok: false, results: [], source: "apollo" };
  }
};

const health = () => ({ mode: isEnabled() ? "live" : "disabled", enabled: cfg().enabled });

module.exports = { search, isEnabled, health, normalizeProduct };
