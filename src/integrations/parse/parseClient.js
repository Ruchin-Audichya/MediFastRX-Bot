"use strict";

// Parse (parse.bot) pharmacy-data adapter — FEATURE-FLAGGED OFF.
//
// Investigation verdict (see docs/PARSE_MCP_FINDINGS.md): Parse is a
// scraper-builder, not a pharmacy data source, and has NO Apollo/India pharmacy
// data. We therefore do NOT use it at runtime. This module exists only as a
// pluggable seam so a future, pre-built Parse scraper endpoint (or a direct
// Apollo/1mg partner API) can supply nearby pharmacies WITHOUT touching the
// CareOps operations layer.
//
// When PARSE_ENABLED!=true (default), every method returns a disabled result
// and the existing OSM/Mongo-geo path is used unchanged.

const logger = require("../../utils/logger");

const cfg = () => ({
  enabled: String(process.env.PARSE_ENABLED || "false").toLowerCase() === "true",
  apiKey: process.env.PARSE_API_KEY || "",
  // A PRE-BUILT scraper endpoint, e.g.
  // https://api.parse.bot/scraper/<scraper_id>/<endpoint_name>
  endpoint: process.env.PARSE_PHARMACY_ENDPOINT || "",
  timeoutMs: Number(process.env.PARSE_TIMEOUT_MS || 4000),
});

const isEnabled = () => {
  const c = cfg();
  return Boolean(c.enabled && c.apiKey && c.endpoint);
};

// Returns { ok, disabled?, pharmacies: [...] }. Never throws.
const getNearbyPharmacies = async ({ latitude, longitude, medicine } = {}) => {
  if (!isEnabled()) {
    return { ok: false, disabled: true, pharmacies: [] };
  }
  const c = cfg();
  try {
    const url = new URL(c.endpoint);
    if (latitude != null) url.searchParams.set("latitude", String(latitude));
    if (longitude != null) url.searchParams.set("longitude", String(longitude));
    if (medicine) url.searchParams.set("medicine", String(medicine));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), c.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { "x-api-key": c.apiKey, accept: "application/json" },
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      logger.warn(`Parse pharmacy fetch failed: ${res.status}`);
      return { ok: false, pharmacies: [] };
    }
    const json = await res.json();
    const items = Array.isArray(json) ? json : json.pharmacies || json.items || [];
    // Normalize to the shape pharmacyRecommendationService expects.
    const pharmacies = items.map((p) => ({
      name: p.name || p.storeName || "Pharmacy",
      address: p.address || p.location || null,
      phone: p.phone || p.contact || null,
      source: "parse",
      location:
        p.latitude && p.longitude
          ? { type: "Point", coordinates: [Number(p.longitude), Number(p.latitude)] }
          : undefined,
    }));
    return { ok: true, pharmacies };
  } catch (error) {
    logger.warn(`Parse pharmacy adapter error: ${error.message}`);
    return { ok: false, pharmacies: [] };
  }
};

const health = () => ({ mode: isEnabled() ? "live" : "disabled", enabled: cfg().enabled });

module.exports = { getNearbyPharmacies, isEnabled, health };
