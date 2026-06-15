"use strict";

// Tests for the need-based medicine suggestion fallback (Groq suggests real
// medicine names for descriptive/need queries the catalog can't match).
// Pure logic — no network (suggestMedicinesForNeed gates on looksLikeMedicineNeed
// before any provider call, and we test parsing directly).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  looksLikeMedicineQuery,
  looksLikeMedicineNeed,
  __internals,
} = require("../src/medicine/llmAugmentService");

const { parseSuggestionList } = __internals;

test("looksLikeMedicineNeed detects descriptive/need queries", () => {
  assert.equal(looksLikeMedicineNeed("sex medicine"), true);
  assert.equal(looksLikeMedicineNeed("medicine for acidity"), true);
  assert.equal(looksLikeMedicineNeed("nind ki dawa"), true);
  assert.equal(looksLikeMedicineNeed("kuch gas ki dawai"), true);
  assert.equal(looksLikeMedicineNeed("tablet for headache"), true);
});

test("looksLikeMedicineNeed does NOT fire for clean medicine names", () => {
  // These are medicine names → handled by the normal/augment path, not need-suggestion.
  assert.equal(looksLikeMedicineNeed("Dolo 650"), false);
  assert.equal(looksLikeMedicineNeed("Pregabalin"), false);
  assert.equal(looksLikeMedicineNeed("Telma 40"), false);
});

test("need and medicine-name detection are mutually exclusive", () => {
  // A clean name is medicine-like and NOT a need.
  assert.equal(looksLikeMedicineQuery("Sildenafil"), true);
  assert.equal(looksLikeMedicineNeed("Sildenafil"), false);
});

test("parseSuggestionList extracts clean names from model output", () => {
  assert.deepEqual(parseSuggestionList("Sildenafil (Viagra), Tadalafil, Dapoxetine"), [
    "Sildenafil (Viagra)",
    "Tadalafil",
    "Dapoxetine",
  ]);
  assert.deepEqual(parseSuggestionList("1. Pantoprazole\n2. Omeprazole"), [
    "Pantoprazole",
    "Omeprazole",
  ]);
});

test("parseSuggestionList returns [] for NONE / empty", () => {
  assert.deepEqual(parseSuggestionList("NONE"), []);
  assert.deepEqual(parseSuggestionList(""), []);
  assert.deepEqual(parseSuggestionList("   "), []);
});

test("parseSuggestionList caps at 4 and drops overly long entries", () => {
  const out = parseSuggestionList("A, B, C, D, E, F");
  assert.equal(out.length, 4);
  const longName = "x".repeat(60);
  assert.deepEqual(parseSuggestionList(`${longName}, Aspirin`), ["Aspirin"]);
});
