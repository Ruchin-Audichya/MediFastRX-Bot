"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { parseAIContextPacket } = require("../src/integrations/mediatlas/schemas");
const { MediAtlasSchemaError } = require("../src/integrations/mediatlas/mediatlasErrors");

const FIXTURE_PATH = path.join(__dirname, "contract", "mediatlas.context.fixture.json");
const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

test("parses the locked AIContextPacket sample without modification", () => {
  const raw = loadFixture();
  const parsed = parseAIContextPacket(raw);

  assert.equal(parsed.schema_version, 1);
  assert.equal(parsed.medicine.resolved_name, "Dolo 650");
  assert.equal(parsed.summary.available_nearby, true);
  assert.equal(parsed.availability.inventory.items.length, 2);
  assert.equal(parsed.availability.forecast.forecast.points.length, 7);
  assert.equal(parsed.drug.monographs[0].provenance.source_rank, 1);
  assert.equal(parsed.interactions.interaction_count, 0);
  assert.equal(parsed.meta.partial, false);
  assert.deepEqual(parsed.meta.sections_degraded, []);
});

test("preserves forward-compat unknown fields via passthrough", () => {
  const raw = loadFixture();
  raw.future_field = "additive_in_1_1_x";
  raw.medicine.future_score = 0.42;
  raw.summary.experimental_flag = true;

  const parsed = parseAIContextPacket(raw);
  assert.equal(parsed.future_field, "additive_in_1_1_x");
  assert.equal(parsed.medicine.future_score, 0.42);
  assert.equal(parsed.summary.experimental_flag, true);
});

test("availability null is a valid degraded state, not a parse error", () => {
  const raw = loadFixture();
  raw.availability = null;
  raw.meta.sections_degraded = ["availability"];
  raw.meta.partial = true;

  const parsed = parseAIContextPacket(raw);
  assert.equal(parsed.availability, null);
  assert.equal(parsed.meta.partial, true);
});

test("drug null is a valid degraded state", () => {
  const raw = loadFixture();
  raw.drug = null;
  const parsed = parseAIContextPacket(raw);
  assert.equal(parsed.drug, null);
});

test("interactions null is a valid degraded state", () => {
  const raw = loadFixture();
  raw.interactions = null;
  const parsed = parseAIContextPacket(raw);
  assert.equal(parsed.interactions, null);
});

test("forecast.forecast inner object can be null when degraded", () => {
  const raw = loadFixture();
  raw.availability.forecast.forecast = null;
  raw.availability.forecast.status = "degraded";
  raw.availability.forecast.detail = "model unavailable";

  const parsed = parseAIContextPacket(raw);
  assert.equal(parsed.availability.forecast.forecast, null);
  assert.equal(parsed.availability.forecast.status, "degraded");
});

test("summary best_pharmacy fields are nullable when nothing in stock", () => {
  const raw = loadFixture();
  raw.summary.available_nearby = false;
  raw.summary.best_pharmacy_id = null;
  raw.summary.best_pharmacy_name = null;
  raw.summary.nearest_distance_km = null;
  raw.summary.max_stock_nearby = null;
  raw.summary.shortage_risk = null;

  const parsed = parseAIContextPacket(raw);
  assert.equal(parsed.summary.available_nearby, false);
  assert.equal(parsed.summary.best_pharmacy_id, null);
  assert.equal(parsed.summary.nearest_distance_km, null);
});

test("missing required key (not null) is a contract violation", () => {
  const raw = loadFixture();
  delete raw.summary;
  assert.throws(() => parseAIContextPacket(raw), MediAtlasSchemaError);
});

test("missing nullable section key (vs null) is also a violation", () => {
  const raw = loadFixture();
  delete raw.availability;
  assert.throws(
    () => parseAIContextPacket(raw),
    /availability/i
  );
});

test("clamps score at 1.000001 with warning instead of rejecting", () => {
  const raw = loadFixture();
  raw.medicine.confidence = 1.000001;
  const warnings = [];
  const parsed = parseAIContextPacket(raw, {
    onClampWarning: (msg) => warnings.push(msg),
  });
  assert.equal(parsed.medicine.confidence, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /clamped/);
});

test("rejects out-of-range score beyond epsilon", () => {
  const raw = loadFixture();
  raw.medicine.confidence = 1.5;
  assert.throws(() => parseAIContextPacket(raw), MediAtlasSchemaError);
});

test("rejects unknown enum values strictly (stock_status)", () => {
  const raw = loadFixture();
  raw.availability.inventory.items[0].stock_status = "in_stock_maybe";
  assert.throws(() => parseAIContextPacket(raw), /stock_status/);
});

test("rejects unknown enum values strictly (match_reason)", () => {
  const raw = loadFixture();
  raw.medicine.match_reason = "psychic_resonance";
  assert.throws(() => parseAIContextPacket(raw), /match_reason/);
});

test("rejects unknown enum values strictly (forecast trend)", () => {
  const raw = loadFixture();
  raw.availability.forecast.forecast.trend = "spiraling";
  assert.throws(() => parseAIContextPacket(raw), /trend/);
});

test("rejects unknown enum values strictly (section status)", () => {
  const raw = loadFixture();
  raw.availability.inventory.status = "fine_probably";
  assert.throws(() => parseAIContextPacket(raw), /status/);
});

test("rejects bad ISO datetime", () => {
  const raw = loadFixture();
  raw.generated_at = "yesterday";
  assert.throws(() => parseAIContextPacket(raw), /datetime/);
});

test("rejects bad date-only forecast point", () => {
  const raw = loadFixture();
  raw.availability.forecast.forecast.points[0].date = "2026/05/30";
  assert.throws(() => parseAIContextPacket(raw), /date/);
});
