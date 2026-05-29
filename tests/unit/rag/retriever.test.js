"use strict";

/**
 * Task 5.6 — unit tests for the pure retrieval helpers in
 * `src/rag/retriever.js`: `buildWhereClause`, `buildIdentityTokens`,
 * `matchesIdentity`.
 *
 *   Property 4 (Preservation): no scope + no metadata → `where` is undefined.
 *   Property 1 (No contamination): when scope is supplied, the where clause
 *   is an `$or` over `medicine` / `generic` / `alias`, AND-ed with the base
 *   filter; medicine-scoped fields are stripped from the equality filter.
 *
 * **Validates: Requirements 1.2, 2.2, 3.1, 3.2**
 *
 * Pure-function tests — no mocks, no I/O, no Chroma.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const {
  buildWhereClause,
  buildIdentityTokens,
  matchesIdentity,
} = require(path.join(REPO_ROOT, "src/rag/retriever.js"));

// ---------------------------------------------------------------------------
// buildWhereClause
// ---------------------------------------------------------------------------
test("buildWhereClause — no scope, no metadata → undefined", () => {
  assert.equal(buildWhereClause(), undefined);
  assert.equal(buildWhereClause({}, null), undefined);
  assert.equal(buildWhereClause({}, undefined), undefined);
});

test("buildWhereClause — only metadata returns equality filter, strips medicine fields", () => {
  const where = buildWhereClause(
    {
      source: "knowledge-base/medicines/pregabalin.md",
      category: "neuropathic_pain",
      trust: "curated",
      // medicine-scoped fields belong in $or, not equality — must be stripped.
      medicine: "Pregabalin",
      generic: "Pregabalin",
      alias: "Lyrica",
    },
    null
  );
  assert.deepEqual(where, {
    source: "knowledge-base/medicines/pregabalin.md",
    category: "neuropathic_pain",
    trust: "curated",
  });
});

test("buildWhereClause — scope name only collapses to single equality", () => {
  const where = buildWhereClause({}, { medicineName: "Pregabalin" });
  assert.deepEqual(where, { medicine: "Pregabalin" });
});

test("buildWhereClause — scope with name + generic + aliases → $or clause", () => {
  const where = buildWhereClause(
    {},
    {
      medicineName: "Dolo650",
      genericName: "Paracetamol",
      aliases: ["Calpol", "Crocin"],
    }
  );
  assert.deepEqual(where, {
    $or: [
      { medicine: "Dolo650" },
      { generic: "Paracetamol" },
      { alias: "Calpol" },
      { alias: "Crocin" },
    ],
  });
});

test("buildWhereClause — base + scope merged via $and", () => {
  const where = buildWhereClause(
    { source: "knowledge-base/medicines/dolo650.md", category: "analgesic" },
    {
      medicineName: "Dolo650",
      genericName: "Paracetamol",
      aliases: ["Calpol"],
    }
  );
  assert.deepEqual(where, {
    $and: [
      { source: "knowledge-base/medicines/dolo650.md", category: "analgesic" },
      {
        $or: [
          { medicine: "Dolo650" },
          { generic: "Paracetamol" },
          { alias: "Calpol" },
        ],
      },
    ],
  });
});

test("buildWhereClause — case-insensitive same-as-name generic skipped", () => {
  const where = buildWhereClause(
    {},
    { medicineName: "Pregabalin", genericName: "PREGABALIN" }
  );
  // Only the medicine clause — no separate `generic` clause.
  assert.deepEqual(where, { medicine: "Pregabalin" });
});

test("buildWhereClause — scope without any usable tokens degrades to base filter", () => {
  // No medicineName, no genericName, no aliases → orClauses is empty, so
  // only the base filter (sans medicine fields) survives. With no base, undefined.
  assert.equal(buildWhereClause({}, { aliases: [] }), undefined);
  assert.deepEqual(
    buildWhereClause({ source: "s" }, { aliases: [] }),
    { source: "s" }
  );
});

// ---------------------------------------------------------------------------
// buildIdentityTokens
// ---------------------------------------------------------------------------
test("buildIdentityTokens — null/undefined/empty → null", () => {
  assert.equal(buildIdentityTokens(null), null);
  assert.equal(buildIdentityTokens(undefined), null);
  assert.equal(buildIdentityTokens({}), null);
  assert.equal(buildIdentityTokens({ aliases: [], salts: [] }), null);
});

test("buildIdentityTokens — lowercased trimmed identity tokens", () => {
  const tokens = buildIdentityTokens({
    medicineName: "  Pregabalin ",
    genericName: "PREGABALIN",
    aliases: ["Lyrica", "  PREGALIN"],
    salts: ["Pregabalin"],
  });
  assert.ok(tokens instanceof Set);
  assert.deepEqual([...tokens].sort(), ["lyrica", "pregabalin", "pregalin"]);
});

test("buildIdentityTokens — falsy entries skipped", () => {
  const tokens = buildIdentityTokens({
    medicineName: "",
    genericName: null,
    aliases: ["", null, undefined, "Lyrica"],
    salts: [""],
  });
  assert.deepEqual([...tokens], ["lyrica"]);
});

// ---------------------------------------------------------------------------
// matchesIdentity
// ---------------------------------------------------------------------------
test("matchesIdentity — null tokens → true (preservation)", () => {
  assert.equal(matchesIdentity({ medicine: "Pregabalin" }, null), true);
  assert.equal(matchesIdentity({}, null), true);
});

test("matchesIdentity — neutral metadata (no medicine/generic/alias) → true", () => {
  const tokens = new Set(["pregabalin"]);
  assert.equal(matchesIdentity({}, tokens), true);
  assert.equal(matchesIdentity({ source: "guideline.md" }, tokens), true);
  assert.equal(matchesIdentity({ medicine: null, generic: null, alias: null }, tokens), true);
});

test("matchesIdentity — match by medicine, generic, or alias", () => {
  const tokens = new Set(["pregabalin", "lyrica"]);
  assert.equal(matchesIdentity({ medicine: "Pregabalin" }, tokens), true);
  assert.equal(matchesIdentity({ generic: "Pregabalin" }, tokens), true);
  assert.equal(matchesIdentity({ alias: "Lyrica" }, tokens), true);
  // Case + whitespace insensitive.
  assert.equal(matchesIdentity({ medicine: "  PREGABALIN  " }, tokens), true);
});

test("matchesIdentity — clear mismatch → false", () => {
  const tokens = new Set(["pregabalin"]);
  assert.equal(matchesIdentity({ medicine: "Gabapentin" }, tokens), false);
  assert.equal(matchesIdentity({ medicine: "Alprazolam", generic: "Alprazolam" }, tokens), false);
});
