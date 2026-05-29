"use strict";

// Unit tests for the canonical MedicineContext model and helpers.
// Validates: Requirements 2.1, 2.8 (Property 6 idempotency).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMedicineContext,
  getMedicineScope,
  isFresh,
  withEnrichment,
  belongsToActiveMedicine,
} = require("../../../src/context/medicineContext");

const NOW = 1_700_000_000_000;

const buildResolution = (overrides = {}) => ({
  medicine: {
    _id: "med-001",
    medicineName: "Pregabalin",
    genericName: "Pregabalin",
    aliases: ["Lyrica", "  lyrica  ", "PREGEB", "pregeb"],
    salts: ["Pregabalin", "pregabalin"],
    brands: ["Lyrica", "Nuropil"],
    category: "Neuropathic-Pain",
  },
  confidence: 0.92,
  method: "direct knowledge match",
  reason: "exact alias",
  relationships: Array.from({ length: 12 }, (_, i) => ({
    type: "same_generic",
    from: "Pregabalin",
    to: `Rel-${i}`,
    confidence: 0.5,
  })),
  ...overrides,
});

test("MedicineContext factory and helpers", async (t) => {
  await t.test("factory field mapping (16 keys, order, contract)", () => {
    const ctx = createMedicineContext({
      resolution: buildResolution(),
      conversationId: "tg-42",
      userId: "tg-42",
      now: NOW,
    });

    assert.deepEqual(Object.keys(ctx), [
      "medicineId",
      "medicineName",
      "genericName",
      "aliases",
      "salts",
      "category",
      "brands",
      "graphRelationships",
      "confidence",
      "source",
      "timestamp",
      "updatedAt",
      "conversationId",
      "userId",
      "activeStatus",
      "enrichment",
    ]);

    assert.equal(ctx.medicineId, "med-001");
    assert.equal(ctx.medicineName, "Pregabalin");
    assert.equal(ctx.genericName, "Pregabalin");
    assert.deepEqual(ctx.aliases, ["Lyrica", "PREGEB"]);
    assert.deepEqual(ctx.salts, ["Pregabalin"]);
    assert.deepEqual(ctx.brands, ["Lyrica", "Nuropil"]);
    assert.equal(ctx.category, "neuropathic-pain");
    assert.equal(ctx.graphRelationships.length, 10);
    assert.equal(ctx.source, "direct knowledge match");
    assert.equal(ctx.timestamp, NOW);
    assert.equal(ctx.updatedAt, NOW);
    assert.equal(ctx.activeStatus, "active");
    assert.deepEqual(ctx.enrichment, {
      inventory: null,
      forecast: null,
      substitutes: null,
      pharmacies: null,
    });

    // Fallthroughs for medicineName / genericName / source / category.
    const ctxFallthrough = createMedicineContext({
      resolution: {
        medicine: { _id: "x", genericName: "Paracetamol" },
        normalizedQuery: "paracetamol-q",
        confidence: 0.7,
        reason: "fallback-reason",
      },
      now: NOW,
    });
    assert.equal(ctxFallthrough.medicineName, "Paracetamol");
    assert.equal(ctxFallthrough.genericName, "Paracetamol");
    assert.equal(ctxFallthrough.source, "fallback-reason");
    assert.equal(ctxFallthrough.category, null);

    const ctxUnknown = createMedicineContext({
      resolution: { medicine: {}, normalizedQuery: "x" },
      now: NOW,
    });
    assert.equal(ctxUnknown.source, "unknown");

    // Confidence clamp [0,1].
    const lo = createMedicineContext({ resolution: buildResolution({ confidence: -0.5 }), now: NOW });
    const hi = createMedicineContext({ resolution: buildResolution({ confidence: 1.5 }), now: NOW });
    assert.equal(lo.confidence, 0);
    assert.equal(hi.confidence, 1);
  });

  await t.test("factory throws on null resolution", () => {
    assert.throws(() => createMedicineContext({ resolution: null }), TypeError);
    assert.throws(() => createMedicineContext({}), TypeError);
  });

  await t.test("returned context is deeply frozen", () => {
    const ctx = createMedicineContext({ resolution: buildResolution(), now: NOW });
    assert.equal(Object.isFrozen(ctx), true);
    assert.equal(Object.isFrozen(ctx.aliases), true);
    assert.throws(() => {
      ctx.aliases.push("X");
    }, TypeError);
    assert.throws(() => {
      ctx.medicineName = "Other";
    }, TypeError);
  });

  await t.test("getMedicineScope shape and clone semantics", () => {
    const ctx = createMedicineContext({ resolution: buildResolution(), now: NOW });
    const scope = getMedicineScope(ctx);
    assert.deepEqual(Object.keys(scope), [
      "medicineName",
      "genericName",
      "aliases",
      "salts",
      "category",
    ]);
    assert.deepEqual(scope.aliases, ctx.aliases.slice());
    assert.deepEqual(scope.salts, ctx.salts.slice());

    // Mutating the scope arrays must not mutate the underlying ctx.
    scope.aliases.push("MUT");
    scope.salts.push("MUT");
    assert.equal(ctx.aliases.includes("MUT"), false);
    assert.equal(ctx.salts.includes("MUT"), false);

    assert.equal(getMedicineScope(null), null);
    assert.equal(getMedicineScope({ ...ctx, activeStatus: "expired" }), null);
  });

  await t.test("isFresh TTL window", () => {
    const ctx = createMedicineContext({ resolution: buildResolution(), now: NOW });
    assert.equal(isFresh(ctx, 1000, NOW + 500), true);
    assert.equal(isFresh(ctx, 1000, NOW + 1500), false);
    assert.equal(isFresh(null, 1000, NOW), false);
    // Non-active object pass-through returns false.
    assert.equal(isFresh({ ...ctx, activeStatus: "expired" }, 1000, NOW), false);
    // Malformed inputs.
    assert.equal(isFresh(ctx, NaN, NOW), false);
    assert.equal(isFresh(ctx, 1000, NaN), false);
  });

  await t.test("withEnrichment immutability and merge semantics", () => {
    const ctx = createMedicineContext({ resolution: buildResolution(), now: NOW });
    const inventory = { items: [{ sku: "A1", qty: 3 }] };
    const next = withEnrichment(
      ctx,
      { inventory, ignoredKey: "should-not-appear" },
      NOW + 5000,
    );

    assert.notEqual(next, ctx);
    assert.equal(ctx.enrichment.inventory, null);
    assert.deepEqual(next.enrichment.inventory, inventory);
    assert.equal(next.enrichment.forecast, null);
    assert.equal(Object.prototype.hasOwnProperty.call(next.enrichment, "ignoredKey"), false);

    // Time bumping.
    assert.equal(next.timestamp, ctx.timestamp);
    assert.equal(next.updatedAt, NOW + 5000);

    // Arrays cloned (different refs, equal content).
    assert.deepEqual(next.aliases, ctx.aliases);
    assert.notEqual(next.aliases, ctx.aliases);
    assert.deepEqual(next.salts, ctx.salts);
    assert.notEqual(next.salts, ctx.salts);
    assert.deepEqual(next.brands, ctx.brands);
    assert.notEqual(next.brands, ctx.brands);
  });

  await t.test("belongsToActiveMedicine matching", () => {
    const ctx = createMedicineContext({ resolution: buildResolution(), now: NOW });

    // Match by medicine (case-insensitive).
    assert.equal(belongsToActiveMedicine(ctx, { metadata: { medicine: "PREGABALIN" } }), true);
    // Match by generic.
    assert.equal(belongsToActiveMedicine(ctx, { metadata: { generic: "pregabalin" } }), true);
    // Match by alias.
    assert.equal(belongsToActiveMedicine(ctx, { metadata: { alias: "lyrica" } }), true);
    // Foreign medicine — mismatch.
    assert.equal(belongsToActiveMedicine(ctx, { metadata: { medicine: "Gabapentin" } }), false);
    // Neutral chunk (all medicine-identity fields null) — pass through.
    assert.equal(
      belongsToActiveMedicine(ctx, { metadata: { medicine: null, generic: null, alias: null } }),
      true,
    );
    // No-op when ctx is null or inactive.
    assert.equal(belongsToActiveMedicine(null, { metadata: { medicine: "Gabapentin" } }), true);
    assert.equal(
      belongsToActiveMedicine({ ...ctx, activeStatus: "expired" }, { metadata: { medicine: "Gabapentin" } }),
      true,
    );
    // Flat metadata-like shape (no nested `metadata`).
    assert.equal(belongsToActiveMedicine(ctx, { medicine: "Pregabalin" }), true);
    assert.equal(belongsToActiveMedicine(ctx, { generic: "Pregabalin" }), true);
    assert.equal(belongsToActiveMedicine(ctx, { alias: "Lyrica" }), true);
    assert.equal(belongsToActiveMedicine(ctx, { medicine: "Gabapentin" }), false);
  });

  await t.test("Property 6 — idempotent factory under fixed clock", () => {
    // Validates: Requirements 2.8.
    const resolution = buildResolution();
    const ctxA = createMedicineContext({
      resolution,
      conversationId: "tg-1",
      userId: "tg-1",
      now: NOW,
    });
    const ctxB = createMedicineContext({
      resolution,
      conversationId: "tg-1",
      userId: "tg-1",
      now: NOW,
    });
    assert.deepEqual(ctxA, ctxB);

    // Factory must clone array inputs — mutating source after construction
    // does not bleed into the produced context.
    resolution.medicine.aliases.push("LATE");
    resolution.medicine.salts.push("LATE");
    resolution.medicine.brands.push("LATE");
    resolution.relationships.push({ type: "x", from: "y", to: "z", confidence: 1 });
    assert.equal(ctxA.aliases.includes("LATE"), false);
    assert.equal(ctxA.salts.includes("LATE"), false);
    assert.equal(ctxA.brands.includes("LATE"), false);
    assert.equal(ctxA.graphRelationships.length, 10);
  });
});
