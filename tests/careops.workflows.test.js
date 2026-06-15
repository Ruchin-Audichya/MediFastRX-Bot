"use strict";

// Integration tests for the CareOps workflow engine + service, driven against
// in-memory model mocks (no MongoDB). Validates that each workflow produces the
// right domain records, status transitions, escalation, and AgentAction trail.

const test = require("node:test");
const assert = require("node:assert/strict");

// Install model mocks BEFORE requiring the service/engine.
const { installCareOpsModelMocks } = require("./_mocks/fakeCareOpsModels");
const models = installCareOpsModelMocks();

const engine = require("../src/careops/workflowEngine");
const svc = require("../src/careops/careOpsService");

const reset = async () => {
  await Promise.all([
    models.CareCase.deleteMany(),
    models.CareTask.deleteMany(),
    models.CareIncident.deleteMany(),
    models.CareWorkflow.deleteMany(),
    models.AgentAction.deleteMany(),
  ]);
};

test("Medication Continuity workflow creates case + workflow + task and resolves when pharmacy found", async () => {
  await reset();
  const out = await engine.runMedicationContinuity({
    telegramId: "u1",
    medicine: { medicineName: "Dolo 650", genericName: "Paracetamol" },
    pharmacyFound: true,
    pharmacyName: "Apollo",
  });
  assert.ok(out.careCase.caseNumber.startsWith("CASE"));
  assert.equal(out.careCase.category, "medication_continuity");
  assert.ok(out.workflow.workflowNumber.startsWith("WF"));
  assert.equal(out.workflow.type, "medication_continuity");
  assert.equal(out.workflow.status, "resolved");
  // All steps resolved.
  assert.ok(out.workflow.steps.every((s) => s.status === "done" || s.status === "skipped"));
  // Task created and completed.
  assert.equal(out.task.taskNumber.startsWith("TASK"), true);
  // AgentActions recorded.
  const actions = await models.AgentAction.find().lean();
  assert.ok(actions.some((a) => a.type === "case_opened"));
  assert.ok(actions.some((a) => a.type === "workflow_started"));
  assert.ok(actions.some((a) => a.type === "workflow_resolved"));
});

test("Medicine Shortage with no alternatives raises + escalates an incident", async () => {
  await reset();
  const out = await engine.runMedicineShortage({
    telegramId: "u2",
    medicine: { medicineName: "Mycophenolate" },
    query: "Mycophenolate",
    reason: "medicine_not_found",
    alternatives: [],
  });
  assert.ok(out.incident.incidentNumber.startsWith("INC"));
  assert.equal(out.incident.status, "escalated");
  assert.equal(out.incident.escalated, true);
  const actions = await models.AgentAction.find().lean();
  assert.ok(actions.some((a) => a.type === "incident_opened"));
  assert.ok(actions.some((a) => a.type === "escalation"));
});

test("Medicine Shortage with alternatives resolves the incident without escalation", async () => {
  await reset();
  const out = await engine.runMedicineShortage({
    telegramId: "u3",
    medicine: { medicineName: "Pregabalin 75" },
    query: "Pregabalin 75",
    reason: "no_pharmacy",
    alternatives: ["Gabapentin", "Nortriptyline"],
  });
  assert.equal(out.incident.status, "resolved");
  assert.equal(out.incident.escalated, false);
  assert.deepEqual(out.incident.alternativesSuggested, ["Gabapentin", "Nortriptyline"]);
});

test("Family Care workflow opens a family case and schedules a refill reminder", async () => {
  await reset();
  const out = await engine.runFamilyCare({
    telegramId: "u4",
    member: { name: "Papa", relation: "father" },
    medicine: { medicineName: "Telma 40", genericName: "Telmisartan" },
  });
  assert.equal(out.careCase.category, "family_care");
  assert.equal(out.careCase.subject.name, "Papa");
  assert.equal(out.reminder.type, "refill_reminder");
  assert.ok(out.reminder.dueAt instanceof Date);
  assert.equal(out.workflow.status, "resolved");
});

test("findOrOpenCase reuses an open case for the same subject", async () => {
  await reset();
  const first = await svc.findOrOpenCase({
    telegramId: "u5",
    title: "Continuity",
    category: "medication_continuity",
    subject: { name: "self" },
  });
  const second = await svc.findOrOpenCase({
    telegramId: "u5",
    title: "Continuity again",
    category: "medication_continuity",
    subject: { name: "self" },
  });
  assert.equal(String(first._id), String(second._id), "should reuse the same open case");
});

test("getDashboardSnapshot returns counts and recent actions", async () => {
  await reset();
  await engine.runMedicationContinuity({
    telegramId: "u6",
    medicine: { medicineName: "Dolo 650" },
    pharmacyFound: false,
  });
  const snap = await svc.getDashboardSnapshot();
  assert.ok(snap.counts.openWorkflows >= 1);
  assert.ok(snap.counts.openTasks >= 1);
  assert.ok(Array.isArray(snap.recentActions));
  assert.ok(snap.recentActions.length > 0);
});

test("Flagship: Family Medication Shortage links case + workflow + incident + follow-up", async () => {
  await reset();
  // "My father's Pregabalin is unavailable" — no alternatives → escalation.
  const out = await engine.runFamilyMedicationShortage({
    telegramId: "u7",
    member: { name: "Papa", relation: "father" },
    medicine: { medicineName: "Pregabalin", genericName: "Pregabalin" },
    query: "Pregabalin",
    alternatives: [],
  });
  assert.equal(out.careCase.category, "family_care");
  assert.equal(out.careCase.subject.name, "Papa");
  assert.equal(out.workflow.type, "medicine_shortage");
  assert.equal(out.incident.category, "medicine_unavailable");
  assert.equal(out.incident.status, "escalated");
  assert.equal(out.followUp.type, "follow_up");
  // Everything is linked to the one case.
  assert.equal(String(out.workflow.caseId), String(out.careCase._id));
  assert.equal(String(out.incident.caseId), String(out.careCase._id));
  assert.equal(String(out.followUp.caseId), String(out.careCase._id));
});

test("Flagship with alternatives resolves the incident instead of escalating", async () => {
  await reset();
  const out = await engine.runFamilyMedicationShortage({
    telegramId: "u8",
    member: { name: "Mummy", relation: "mother" },
    medicine: { medicineName: "Telma 40", genericName: "Telmisartan" },
    query: "Telma 40",
    alternatives: ["Telma H", "Telsartan"],
  });
  assert.equal(out.incident.status, "resolved");
  assert.equal(out.incident.escalated, false);
});
