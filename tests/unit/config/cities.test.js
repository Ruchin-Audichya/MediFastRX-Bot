"use strict";

/**
 * Unit tests for `config/cities.js` — Phase 8 / Task 10.4.
 *
 * Covers:
 *   - getCityConfig: explicit lookup, default fallback, case-insensitive match.
 *   - getNearestCity: haversine selection across the configured set, default
 *     fallback for invalid input, and `maxDistanceKm` capping.
 *
 * **Validates: Requirements 3.5**
 *
 * No production code is changed; pure helper tested directly.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const { cities, getCityConfig, getNearestCity } = require(path.join(
  REPO_ROOT,
  "config/cities.js"
));

test("config/cities — getCityConfig", async (t) => {
  await t.test("returns Bengaluru entry for explicit lookup", () => {
    const c = getCityConfig("Bengaluru");
    assert.equal(c.name, "Bengaluru");
    assert.equal(c.state, "Karnataka");
    assert.equal(typeof c.lat, "number");
    assert.equal(typeof c.lng, "number");
    assert.equal(typeof c.radiusKm, "number");
  });

  await t.test("is case-insensitive", () => {
    const lower = getCityConfig("delhi");
    assert.equal(lower.name, "Delhi");
    const upper = getCityConfig("MUMBAI");
    assert.equal(upper.name, "Mumbai");
  });

  await t.test("falls back to Jaipur for unknown city name", () => {
    const c = getCityConfig("Atlantis");
    assert.equal(c.name, "Jaipur");
    assert.equal(c, cities.Jaipur);
  });

  await t.test("falls back to Jaipur when called with no argument", () => {
    const c = getCityConfig();
    assert.equal(c.name, "Jaipur");
  });
});

test("config/cities — getNearestCity (haversine selection)", async (t) => {
  await t.test("Bengaluru centroid returns Bengaluru with distance ≈ 0", () => {
    const result = getNearestCity({ latitude: 12.9716, longitude: 77.5946 });
    assert.equal(result.name, "Bengaluru");
    assert.ok(
      result.distanceKm < 0.001,
      `expected near-zero distance, got ${result.distanceKm}`
    );
  });

  await t.test("Delhi centroid returns Delhi", () => {
    const result = getNearestCity({ latitude: 28.6139, longitude: 77.209 });
    assert.equal(result.name, "Delhi");
    assert.ok(result.distanceKm < 0.001);
  });

  await t.test("Mumbai centroid returns Mumbai", () => {
    const result = getNearestCity({ latitude: 19.076, longitude: 72.8777 });
    assert.equal(result.name, "Mumbai");
    assert.ok(result.distanceKm < 0.001);
  });

  await t.test("a coordinate inside Jaipur city limits returns Jaipur", () => {
    // Slightly off the centroid but still clearly Jaipur.
    const result = getNearestCity({ latitude: 26.92, longitude: 75.79 });
    assert.equal(result.name, "Jaipur");
    assert.ok(result.distanceKm < 5);
  });

  await t.test("a coordinate near Pune returns Pune (not Mumbai)", () => {
    const result = getNearestCity({ latitude: 18.5204, longitude: 73.8567 });
    assert.equal(result.name, "Pune");
    assert.ok(result.distanceKm < 0.001);
  });

  await t.test("invalid lat/lng returns Jaipur fallback", () => {
    const r1 = getNearestCity({ latitude: NaN, longitude: NaN });
    assert.equal(r1.name, "Jaipur");
    assert.equal(r1.distanceKm, Number.POSITIVE_INFINITY);

    const r2 = getNearestCity({ latitude: 999, longitude: 0 });
    assert.equal(r2.name, "Jaipur");

    const r3 = getNearestCity({});
    assert.equal(r3.name, "Jaipur");

    const r4 = getNearestCity();
    assert.equal(r4.name, "Jaipur");
  });

  await t.test("maxDistanceKm cap returns null when nearest is too far", () => {
    // Bengaluru centroid with a 0.001km cap is essentially exact — passes.
    const within = getNearestCity({
      latitude: 12.9716,
      longitude: 77.5946,
      maxDistanceKm: 0.001,
    });
    assert.equal(within.name, "Bengaluru");

    // Mumbai coordinates with a tiny 1km cap from a non-centroid point —
    // closest city is Mumbai, but the distance exceeds the cap, so null.
    const tooFar = getNearestCity({
      latitude: 20.0,
      longitude: 73.0,
      maxDistanceKm: 1,
    });
    assert.equal(tooFar, null);
  });

  await t.test("returned object includes distanceKm", () => {
    const result = getNearestCity({ latitude: 13.0827, longitude: 80.2707 });
    assert.equal(result.name, "Chennai");
    assert.equal(typeof result.distanceKm, "number");
    assert.ok(Number.isFinite(result.distanceKm));
  });
});

test("config/cities — module shape", () => {
  assert.equal(typeof cities, "object");
  // The expanded city set (Phase 8 / Task 10.1) must include the required
  // metros — preservation contract for downstream callers.
  for (const name of [
    "Jaipur",
    "Delhi",
    "Mumbai",
    "Kota",
    "Bengaluru",
    "Hyderabad",
    "Chennai",
    "Kolkata",
    "Pune",
    "Ahmedabad",
    "Lucknow",
    "Indore",
    "Chandigarh",
  ]) {
    assert.ok(cities[name], `expected city "${name}" to be configured`);
    assert.equal(cities[name].name, name);
  }
});
