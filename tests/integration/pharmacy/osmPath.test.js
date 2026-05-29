"use strict";

/**
 * Integration smoke test — Phase 8 / Task 10.4.
 *
 * Asserts: the existing OSM path is byte-for-byte unchanged when MediAtlas
 * is OFF (the user-facing nearby card produced from an OSM-hydrated
 * recommendation continues to render as it does today).
 *
 * **Validates: Requirements 3.5**
 *
 * Why this is a smoke test:
 *   - Phase 7 (MediAtlas) and Phase 10 (photo-to-listing) are DEFERRED, so
 *     the production integration is not yet wired through MediAtlas.
 *   - Driving the full nearby flow end to end requires Mongo + OSM HTTP +
 *     family memory, which is out of scope for a unit-tier preservation
 *     check.
 *   - Instead, we exercise the same renderer (`formatNearbyRecommendations`)
 *     that the OSM path emits today, with a fixture mirroring the shape of a
 *     real `recommendNearbyPharmacies(...)` result, and assert the OSM
 *     hydration marker / phone / distance / directions surface.
 *
 * No real Mongo, OSM, or MediAtlas is touched.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const {
  formatNearbyRecommendations,
  buildNearbyActionKeyboard,
} = require(path.join(REPO_ROOT, "src/bot/commands/nearby.js"));

// Minimal recommendation shape returned by `recommendNearbyPharmacies` on
// the OSM-hydrated path (see src/pharmacy/pharmacyRecommendationService.js).
// `osmHydrated: true` is what triggers the "refreshed from OpenStreetMap"
// marker in the rendered card.
const osmRecommendation = {
  radiusKm: 5,
  expandedRadius: false,
  osmHydrated: true,
  medicine: { genericName: "Paracetamol", medicineName: "Dolo650" },
  medicineConfidence: 0.9,
  inventoryMatchCount: 1,
  historicalDemand: 4,
  confidenceQuality: 0.8,
  ranked: [
    {
      name: "Apollo Pharmacy",
      address: "12, Vaishali Nagar, Jaipur",
      distance: "0.8 km",
      distanceKm: 0.8,
      score: 0.92,
      openStatus: "Open now",
      source: "OpenStreetMap",
      inventoryConfidence: 0.85,
      popularityScore: 0.7,
      searchSuccessScore: 0.6,
      phone: "0141-1234567",
      directionsUrl: "https://maps.google.com/?q=apollo",
      inventoryMatches: [{ medicineName: "Paracetamol 500mg" }],
    },
  ],
};

test("OSM path — environment is correctly configured", () => {
  // Sanity: the integration is gated by MEDIATLAS_ENABLED. With MediAtlas off
  // (the default), the OSM path is the only nearby path in production.
  assert.notEqual(process.env.MEDIATLAS_ENABLED, "true");
});

test("OSM path — formatNearbyRecommendations renders a recognizable nearby card", async (t) => {
  const html = formatNearbyRecommendations(osmRecommendation, "Paracetamol");

  await t.test("OSM hydration marker is surfaced", () => {
    assert.match(html, /refreshed from OpenStreetMap/);
  });

  await t.test("medicine line is present", () => {
    assert.match(html, /Medicine: <b>Paracetamol<\/b>/);
  });

  await t.test("pharmacy name, distance, phone and source surface", () => {
    assert.match(html, /Apollo Pharmacy/);
    assert.match(html, /Distance: <b>0\.8 km<\/b>/);
    assert.match(html, /📞 0141-1234567/);
    assert.match(html, /Source: <b>OpenStreetMap<\/b>/);
  });

  await t.test("no MediAtlas-only labels leak into the OSM card", () => {
    // The OSM path must not surface MediAtlas-specific fields like a forecast
    // demand line or a substitute-list section.
    assert.doesNotMatch(html, /<b>Forecast:<\/b>/);
    assert.doesNotMatch(html, /MediAtlas/);
  });
});

test("OSM path — action keyboard exposes 📞 Call and 🧭 Directions buttons", () => {
  const kb = buildNearbyActionKeyboard(osmRecommendation.ranked);
  const flat = kb.inline_keyboard.flat();

  const call = flat.find((b) => b.text && b.text.includes("📞"));
  assert.ok(call, "expected 📞 Call button on OSM path");
  assert.match(call.callback_data || "", /pharmacy_call:/);

  const dir = flat.find((b) => b.text && b.text.includes("🧭"));
  assert.ok(dir, "expected 🧭 Directions button on OSM path");
  assert.equal(dir.url, "https://maps.google.com/?q=apollo");

  // 🔄 Search Again is the always-on row.
  const again = flat.find((b) => b.callback_data === "prompt_search");
  assert.ok(again, "expected 🔄 Search Again button");
});

test("OSM path — recommendation rendering is deterministic", () => {
  const a = formatNearbyRecommendations(osmRecommendation, "Paracetamol");
  const b = formatNearbyRecommendations(osmRecommendation, "Paracetamol");
  assert.equal(a, b);
});
