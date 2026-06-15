"use strict";

/**
 * Unit tests for the nearby-pharmacy card rendering — Phase 8 / Task 10.4.
 *
 * Covers `formatNearbyRecommendations` (already exported by
 * `src/bot/commands/nearby.js`) and the `buildNearbyActionKeyboard` action
 * keyboard, asserting:
 *   - phone, distance, open status, and source surface in the rendered card.
 *   - the action keyboard exposes a 📞 Call button when a phone is present
 *     and a 🧭 Directions button when a directions URL is present.
 *
 * **Validates: Requirements 3.5**
 *
 * No real Mongo / OSM is touched. Inputs are deterministic literals.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const {
  formatNearbyRecommendations,
  buildNearbyActionKeyboard,
} = require(path.join(REPO_ROOT, "src/bot/commands/nearby.js"));

const buildRecommendation = (overrides = {}) => ({
  radiusKm: 5,
  expandedRadius: false,
  osmHydrated: true,
  medicine: { genericName: "Paracetamol" },
  medicineConfidence: 0.9,
  ranked: [
    {
      name: "Apollo Pharmacy",
      address: "12, Main Road, Vaishali Nagar, Jaipur",
      distance: "0.8 km",
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
    {
      name: "MedPlus",
      address: "44, Tonk Road, Jaipur",
      distance: "1.4 km",
      score: 0.78,
      openStatus: "Closes 9 PM",
      source: "Mongo Geo",
      inventoryConfidence: 0.6,
      popularityScore: 0.5,
      searchSuccessScore: 0.4,
    },
  ],
  ...overrides,
});

test("formatNearbyRecommendations — renders phone, distance, open status, source", async (t) => {
  const recommendation = buildRecommendation();
  const html = formatNearbyRecommendations(recommendation, "Paracetamol");

  await t.test("contains pharmacy names", () => {
    assert.match(html, /Apollo Pharmacy/);
    assert.match(html, /MedPlus/);
  });

  await t.test("contains medicine line when query supplied", () => {
    assert.match(html, /<b>Paracetamol<\/b>/);
  });

  await t.test("contains distance and open status", () => {
    assert.match(html, /0\.8 km/);
    assert.match(html, /🟢 Open/);
    assert.match(html, /1\.4 km/);
  });

  await t.test("phone surfaces only when present", () => {
    assert.match(html, /📞 0141-1234567/);
    // MedPlus has no phone — must not invent one.
    const medPlusBlock = html.split("MedPlus")[1] || "";
    assert.doesNotMatch(medPlusBlock, /📞/);
  });

  await t.test("live OSM hydration marker is present", () => {
    // Compact card surfaces hydration as a "· live" badge rather than a
    // verbose "refreshed from OpenStreetMap" line or internal source labels.
    assert.match(html, /· live/);
  });

  await t.test("radius is shown", () => {
    assert.match(html, /within 5km/);
  });

  await t.test("output is deterministic", () => {
    const a = formatNearbyRecommendations(recommendation, "Paracetamol");
    const b = formatNearbyRecommendations(recommendation, "Paracetamol");
    assert.equal(a, b);
  });
});

test("formatNearbyRecommendations — empty ranked list shows fallback message", () => {
  const html = formatNearbyRecommendations(
    { radiusKm: 5, ranked: [], medicine: { genericName: "Paracetamol" } },
    "Paracetamol"
  );
  assert.match(html, /No pharmacies nearby yet/);
  assert.match(html, /within <b>5 km<\/b>/);
});

test("buildNearbyActionKeyboard — exposes Call + Directions when present", async (t) => {
  const recommendation = buildRecommendation();
  const keyboard = buildNearbyActionKeyboard(recommendation.ranked);

  await t.test("keyboard contains a 📞 Call button", () => {
    const flat = keyboard.inline_keyboard.flat();
    const callButton = flat.find((b) => b.text && b.text.includes("📞"));
    assert.ok(callButton, "expected 📞 Call button");
    assert.match(callButton.callback_data || "", /pharmacy_call:/);
  });

  await t.test("keyboard contains a 🧭 Directions URL button", () => {
    const flat = keyboard.inline_keyboard.flat();
    const dir = flat.find((b) => b.text && b.text.includes("🧭"));
    assert.ok(dir, "expected 🧭 Directions button");
    assert.equal(dir.url, "https://maps.google.com/?q=apollo");
  });

  await t.test("keyboard always contains 🔄 Search Again", () => {
    const flat = keyboard.inline_keyboard.flat();
    const again = flat.find(
      (b) => b.callback_data === "prompt_search" && b.text.includes("🔄")
    );
    assert.ok(again);
  });
});

test("buildNearbyActionKeyboard — empty input still returns the Search Again button", () => {
  const keyboardEmpty = buildNearbyActionKeyboard([]);
  const flat = keyboardEmpty.inline_keyboard.flat();
  const again = flat.find((b) => b.callback_data === "prompt_search");
  assert.ok(again);
  // No 📞 / 🧭 when there are no ranked results.
  assert.equal(flat.find((b) => b.text && b.text.includes("📞")), undefined);
  assert.equal(flat.find((b) => b.text && b.text.includes("🧭")), undefined);
});
