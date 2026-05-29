"use strict";

/**
 * Task 5.6 — unit tests for `knowledgeFilter` and `medicineScopeFilter` in
 * `src/services/ragService.js`.
 *
 *   Property 4 (Preservation): when no medicineScope is supplied,
 *   `knowledgeFilter(metadata)` MUST equal the canonical reduction over
 *   `["source", "category", "trust", "updatedAt"]`.
 *   Property 1 surface (medicine identity flows in): when scope is supplied,
 *   the filter extends with `medicine` (and `generic` only when distinct).
 *
 * **Validates: Requirements 2.2, 3.1, 3.2**
 *
 * Pure-function tests — no mocks, no I/O.
 */

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const RAG_SERVICE_PATH = path.join(REPO_ROOT, "src/services/ragService.js");
const { knowledgeFilter, medicineScopeFilter } = require(RAG_SERVICE_PATH);

const BASELINE_KEYS = ["source", "category", "trust", "updatedAt"];
const baselineFilter = (metadata = {}) =>
  BASELINE_KEYS.reduce((filter, key) => {
    if (metadata[key]) filter[key] = metadata[key];
    return filter;
  }, {});

// ---------------------------------------------------------------------------
// 1. Parity (Property 4) — knowledgeFilter(metadata) without scope MUST equal
//    the canonical reduction byte-for-byte.
// ---------------------------------------------------------------------------
test("Property 4 — knowledgeFilter matches canonical reduction with no scope", () => {
  const cases = [
    {},
    { source: "knowledge-base/medicines/pregabalin.md" },
    { category: "neuropathic_pain" },
    {
      source: "knowledge-base/symptoms/fever.md",
      category: "symptom",
      trust: "curated",
      updatedAt: "2026-02-15",
    },
    {
      source: "knowledge-base/medicines/dolo650.md",
      category: "analgesic",
      medicine: "Dolo650",
      generic: "Paracetamol",
      alias: "Crocin",
      irrelevantKey: "should-not-leak",
      telegramId: "u-123",
    },
    { source: "", category: null, trust: undefined, updatedAt: 0 },
  ];

  for (const metadata of cases) {
    const expected = baselineFilter(metadata);
    const actual = knowledgeFilter(metadata);
    assert.deepEqual(
      actual,
      expected,
      `knowledgeFilter parity failed for ${JSON.stringify(metadata)}: ` +
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
    // Byte-for-byte equality of JSON serialization too — guards against key
    // order regressions a deepEqual would otherwise tolerate.
    assert.equal(JSON.stringify(actual), JSON.stringify(expected));
  }
});

test("Property 4 — knowledgeFilter never leaks unknown keys when no scope", () => {
  const result = knowledgeFilter({
    source: "x",
    category: "y",
    trust: "z",
    updatedAt: "u",
    medicine: "Pregabalin",
    generic: "Pregabalin",
    alias: "Lyrica",
    junk: 42,
  });
  for (const key of Object.keys(result)) {
    assert.ok(
      BASELINE_KEYS.includes(key),
      `unexpected key "${key}" in knowledgeFilter output without scope`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. medicineScopeFilter shape contract.
// ---------------------------------------------------------------------------
test("medicineScopeFilter — null/undefined/empty scope yields {}", () => {
  assert.deepEqual(medicineScopeFilter(null), {});
  assert.deepEqual(medicineScopeFilter(undefined), {});
  assert.deepEqual(medicineScopeFilter({}), {});
  assert.deepEqual(medicineScopeFilter({ medicineName: "" }), {});
  assert.deepEqual(medicineScopeFilter({ medicineName: "   " }), {});
});

test("medicineScopeFilter — name only", () => {
  assert.deepEqual(
    medicineScopeFilter({ medicineName: "Pregabalin" }),
    { medicine: "Pregabalin" }
  );
});

test("medicineScopeFilter — name + different generic", () => {
  assert.deepEqual(
    medicineScopeFilter({ medicineName: "Dolo650", genericName: "Paracetamol" }),
    { medicine: "Dolo650", generic: "Paracetamol" }
  );
});

test("medicineScopeFilter — name + matching generic (case-insensitive) drops generic", () => {
  assert.deepEqual(
    medicineScopeFilter({ medicineName: "Pregabalin", genericName: "pregabalin" }),
    { medicine: "Pregabalin" }
  );
  assert.deepEqual(
    medicineScopeFilter({ medicineName: "Pregabalin", genericName: "PREGABALIN" }),
    { medicine: "Pregabalin" }
  );
});

// ---------------------------------------------------------------------------
// 3. knowledgeFilter with scope merges base metadata + medicine identity.
// ---------------------------------------------------------------------------
test("knowledgeFilter — with scope (matching generic suppressed)", () => {
  const metadata = { source: "x", category: "y" };
  const scope = { medicineName: "Pregabalin", genericName: "Pregabalin" };
  assert.deepEqual(
    knowledgeFilter(metadata, scope),
    { source: "x", category: "y", medicine: "Pregabalin" }
  );
});

test("knowledgeFilter — with scope (distinct generic preserved)", () => {
  const metadata = { source: "x", category: "y" };
  const scope = { medicineName: "Dolo650", genericName: "Paracetamol" };
  assert.deepEqual(
    knowledgeFilter(metadata, scope),
    { source: "x", category: "y", medicine: "Dolo650", generic: "Paracetamol" }
  );
});

test("knowledgeFilter — null scope behaves identically to no scope", () => {
  const metadata = { source: "x", category: "y", trust: "curated" };
  assert.deepEqual(
    knowledgeFilter(metadata, null),
    knowledgeFilter(metadata)
  );
});

// ---------------------------------------------------------------------------
// 4. Snapshot drift guard — the canonical keys array literal must remain in
//    src/services/ragService.js (mirrors the preservation test tripwire).
// ---------------------------------------------------------------------------
test("snapshot drift guard — canonical keys array literal still present", () => {
  const source = fs.readFileSync(RAG_SERVICE_PATH, "utf8");
  assert.match(
    source,
    /\[\s*"source"\s*,\s*"category"\s*,\s*"trust"\s*,\s*"updatedAt"\s*\]/,
    "ragService.js no longer contains the canonical knowledgeFilter keys array"
  );
});
