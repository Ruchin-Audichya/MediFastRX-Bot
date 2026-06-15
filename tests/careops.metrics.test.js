"use strict";

// Tests for operational KPIs (MTTR, SLA compliance, resolution rates), SLA
// stamping on incidents, agent reasoning, and the ServiceNow payload preview.
// In-memory models; no Mongo, no network.

const test = require("node:test");
const assert = require("node:assert/strict");

const { installCareOpsModelMocks } = require("./_mocks/fakeCareOpsModels");
const models = installCareOpsModelMocks();

const svc = require("../src/careops/careOpsService");
const serviceNow = require("../src/integrations/servicenow");

const reset = async () => {
  await Promise.all([
    models.CareCase.deleteMany(),
    models.CareTask.deleteMany(),
    models.CareIncident.deleteMany(),
    models.CareWorkflow.deleteMany(),
    models.AgentAction.deleteMany(),
  ]);
};

test("openIncident stamps an SLA due date and a reasoning line", async () => {
  await reset();
  const inc = await svc.openIncident({
    title: "Unavailable: Pregabalin",
    telegramId: "m1",
    category: "medicine_unavailable",
    priority: "high",
    medicine: { medicineName: "Pregabalin" },
  });
  assert.ok(inc.slaDueAt instanceof Date, "incident should have slaDueAt");
  assert.ok(inc.slaDueAt.getTime() > Date.now(), "SLA due should be in the future");
  const actions = await models.AgentAction.find().lean();
  const opened = actions.find((a) => a.type === "incident_opened");
  assert.ok(opened.reasoning && /SLA/.test(opened.reasoning), "incident_opened should carry reasoning mentioning SLA");
});

test("resolveIncident within SLA is compliant (not breached)", async () => {
  await reset();
  const inc = await svc.openIncident({
    title: "x",
    telegramId: "m2",
    category: "medicine_unavailable",
    priority: "high",
  });
  const resolved = await svc.resolveIncident(inc._id, "alternatives offered");
  assert.equal(resolved.slaBreached, false);
});

test("resolveIncident after SLA due date is flagged as breached", async () => {
  await reset();
  const inc = await svc.openIncident({
    title: "x",
    telegramId: "m3",
    category: "medicine_unavailable",
    priority: "high",
  });
  // Force the SLA due date into the past to simulate a slow resolution.
  inc.slaDueAt = new Date(Date.now() - 60 * 1000);
  const resolved = await svc.resolveIncident(inc._id, "late");
  assert.equal(resolved.slaBreached, true);
});

test("computeOperationalMetrics returns the judge KPIs", async () => {
  await reset();
  const a = await svc.openIncident({ title: "a", telegramId: "m4", priority: "high" });
  await svc.resolveIncident(a._id, "ok"); // compliant
  const b = await svc.openIncident({ title: "b", telegramId: "m4", priority: "high" });
  b.slaDueAt = new Date(Date.now() - 1000);
  await svc.resolveIncident(b._id, "late"); // breached
  await svc.openIncident({ title: "c", telegramId: "m4", priority: "high" }); // still open

  const m = await svc.computeOperationalMetrics();
  assert.equal(m.totalIncidents, 3);
  assert.equal(m.incidentResolutionRate, 67); // 2 of 3 resolved
  assert.equal(m.slaBreaches, 1);
  assert.equal(m.slaCompliancePct, 50); // 1 compliant of 2 resolved
  assert.equal(typeof m.mttrMinutes, "number");
});

test("dashboard snapshot includes metrics", async () => {
  await reset();
  await svc.openIncident({ title: "z", telegramId: "m5", priority: "high" });
  const snap = await svc.getDashboardSnapshot();
  assert.ok(snap.metrics, "snapshot should include metrics");
  assert.ok("slaCompliancePct" in snap.metrics);
  assert.ok("mttrMinutes" in snap.metrics);
});

test("ServiceNow previewPayload shows the exact Table API call", () => {
  const preview = serviceNow.previewPayload("incident", {
    incidentNumber: "INCABC12",
    title: "Unavailable: Pregabalin",
    priority: "high",
    impact: "high",
    urgency: "medium",
    category: "medicine_unavailable",
    medicine: { medicineName: "Pregabalin" },
  });
  assert.equal(preview.method, "POST");
  assert.equal(preview.endpoint, "/api/now/table/incident");
  assert.equal(preview.body.priority, "2");
  assert.equal(preview.body.correlation_id, "INCABC12");
  assert.ok(["mock", "live"].includes(preview.mode));
});
