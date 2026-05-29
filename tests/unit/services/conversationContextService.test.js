"use strict";

// Unit tests for the refactored conversationContextService (task 4.1).
// Drives a stubbed `normalizeMedicineQuery` via the require-cache shim, and a
// fake clock via `t.mock.timers` for the TTL test. No Mongo, no network.
//
// **Validates: Requirements 2.4, 2.5, 2.7, 2.8**
//   - Property 2 (context retention across follow-ups)
//   - Property 3 (context switch on explicit new medicine)
//   - Expanded follow-up patterns
//   - TTL expiry returns null
//   - Backward-compatible return shape

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// IMPORTANT: env vars consumed at module load. Set BEFORE the require.
process.env.ACTIVE_CONTEXT_TTL_MS = "1000";
process.env.MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD = "0.6";

const { stubModule, REPO_ROOT } = require("../../_mocks/installShims");

// Programmable resolver — every test can drive a different resolution shape
// via `setNextResolution`. `resolverCalls` lets tests assert the resolver is
// (or isn't) invoked, which is critical for the "no active context" branch.
let nextResolution = { type: "unknown", confidence: 0 };
let resolverCalls = 0;
let resolverShouldThrow = false;

const setNextResolution = (resolution) => {
  nextResolution = resolution;
};
const resetResolver = () => {
  nextResolution = { type: "unknown", confidence: 0 };
  resolverCalls = 0;
  resolverShouldThrow = false;
};

stubModule("src/medicine/medicineNormalizer.js", {
  normalizeMedicineQuery: async () => {
    resolverCalls++;
    if (resolverShouldThrow) throw new Error("resolver boom");
    return nextResolution;
  },
});

const ccs = require(path.join(REPO_ROOT, "src/services/conversationContextService.js"));
const {
  setActiveMedicineContext,
  getActiveContext,
  resolveContextualQuery,
  clearActiveContext,
  getActiveMedicineScope,
} = ccs;

// Helpers ---------------------------------------------------------------------

const TG = "u";

const reset = () => {
  clearActiveContext(TG);
  resetResolver();
};

const setPregabalin = (overrides = {}) => {
  const aliases = overrides.aliases || [];
  return setActiveMedicineContext(TG, {
    resolution: {
      medicine: {
        _id: "preg-1",
        medicineName: "Pregabalin",
        genericName: "Pregabalin",
        aliases,
      },
      type: "medicine",
      confidence: overrides.confidence !== undefined ? overrides.confidence : 0.92,
      method: "test",
    },
  });
};

const ALLOWED_KEYS = new Set(["query", "usedContext", "context", "originalQuery"]);

// -----------------------------------------------------------------------------

test("conversationContextService — switch vs follow-up, TTL, return shape", async (t) => {
  await t.test("backward-compatible legacy setActiveMedicineContext shape", () => {
    reset();
    const ctx = setActiveMedicineContext(TG, {
      medicineName: "Modafinil",
      genericName: "Modafinil",
    });
    assert.ok(ctx, "expected ctx to be returned for legacy shape");
    assert.equal(Object.isFrozen(ctx), true);
    assert.equal(ctx.medicineName, "Modafinil");
    assert.equal(ctx.genericName, "Modafinil");
    assert.equal(ctx.confidence, 0.95);
    assert.equal(ctx.activeStatus, "active");

    const fetched = getActiveContext(TG);
    assert.equal(fetched.medicineName, "Modafinil");
  });

  await t.test("resolution-shape setActiveMedicineContext carries aliases", () => {
    reset();
    const ctx = setActiveMedicineContext(TG, {
      resolution: {
        medicine: {
          _id: "x",
          medicineName: "Pregabalin",
          genericName: "Pregabalin",
          aliases: ["Lyrica"],
        },
        type: "medicine",
        confidence: 0.92,
        method: "test",
      },
    });
    assert.ok(ctx);
    assert.equal(ctx.medicineName, "Pregabalin");
    assert.deepEqual(ctx.aliases, ["Lyrica"]);
    const fetched = getActiveContext(TG);
    assert.deepEqual(fetched.aliases, ["Lyrica"]);
  });

  await t.test("empty/invalid payloads return null and store nothing", () => {
    reset();
    assert.equal(setActiveMedicineContext(TG, {}), null);
    assert.equal(setActiveMedicineContext(null, { medicineName: "X" }), null);
    assert.equal(getActiveContext(TG), null);
  });

  await t.test("resolveContextualQuery synchronous fast-path for empty/whitespace", async () => {
    reset();
    const r1 = await resolveContextualQuery(TG, "");
    const r2 = await resolveContextualQuery(TG, "   ");
    const r3 = await resolveContextualQuery(TG, null);
    const r4 = await resolveContextualQuery(TG, undefined);
    for (const r of [r1, r2, r3, r4]) {
      assert.equal(r.usedContext, false);
      assert.equal(r.context, null);
    }
    assert.equal(resolverCalls, 0, "resolver MUST NOT be called for empty input");
  });

  await t.test("no active context — preservation: pass-through, resolver NOT called", async () => {
    reset();
    const inputs = ["bukhar ki tablet", "papa BP tablet", "hi", "side effects"];
    for (const text of inputs) {
      const r = await resolveContextualQuery(TG, text);
      assert.deepEqual(
        r,
        { query: text, usedContext: false, context: null },
        `expected pass-through for input "${text}"`,
      );
    }
    assert.equal(
      resolverCalls,
      0,
      "no-active-context branch MUST NOT call the deterministic resolver (Mongo I/O guard)",
    );
  });

  // Property 2 — retention -----------------------------------------------------
  await t.test("Property 2 — context retention across expanded follow-ups", async () => {
    reset();
    setPregabalin();
    setNextResolution({ type: "unknown", confidence: 0 }); // no switch

    const cases = [
      ["side effects", "side effects of Pregabalin"],
      ["can I take it daily?", "dosage of Pregabalin"],
      ["alternatives", "alternatives of Pregabalin"],
      ["what is the generic?", "generic name of Pregabalin"],
      ["interactions with alcohol", "interactions of Pregabalin"],
      ["precautions", "precautions for Pregabalin"],
      ["can my father use it?", "Pregabalin for that family member"],
      ["how often should I take it", "dosage of Pregabalin"],
      ["salt name", "generic name of Pregabalin"],
      ["pharmacy near me", "Pregabalin near me"],
      ["what does it do?", "what is Pregabalin used for"],
      ["it", "what is Pregabalin used for"],
    ];

    for (const [input, expected] of cases) {
      const r = await resolveContextualQuery(TG, input);
      assert.equal(
        r.usedContext,
        true,
        `usedContext should be true for follow-up "${input}", got ${JSON.stringify(r)}`,
      );
      assert.ok(
        String(r.query).toLowerCase().includes("pregabalin"),
        `rewritten query should mention Pregabalin for "${input}", got "${r.query}"`,
      );
      assert.equal(r.query, expected, `template mismatch for "${input}"`);
      assert.equal(r.originalQuery, input);
      assert.ok(r.context && r.context.medicineName === "Pregabalin");
    }
  });

  // Property 3 — switch --------------------------------------------------------
  await t.test(
    "Property 3 — explicit high-conf new medicine signals switch (does NOT mutate store)",
    async () => {
      reset();
      setPregabalin();
      setNextResolution({
        type: "medicine",
        confidence: 0.9,
        medicine: { medicineName: "Dolo650", genericName: "Paracetamol" },
      });

      const r = await resolveContextualQuery(TG, "Now tell me about Dolo650");
      assert.equal(r.usedContext, false);
      assert.equal(r.context, null);
      // Service contract: we SIGNAL a switch but do NOT auto-update storage.
      // search.js handles setActiveMedicineContext after a successful search.
      const stored = getActiveContext(TG);
      assert.ok(stored, "active context should still exist after switch signal");
      assert.equal(stored.medicineName, "Pregabalin");
    },
  );

  await t.test("switch confidence gate — low-conf resolution treated as follow-up", async () => {
    reset();
    setPregabalin();
    setNextResolution({
      type: "medicine",
      confidence: 0.4, // below threshold 0.6
      medicine: { medicineName: "Dolo650", genericName: "Paracetamol" },
    });

    const r = await resolveContextualQuery(TG, "side effects");
    assert.equal(r.usedContext, true);
    assert.ok(String(r.query).toLowerCase().includes("pregabalin"));
    assert.equal(r.query, "side effects of Pregabalin");
  });

  await t.test("same-identity resolution does NOT trigger switch", async () => {
    reset();
    setPregabalin({ aliases: ["Lyrica"] });
    setNextResolution({
      type: "medicine",
      confidence: 0.9,
      medicine: { medicineName: "Lyrica", genericName: "Pregabalin" },
    });

    const r = await resolveContextualQuery(TG, "Lyrica side effects");
    assert.equal(r.usedContext, true);
    assert.ok(String(r.query).toLowerCase().includes("pregabalin"));
  });

  // TTL expiry under fake clock -----------------------------------------------
  await t.test("TTL expiry returns null and deletes the entry", async (sub) => {
    reset();
    sub.mock.timers.enable({ apis: ["Date"] });
    try {
      const ctx = setPregabalin();
      assert.ok(ctx);
      assert.ok(getActiveContext(TG), "context should be fresh at t=0");

      sub.mock.timers.tick(2000); // TTL = 1000ms in test env
      assert.equal(getActiveContext(TG), null, "expired entry should return null");
      // A subsequent read should still be null — entry has been deleted, not just hidden.
      assert.equal(getActiveContext(TG), null);
    } finally {
      sub.mock.timers.reset();
    }
  });

  // Return shape contract ------------------------------------------------------
  await t.test("backward-compatible return shape across all branches", async () => {
    reset();

    const checkShape = (r, label) => {
      const keys = Object.keys(r);
      assert.ok(
        keys.includes("query") && keys.includes("usedContext") && keys.includes("context"),
        `${label}: missing required keys, got ${JSON.stringify(keys)}`,
      );
      for (const key of keys) {
        assert.ok(
          ALLOWED_KEYS.has(key),
          `${label}: unexpected key "${key}" in result`,
        );
      }
    };

    // 1. Empty
    checkShape(await resolveContextualQuery(TG, ""), "empty");
    // 2. No active context
    checkShape(await resolveContextualQuery(TG, "hi"), "no-context");
    // 3. Active + follow-up match
    setPregabalin();
    setNextResolution({ type: "unknown", confidence: 0 });
    checkShape(await resolveContextualQuery(TG, "side effects"), "follow-up");
    // 4. Active + no follow-up match
    checkShape(await resolveContextualQuery(TG, "random unrelated text xyz"), "no-match");
    // 5. Active + switch signal
    setNextResolution({
      type: "medicine",
      confidence: 0.9,
      medicine: { medicineName: "Dolo650" },
    });
    checkShape(await resolveContextualQuery(TG, "Dolo650"), "switch");
  });

  await t.test("clearActiveContext removes the entry", () => {
    reset();
    setPregabalin();
    assert.ok(getActiveContext(TG));
    assert.equal(clearActiveContext(TG), true);
    assert.equal(getActiveContext(TG), null);
    // Clearing an already-empty entry returns false.
    assert.equal(clearActiveContext(TG), false);
  });

  await t.test("resolver throwing is swallowed; treated as follow-up", async () => {
    reset();
    setPregabalin();
    resolverShouldThrow = true;
    const r = await resolveContextualQuery(TG, "side effects");
    assert.equal(r.usedContext, true);
    assert.ok(String(r.query).toLowerCase().includes("pregabalin"));
    assert.equal(r.query, "side effects of Pregabalin");
  });

  await t.test("getActiveMedicineScope returns scope shape and null for unknown user", () => {
    reset();
    setPregabalin({ aliases: ["Lyrica"] });
    const scope = getActiveMedicineScope(TG);
    assert.ok(scope);
    assert.deepEqual(Object.keys(scope), [
      "medicineName",
      "genericName",
      "aliases",
      "salts",
      "category",
    ]);
    assert.equal(scope.medicineName, "Pregabalin");
    assert.equal(scope.genericName, "Pregabalin");
    assert.deepEqual(scope.aliases, ["Lyrica"]);

    assert.equal(getActiveMedicineScope("nobody"), null);
  });
});
