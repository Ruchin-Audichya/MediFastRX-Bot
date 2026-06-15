"use strict";

// Listener routing tests — verifies CareOps reacts to the SAME events MediFast
// already emits, and that the flagship family-shortage path fires when a family
// member is present on a failed lookup. Uses in-memory model mocks + a real
// EventEmitter (no Mongo, no network).

const test = require("node:test");
const assert = require("node:assert/strict");
const EventEmitter = require("events");

const { installCareOpsModelMocks } = require("./_mocks/fakeCareOpsModels");
const models = installCareOpsModelMocks();

const { registerCareOpsListener, __resetForTests } = require("../src/careops/careOpsListener");

const reset = async () => {
  await Promise.all([
    models.CareCase.deleteMany(),
    models.CareTask.deleteMany(),
    models.CareIncident.deleteMany(),
    models.CareWorkflow.deleteMany(),
    models.AgentAction.deleteMany(),
  ]);
};

// Allow the listener's async handlers (fire-and-forget) to settle.
const settle = () => new Promise((r) => setTimeout(r, 50));

test("search.completed → opens a medication continuity workflow", async () => {
  await reset();
  __resetForTests();
  const bus = new EventEmitter();
  registerCareOpsListener(bus);

  bus.emit("search.completed", {
    telegramId: "L1",
    topMedicineName: "Dolo 650",
    normalizedQuery: "dolo 650",
  });
  await settle();

  const workflows = await models.CareWorkflow.find().lean();
  assert.ok(
    workflows.some((w) => w.type === "medication_continuity"),
    "expected a medication_continuity workflow"
  );
});

test("medicine.lookup.failed WITH family member → flagship family shortage", async () => {
  await reset();
  __resetForTests();
  const bus = new EventEmitter();
  registerCareOpsListener(bus);

  bus.emit("medicine.lookup.failed", {
    telegramId: "L2",
    query: "Pregabalin",
    normalizedQuery: "pregabalin",
    familyMemberName: "Papa",
    relation: "father",
    suggestions: [],
  });
  await settle();

  const cases = await models.CareCase.find().lean();
  const incidents = await models.CareIncident.find().lean();
  assert.ok(cases.some((c) => c.category === "family_care" && c.subject.name === "Papa"));
  assert.ok(incidents.some((i) => i.category === "medicine_unavailable" && i.escalated === true));
});

test("medicine.lookup.failed WITHOUT family member → plain shortage", async () => {
  await reset();
  __resetForTests();
  const bus = new EventEmitter();
  registerCareOpsListener(bus);

  bus.emit("medicine.lookup.failed", {
    telegramId: "L3",
    query: "Mycophenolate",
    normalizedQuery: "mycophenolate",
    suggestions: [],
  });
  await settle();

  const cases = await models.CareCase.find().lean();
  assert.ok(cases.some((c) => c.category === "shortage"));
  assert.ok(!cases.some((c) => c.category === "family_care"));
});

test("medicine.lookup.failed with handledInline:true → listener skips (no duplicate)", async () => {
  await reset();
  __resetForTests();
  const bus = new EventEmitter();
  registerCareOpsListener(bus);

  bus.emit("medicine.lookup.failed", {
    telegramId: "L4",
    query: "Pregabalin",
    normalizedQuery: "pregabalin",
    familyMemberName: "Papa",
    relation: "father",
    suggestions: [],
    handledInline: true, // search handler already created the operation inline
  });
  await settle();

  // Listener must NOT create anything — avoids duplicate incidents/cases.
  const cases = await models.CareCase.find().lean();
  const incidents = await models.CareIncident.find().lean();
  assert.equal(cases.length, 0, "listener should skip when handledInline");
  assert.equal(incidents.length, 0, "listener should skip when handledInline");
});
