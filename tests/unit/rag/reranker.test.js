"use strict";

/**
 * Task 5.6 — unit tests for `src/rag/reranker.js`: `rerank`,
 * `medicineMatchScore`, and `overlapScore`.
 *
 *   Property 4 (Preservation): with no medicineScope, components are exactly
 *   `{semantic, keyword, category}` and ordering is identical to today.
 *   Property 1 (No contamination): with an active medicine, matches are
 *   boosted, mismatches are demoted and dropped below the threshold; neutral
 *   chunks are kept.
 *
 * **Validates: Requirements 1.3, 2.3, 3.1, 3.2**
 *
 * Pure-function tests using `tests/_mocks/fakeKnowledgeBase.js` CHUNKS.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const { rerank, medicineMatchScore, overlapScore } = require(path.join(
  REPO_ROOT,
  "src/rag/reranker.js"
));
const { CHUNKS } = require(path.join(
  REPO_ROOT,
  "tests/_mocks/fakeKnowledgeBase.js"
));

// Pin weights so tests are stable regardless of env defaults.
const PINNED_WEIGHTS = { semanticWeight: 0.55, keywordWeight: 0.35, categoryWeight: 0.1 };

// Synthesize a deterministic vectorScore + keywordScore per chunk so reranker
// math is fully reproducible (independent of any embedding model).
const SYNTH_BASELINE = {
  "preg-1":   { vectorScore: 0.20, keywordScore: 0.85 },
  "preg-2":   { vectorScore: 0.25, keywordScore: 0.80 },
  "gaba-1":   { vectorScore: 0.30, keywordScore: 0.55 },
  "alpr-1":   { vectorScore: 0.35, keywordScore: 0.50 },
  "dolo-1":   { vectorScore: 0.40, keywordScore: 0.45 },
  "neutral-1":{ vectorScore: 0.50, keywordScore: 0.20 },
};

const buildResults = (synth = SYNTH_BASELINE) =>
  CHUNKS.map((c) => ({
    id: c.id,
    text: c.text,
    metadata: c.metadata,
    vectorScore: synth[c.id].vectorScore,
    keywordScore: synth[c.id].keywordScore,
  }));

const PREGABALIN_SCOPE = {
  medicineName: "Pregabalin",
  genericName: "Pregabalin",
  aliases: ["Lyrica"],
  salts: ["Pregabalin"],
};

// ---------------------------------------------------------------------------
// 1. Property 4 parity — no scope leaves the reranker shape & order unchanged.
// ---------------------------------------------------------------------------
test("Property 4 — no scope: components shape & ordering match baseline", () => {
  const ranked = rerank("side effects", buildResults(), { ...PINNED_WEIGHTS });

  // (a) components keys are exactly {category, keyword, semantic} and sorted.
  for (const r of ranked) {
    assert.deepEqual(
      Object.keys(r.components).sort(),
      ["category", "keyword", "semantic"],
      "components shape changed when no medicineScope is supplied"
    );
    assert.equal(r.components.medicineMatch, undefined);
  }

  // (b) ordering is the deterministic semantic+keyword+category baseline.
  // Compute the baseline confidence inline (no medicineMatch) and assert the
  // ranked order matches a sort by that baseline.
  const baseline = buildResults().map((r) => {
    const semantic = 1 - r.vectorScore;
    const keyword = r.keywordScore;
    const conf = semantic * 0.55 + keyword * 0.35 + 0 * 0.1;
    return { id: r.id, conf: Math.max(0, Math.min(1, conf)) };
  });
  const baselineOrder = [...baseline]
    .sort((a, b) => b.conf - a.conf)
    .map((r) => r.id);
  const rankedOrder = ranked.map((r) => r.id);
  assert.deepEqual(rankedOrder, baselineOrder);

  // (c) confidence values match the baseline math.
  for (const r of ranked) {
    const expected = baseline.find((b) => b.id === r.id).conf;
    assert.ok(
      Math.abs(r.confidence - expected) < 1e-9,
      `confidence drift for ${r.id}: expected ${expected}, got ${r.confidence}`
    );
  }
});

test("overlapScore — sanity (preserved helper)", () => {
  assert.equal(overlapScore("fever child", "child has fever"), 1);
  assert.equal(overlapScore("", "anything"), 0);
});

// ---------------------------------------------------------------------------
// 2. medicineMatchScore — null / 0 / 1 / -1 contract.
// ---------------------------------------------------------------------------
test("medicineMatchScore — no scope returns null", () => {
  assert.equal(medicineMatchScore({ metadata: { medicine: "Pregabalin" } }, null), null);
  assert.equal(medicineMatchScore({ metadata: { medicine: "Pregabalin" } }, undefined), null);
});

test("medicineMatchScore — empty token set returns null", () => {
  // Scope object exists but yields zero usable tokens.
  assert.equal(medicineMatchScore({ metadata: { medicine: "Pregabalin" } }, {}), null);
  assert.equal(
    medicineMatchScore({ metadata: { medicine: "Pregabalin" } }, { aliases: [] }),
    null
  );
});

test("medicineMatchScore — neutral chunk returns 0 (no boost, no demote)", () => {
  // metadata.medicine/generic/alias all absent → candidates is [] → 0.
  assert.equal(medicineMatchScore({ metadata: {} }, PREGABALIN_SCOPE), 0);
  assert.equal(
    medicineMatchScore(
      { metadata: { medicine: null, generic: null, alias: null } },
      PREGABALIN_SCOPE
    ),
    0
  );
});

test("medicineMatchScore — matches by medicine, generic, or alias → 1", () => {
  assert.equal(
    medicineMatchScore({ metadata: { medicine: "Pregabalin" } }, PREGABALIN_SCOPE),
    1
  );
  assert.equal(
    medicineMatchScore({ metadata: { generic: "Pregabalin" } }, PREGABALIN_SCOPE),
    1
  );
  assert.equal(
    medicineMatchScore({ metadata: { alias: "Lyrica" } }, PREGABALIN_SCOPE),
    1
  );
});

test("medicineMatchScore — clear mismatch → -1", () => {
  assert.equal(
    medicineMatchScore({ metadata: { medicine: "Gabapentin" } }, PREGABALIN_SCOPE),
    -1
  );
  assert.equal(
    medicineMatchScore(
      { metadata: { medicine: "Alprazolam", generic: "Alprazolam" } },
      PREGABALIN_SCOPE
    ),
    -1
  );
});

// ---------------------------------------------------------------------------
// 3. rerank with Pregabalin scope — boost matches, drop clear mismatches.
// ---------------------------------------------------------------------------
test("Property 1 — rerank scoped to Pregabalin drops Gabapentin/Alprazolam/Dolo650", () => {
  // Synthesize scores so mismatched chunks fall below the drop threshold:
  //   semantic = 1 - 0.95 = 0.05; keyword = 0; category 0.
  //   baseConfidence = 0.05*0.55 + 0*0.35 + 0*0.1 = 0.0275
  //   demote: 0.0275 + (-1)*0.25 = -0.2225 → clamp to 0 → 0 < 0.2 → DROPPED.
  const synth = {
    "preg-1":   { vectorScore: 0.5, keywordScore: 0.5 }, // boosted match
    "preg-2":   { vectorScore: 0.6, keywordScore: 0.4 }, // boosted match
    "gaba-1":   { vectorScore: 0.95, keywordScore: 0.0 }, // demoted, dropped
    "alpr-1":   { vectorScore: 0.95, keywordScore: 0.0 }, // demoted, dropped
    "dolo-1":   { vectorScore: 0.95, keywordScore: 0.0 }, // demoted, dropped
    "neutral-1":{ vectorScore: 0.5, keywordScore: 0.3 },  // neutral, kept
  };

  const ranked = rerank("side effects", buildResults(synth), {
    ...PINNED_WEIGHTS,
    medicineScope: PREGABALIN_SCOPE,
    medicineWeight: 0.25,
    mismatchDropThreshold: 0.2,
  });

  const ids = ranked.map((r) => r.id);
  assert.ok(!ids.includes("gaba-1"), `Gabapentin chunk leaked: ${ids.join(",")}`);
  assert.ok(!ids.includes("alpr-1"), `Alprazolam chunk leaked: ${ids.join(",")}`);
  assert.ok(!ids.includes("dolo-1"), `Dolo650 chunk leaked: ${ids.join(",")}`);
  assert.ok(ids.includes("preg-1") && ids.includes("preg-2"));
  assert.ok(ids.includes("neutral-1"), "neutral chunk should be kept");

  // Pregabalin chunks rank top.
  assert.equal(ids[0], "preg-1");
  assert.equal(ids[1], "preg-2");

  // medicineMatch present in components (sorted: category, keyword, medicineMatch, semantic).
  for (const r of ranked) {
    assert.deepEqual(
      Object.keys(r.components).sort(),
      ["category", "keyword", "medicineMatch", "semantic"],
      `components missing medicineMatch for ${r.id}`
    );
  }
  // Pregabalin chunks tagged 1, neutral tagged 0.
  for (const r of ranked) {
    if (r.id.startsWith("preg-")) {
      assert.equal(r.components.medicineMatch, 1);
    } else if (r.id === "neutral-1") {
      assert.equal(r.components.medicineMatch, 0);
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Configurable weights — zero weight + zero floor → mismatches survive.
// ---------------------------------------------------------------------------
test("rerank — medicineWeight=0 + mismatchDropThreshold=0 keeps mismatches", () => {
  const synth = {
    "preg-1":   { vectorScore: 0.5, keywordScore: 0.5 },
    "preg-2":   { vectorScore: 0.6, keywordScore: 0.4 },
    "gaba-1":   { vectorScore: 0.95, keywordScore: 0.0 },
    "alpr-1":   { vectorScore: 0.95, keywordScore: 0.0 },
    "dolo-1":   { vectorScore: 0.95, keywordScore: 0.0 },
    "neutral-1":{ vectorScore: 0.5, keywordScore: 0.3 },
  };

  const ranked = rerank("side effects", buildResults(synth), {
    ...PINNED_WEIGHTS,
    medicineScope: PREGABALIN_SCOPE,
    medicineWeight: 0,
    mismatchDropThreshold: 0,
  });

  const ids = ranked.map((r) => r.id);
  // Nothing was dropped — mismatches survive when weight & floor are disabled.
  assert.equal(ids.length, 6);
  for (const id of ["preg-1", "preg-2", "gaba-1", "alpr-1", "dolo-1", "neutral-1"]) {
    assert.ok(ids.includes(id), `expected ${id} to survive, got ${ids.join(",")}`);
  }
});

// ---------------------------------------------------------------------------
// 5. Stable secondary ordering — ties on medicineMatch fall back to base math.
// ---------------------------------------------------------------------------
test("rerank — boosted chunks tie on medicineMatch → fall back to base ordering", () => {
  // Both Pregabalin chunks get medicineMatch=1 — relative ordering must come
  // from the (semantic+keyword+category) baseline. Make preg-2 strictly
  // beat preg-1 on the baseline and assert that ordering is preserved.
  const synth = {
    "preg-1":   { vectorScore: 0.6, keywordScore: 0.4 }, // base lower
    "preg-2":   { vectorScore: 0.2, keywordScore: 0.9 }, // base higher
    "gaba-1":   { vectorScore: 0.95, keywordScore: 0.0 },
    "alpr-1":   { vectorScore: 0.95, keywordScore: 0.0 },
    "dolo-1":   { vectorScore: 0.95, keywordScore: 0.0 },
    "neutral-1":{ vectorScore: 0.5, keywordScore: 0.2 },
  };
  const ranked = rerank("side effects", buildResults(synth), {
    ...PINNED_WEIGHTS,
    medicineScope: PREGABALIN_SCOPE,
    medicineWeight: 0.25,
    mismatchDropThreshold: 0.2,
  });
  const top2 = ranked.slice(0, 2).map((r) => r.id);
  assert.deepEqual(top2, ["preg-2", "preg-1"]);
});
