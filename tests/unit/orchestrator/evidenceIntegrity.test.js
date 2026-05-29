"use strict";

/**
 * Task 6.3 — unit tests for the evidence integrity guard.
 *
 *   Validates: belongs-vs-contaminated classification (RAG, alternative,
 *   relationship), allowed relationship preservation, explicit multi-medicine
 *   bypass (3.6), no-op pass-through when no active medicine (Property 4),
 *   contamination report shape, droppedExamples cap, mergeReports semantics,
 *   and end-to-end wiring through `collectEvidence` (Sequence A).
 *
 * **Validates: Requirements 2.6, 3.1, 3.2, 3.6**
 *
 * Pure tests — no Mongo, no LLM, no network. The active MedicineContext is
 * built via the production `createMedicineContext` so the shape is identical
 * to what the orchestrator produces in flight.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  validateEvidence,
  mergeReports,
  ALLOWED_GRAPH_TYPES,
} = require("../../../src/orchestrator/evidenceIntegrity");
const { createMedicineContext } = require("../../../src/context/medicineContext");
const { collectEvidence } = require("../../../src/orchestrator/evidenceCollector");
const { CHUNKS } = require("../../_mocks/fakeKnowledgeBase");

const NOW = 1_700_000_000_000;

const buildPregabalinContext = () =>
  createMedicineContext({
    resolution: {
      medicine: {
        _id: "med-pregabalin",
        medicineName: "Pregabalin",
        genericName: "Pregabalin",
        aliases: ["Lyrica"],
        salts: ["Pregabalin"],
        brands: ["Lyrica"],
        category: "neuropathic_pain",
      },
      confidence: 0.92,
      method: "direct knowledge match",
    },
    conversationId: "tg-1",
    userId: "tg-1",
    now: NOW,
  });

const PREG_CHUNK = {
  text: "Pregabalin causes dizziness.",
  metadata: { medicine: "Pregabalin", generic: "Pregabalin", alias: null },
};
const LYRICA_CHUNK = {
  text: "Lyrica side effects.",
  metadata: { medicine: null, generic: null, alias: "Lyrica" },
};
const GABA_CHUNK = {
  text: "Gabapentin side effects.",
  metadata: { medicine: "Gabapentin", generic: "Gabapentin", alias: null },
};
const NEUTRAL_CHUNK = {
  text: "General guideline.",
  metadata: { medicine: null, generic: null, alias: null },
};

const allBelong = (items) => items.every((i) => i.belongsToActiveMedicine === true);

test("evidenceIntegrity — validateEvidence and mergeReports", async (t) => {
  await t.test("Property 4 — no active medicine is a no-op pass-through (rag default)", () => {
    const result = validateEvidence({ items: [PREG_CHUNK, GABA_CHUNK], activeMedicine: null });
    assert.equal(result.kept.length, 2);
    assert.ok(allBelong(result.kept));
    assert.deepEqual(result.dropped, []);
    assert.deepEqual(result.report, {
      total: 2,
      kept: 2,
      dropped: 0,
      downWeighted: 0,
      activeMedicine: null,
      droppedExamples: [],
      itemKind: "rag",
    });
  });

  await t.test("inactive (expired) activeMedicine yields the same no-op shape", () => {
    const expired = { ...buildPregabalinContext(), activeStatus: "expired" };
    const result = validateEvidence({
      items: [PREG_CHUNK, GABA_CHUNK],
      activeMedicine: expired,
      itemKind: "rag",
    });
    assert.equal(result.kept.length, 2);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.report.dropped, 0);
    assert.equal(result.report.downWeighted, 0);
    assert.equal(result.report.activeMedicine, null);
    assert.deepEqual(result.report.droppedExamples, []);
    assert.ok(allBelong(result.kept));
  });

  await t.test("RAG kind — belongs by metadata.medicine / generic / alias", () => {
    const ctx = buildPregabalinContext();
    const result = validateEvidence({
      items: [PREG_CHUNK, LYRICA_CHUNK, GABA_CHUNK, NEUTRAL_CHUNK],
      activeMedicine: ctx,
    });

    assert.equal(result.kept.length, 3, "Pregabalin + Lyrica + neutral pass through");
    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0].metadata.medicine, "Gabapentin");
    assert.ok(allBelong(result.kept));

    assert.equal(result.report.total, 4);
    assert.equal(result.report.kept, 3);
    assert.equal(result.report.dropped, 1);
    assert.equal(result.report.downWeighted, 0);
    assert.deepEqual(result.report.activeMedicine, {
      medicineName: "Pregabalin",
      genericName: "Pregabalin",
    });
    assert.equal(result.report.droppedExamples.length, 1);
    assert.equal(result.report.droppedExamples[0].medicine, "Gabapentin");
    assert.equal(result.report.itemKind, "rag");
  });

  await t.test("explicit multi-medicine bypass (3.6)", () => {
    const ctx = buildPregabalinContext();
    const result = validateEvidence({
      items: [PREG_CHUNK, GABA_CHUNK],
      activeMedicine: ctx,
      explicitMedicines: ["Gabapentin"],
    });

    assert.equal(result.kept.length, 2);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.report.dropped, 0);
    assert.equal(result.report.kept, 2);

    const gaba = result.kept.find((i) => i.metadata?.medicine === "Gabapentin");
    assert.ok(gaba);
    assert.equal(gaba.explicitlyRequested, true);
    assert.equal(gaba.belongsToActiveMedicine, false);
    const preg = result.kept.find((i) => i.metadata?.medicine === "Pregabalin");
    assert.equal(preg.belongsToActiveMedicine, true);
    assert.equal(preg.explicitlyRequested || false, false);
  });

  await t.test("relationship kind — only allowed types preserved", () => {
    const ctx = buildPregabalinContext();
    const result = validateEvidence({
      items: [
        { type: "same_generic", from: "Pregabalin", to: "Lyrica" },
        { type: "alternative", from: "Pregabalin", to: "Gabapentin" },
        { type: "competitor", from: "Pregabalin", to: "X" },
        { type: null, from: "Pregabalin", to: "Y" },
      ],
      activeMedicine: ctx,
      allowedRelationships: ALLOWED_GRAPH_TYPES,
      itemKind: "relationship",
    });

    assert.equal(result.kept.length, 2);
    assert.equal(result.dropped.length, 2);
    assert.deepEqual(result.kept.map((r) => r.type).sort(), ["alternative", "same_generic"]);
    const droppedTypes = result.dropped.map((r) => r.type ?? null);
    assert.ok(droppedTypes.includes("competitor"));
    assert.ok(droppedTypes.includes(null));
    assert.equal(result.report.itemKind, "relationship");
    assert.equal(result.report.dropped, 2);
    assert.equal(result.report.kept, 2);
    assert.equal(result.report.total, 4);
  });

  await t.test("relationship kind — null allowedRelationships keeps all", () => {
    const ctx = buildPregabalinContext();
    const result = validateEvidence({
      items: [
        { type: "same_generic", from: "Pregabalin", to: "Lyrica" },
        { type: "competitor", from: "Pregabalin", to: "X" },
        { type: "wibble", from: "Pregabalin", to: "Y" },
      ],
      activeMedicine: ctx,
      allowedRelationships: null,
      itemKind: "relationship",
    });
    assert.equal(result.kept.length, 3);
    assert.equal(result.dropped.length, 0);
    assert.equal(result.report.dropped, 0);
  });

  await t.test("alternative kind — alias match kept, foreign dropped", () => {
    const ctx = buildPregabalinContext();
    const result = validateEvidence({
      items: [
        { medicineName: "Lyrica", metadata: { alias: "Lyrica" } },
        { medicineName: "Gabapentin", metadata: { medicine: "Gabapentin", generic: "Gabapentin" } },
      ],
      activeMedicine: ctx,
      itemKind: "alternative",
    });
    assert.equal(result.kept.length, 1);
    assert.equal(result.kept[0].medicineName, "Lyrica");
    assert.equal(result.kept[0].belongsToActiveMedicine, true);
    assert.equal(result.dropped.length, 1);
    assert.equal(result.dropped[0].medicineName, "Gabapentin");
    assert.equal(result.report.itemKind, "alternative");
    assert.equal(result.report.kept, 1);
    assert.equal(result.report.dropped, 1);
    assert.equal(result.report.total, 2);
  });

  await t.test("droppedExamples cap at 5 even when many drops occur", () => {
    const ctx = buildPregabalinContext();
    const items = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((a) => ({
      text: `Gabapentin variant ${a}`,
      metadata: { medicine: "Gabapentin", generic: "Gabapentin", alias: a },
    }));
    const result = validateEvidence({ items, activeMedicine: ctx, itemKind: "rag" });
    assert.equal(result.report.dropped, 10);
    assert.equal(result.report.droppedExamples.length, 5);
    for (const ex of result.report.droppedExamples) {
      assert.equal(ex.medicine, "Gabapentin");
      assert.ok(ex.reason && typeof ex.reason === "string");
    }
  });

  await t.test("Property 4 alias parity — null/inactive ctx ignores metadata content", () => {
    const itemsForeign = [
      { metadata: { medicine: "Gabapentin", generic: "Gabapentin", alias: null } },
      { metadata: { medicine: "Alprazolam", generic: "Alprazolam", alias: null } },
    ];

    const nullResult = validateEvidence({ items: itemsForeign, activeMedicine: null });
    assert.equal(nullResult.kept.length, 2);
    assert.equal(nullResult.dropped.length, 0);
    assert.ok(allBelong(nullResult.kept));

    const inactiveCtx = { ...buildPregabalinContext(), activeStatus: "expired" };
    const inactiveResult = validateEvidence({ items: itemsForeign, activeMedicine: inactiveCtx });
    assert.equal(inactiveResult.kept.length, 2);
    assert.equal(inactiveResult.dropped.length, 0);
    assert.ok(allBelong(inactiveResult.kept));
  });

  await t.test("mergeReports sums totals, carries byKind, and caps droppedExamples", () => {
    const ctx = buildPregabalinContext();
    const ragRep = validateEvidence({
      items: [PREG_CHUNK, GABA_CHUNK],
      activeMedicine: ctx,
      itemKind: "rag",
    }).report;
    const altRep = validateEvidence({
      items: [
        { metadata: { alias: "Lyrica" } },
        { metadata: { medicine: "Gabapentin" } },
      ],
      activeMedicine: ctx,
      itemKind: "alternative",
    }).report;
    const relRep = validateEvidence({
      items: [
        { type: "same_generic", from: "Pregabalin", to: "Lyrica" },
        { type: "competitor", from: "Pregabalin", to: "X" },
      ],
      activeMedicine: ctx,
      allowedRelationships: ALLOWED_GRAPH_TYPES,
      itemKind: "relationship",
    }).report;

    const merged = mergeReports(ragRep, altRep, relRep);
    assert.equal(merged.total, ragRep.total + altRep.total + relRep.total);
    assert.equal(merged.kept, ragRep.kept + altRep.kept + relRep.kept);
    assert.equal(merged.dropped, ragRep.dropped + altRep.dropped + relRep.dropped);
    assert.deepEqual(merged.activeMedicine, {
      medicineName: "Pregabalin",
      genericName: "Pregabalin",
    });
    assert.ok(merged.byKind.rag && merged.byKind.alternative && merged.byKind.relationship);
    assert.equal(merged.byKind.rag.dropped, 1);
    assert.equal(merged.byKind.alternative.dropped, 1);
    assert.equal(merged.byKind.relationship.dropped, 1);

    // Cap holds even when inputs sum to more than 5 examples.
    const wide = validateEvidence({
      items: Array.from({ length: 6 }, (_, i) => ({
        metadata: { medicine: "Gabapentin", alias: `g${i}` },
      })),
      activeMedicine: ctx,
      itemKind: "rag",
    }).report;
    assert.equal(mergeReports(wide, wide).droppedExamples.length, 5);
  });

  await t.test("Sequence A — collectEvidence excludes contaminated CHUNKS for Pregabalin", () => {
    const ctx = buildPregabalinContext();
    const evidence = collectEvidence({
      query: "side effects of Pregabalin",
      plan: { entities: { medicine: "Pregabalin" }, routes: [{ tool: "knowledge", confidence: 0.9 }] },
      toolResults: {
        knowledge: { ok: true, value: { context: CHUNKS, sources: [], confidence: 0.7 } },
      },
      activeMedicine: ctx,
    });

    const surfaced = evidence.ragContext.context.map((c) => c.medicine);
    assert.ok(!surfaced.includes("Gabapentin"), "Gabapentin must not surface");
    assert.ok(!surfaced.includes("Alprazolam"), "Alprazolam must not surface");
    assert.ok(!surfaced.includes("Dolo650"), "Dolo650 must not surface");

    const contamination = evidence.ragContext.contamination;
    assert.ok(contamination, "contamination report attached");
    assert.ok(contamination.dropped >= 1, "at least one item dropped");
    assert.ok(contamination.byKind?.rag?.dropped >= 1, "byKind.rag.dropped must reflect contamination");
    assert.deepEqual(contamination.activeMedicine, {
      medicineName: "Pregabalin",
      genericName: "Pregabalin",
    });
  });

  await t.test("Sequence A preservation — no activeMedicine keeps all CHUNKS", () => {
    const evidence = collectEvidence({
      query: "side effects",
      plan: { entities: {}, routes: [] },
      toolResults: {
        knowledge: { ok: true, value: { context: CHUNKS, sources: [], confidence: 0.7 } },
      },
      activeMedicine: null,
    });

    assert.equal(evidence.ragContext.contamination.dropped, 0);
    assert.equal(evidence.ragContext.contamination.activeMedicine, null);
    // compactRag slices to 5 — fakeKnowledgeBase has 6 chunks; no integrity-driven drop must occur.
    assert.equal(evidence.ragContext.context.length, Math.min(CHUNKS.length, 5));
    for (const item of evidence.ragContext.context) {
      assert.equal(item.belongsToActiveMedicine, true);
    }
    assert.ok(evidence.ragContext.context.length > 0, "unscoped result must include items");
  });
});
