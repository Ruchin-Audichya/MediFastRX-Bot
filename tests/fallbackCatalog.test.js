"use strict";

// Tests for the in-memory curated fallback catalog (Mongo-resilience layer).
// Loads the committed data/medicine-sources JSONs — no Mongo, no network.

const test = require("node:test");
const assert = require("node:assert/strict");

const { findFallbackMedicine, toKnowledgeShape, loadCatalog } = require("../src/medicine/fallbackCatalog");

test("catalog loads curated records from data/medicine-sources", () => {
  const catalog = loadCatalog();
  assert.ok(Array.isArray(catalog));
  assert.ok(catalog.length > 0, "expected at least one curated record");
});

test("finds a medicine by brand name", () => {
  const rec = findFallbackMedicine("Dolo 650");
  assert.ok(rec, "expected a match for Dolo 650");
  assert.equal(rec.genericName, "Paracetamol");
});

test("finds a medicine by generic name", () => {
  const rec = findFallbackMedicine("Paracetamol");
  assert.ok(rec);
  assert.match(rec.genericName, /Paracetamol/i);
});

test("finds a medicine by common misspelling", () => {
  const rec = findFallbackMedicine("paracitamol");
  assert.ok(rec, "expected fuzzy/spelling match");
});

test("returns null for nonsense", () => {
  assert.equal(findFallbackMedicine("zzzqxwv"), null);
  assert.equal(findFallbackMedicine(""), null);
});

test("toKnowledgeShape matches searchMedicineKnowledge output shape", () => {
  const rec = findFallbackMedicine("Pan 40");
  const shaped = toKnowledgeShape(rec);
  assert.ok(shaped.medicine);
  assert.ok(shaped.medicine.medicineName);
  assert.ok(shaped.medicine.genericName);
  assert.ok(Array.isArray(shaped.medicine.sideEffects));
  assert.equal(typeof shaped.medicine.prescriptionRequired, "boolean");
  assert.equal(shaped.source, "fallback-catalog");
});
