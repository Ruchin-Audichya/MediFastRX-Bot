"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseAIContextPacket } = require("../src/integrations/mediatlas/schemas");
const { mapAIContextPacket } = require("../src/integrations/mediatlas/mediatlasMapper");

const FIXTURE_PATH = path.join(__dirname, "contract", "mediatlas.context.fixture.json");
const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

const parsedFromFixture = () => parseAIContextPacket(loadFixture());

test("maps full packet into camelCase MediFast envelope", () => {
  const mapped = mapAIContextPacket(parsedFromFixture());

  assert.equal(mapped.source, "mediatlas");
  assert.equal(mapped.medicine.resolvedName, "Dolo 650");
  assert.equal(mapped.medicine.matchReason, "exact_brand");
  assert.equal(mapped.summary.availableNearby, true);
  assert.equal(mapped.summary.bestPharmacyId, "pharm_8a3f2c");
  assert.equal(mapped.availability.inventory.items[0].pharmacy.name, "Apollo Pharmacy - C-Scheme");
  assert.equal(mapped.availability.inventory.items[0].distanceKm, 1.4);
  assert.equal(mapped.availability.forecast.forecast.points.length, 7);
  assert.equal(mapped.drug.activeIngredient, "Paracetamol");
  assert.equal(mapped.drug.monographs[0].provenance.sourceRank, 1);
  assert.equal(mapped.interactions.interactionCount, 0);
  assert.equal(mapped.disclaimer.startsWith("Reference and operational"), true);
  assert.equal(mapped.meta.partial, false);
  assert.equal(mapped.isPartial, false);
});

test("availability mapper drops the duplicated medicine + summary blocks", () => {
  const mapped = mapAIContextPacket(parsedFromFixture());
  // top-level medicine + summary preserved
  assert.equal(typeof mapped.medicine, "object");
  assert.equal(typeof mapped.summary, "object");
  // duplicates inside availability removed
  assert.equal(mapped.availability.medicine, undefined);
  assert.equal(mapped.availability.summary, undefined);
});

test("nullable sections map to null, not undefined", () => {
  const raw = loadFixture();
  raw.availability = null;
  raw.drug = null;
  raw.interactions = null;
  raw.meta.sections_degraded = ["availability", "drug", "interactions"];
  raw.meta.partial = true;

  const parsed = parseAIContextPacket(raw);
  const mapped = mapAIContextPacket(parsed);

  assert.equal(mapped.availability, null);
  assert.equal(mapped.drug, null);
  assert.equal(mapped.interactions, null);
  assert.equal(mapped.isPartial, true);
  assert.deepEqual(mapped.degradedSections, ["availability", "drug", "interactions"]);
});

test("preserves null pharmacy summary fields when nothing in stock", () => {
  const raw = loadFixture();
  raw.summary.available_nearby = false;
  raw.summary.best_pharmacy_id = null;
  raw.summary.best_pharmacy_name = null;
  raw.summary.nearest_distance_km = null;
  raw.summary.max_stock_nearby = null;
  raw.summary.shortage_risk = null;

  const mapped = mapAIContextPacket(parseAIContextPacket(raw));
  assert.equal(mapped.summary.availableNearby, false);
  assert.equal(mapped.summary.bestPharmacyId, null);
  assert.equal(mapped.summary.nearestDistanceKm, null);
  // confidence.summary should be 0 when nothing available
  assert.equal(mapped.confidence.summary, 0);
});

test("forecast.forecast inner null is preserved", () => {
  const raw = loadFixture();
  raw.availability.forecast.forecast = null;
  raw.availability.forecast.status = "degraded";
  raw.availability.forecast.detail = "model unavailable";

  const mapped = mapAIContextPacket(parseAIContextPacket(raw));
  assert.equal(mapped.availability.forecast.status, "degraded");
  assert.equal(mapped.availability.forecast.forecast, null);
});

test("flags medicine identity drift between top-level and availability.medicine", () => {
  const raw = loadFixture();
  raw.availability.medicine = {
    ...raw.availability.medicine,
    resolved_name: "Dolo 500",
  };
  const mapped = mapAIContextPacket(parseAIContextPacket(raw));
  assert.equal(mapped.medicineDriftDetected, true);
});

test("confidence block surfaces medicine + drug confidence", () => {
  const raw = loadFixture();
  raw.medicine.confidence = 0.8;
  raw.drug.confidence = 0.7;

  const mapped = mapAIContextPacket(parseAIContextPacket(raw));
  assert.equal(mapped.confidence.medicine, 0.8);
  assert.equal(mapped.confidence.drug, 0.7);
});
