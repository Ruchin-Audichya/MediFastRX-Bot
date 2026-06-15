"use strict";

// Unit tests for the ServiceNow integration — pure, no network, no Mongo.
// Covers: mock-mode ref generation, adapter field mapping (priority/impact),
// kind routing, and the critical security property: NO secret ever appears in
// any log line.

const test = require("node:test");
const assert = require("node:assert/strict");

const client = require("../src/integrations/servicenow/serviceNowClient");
const { syncRecord, health } = require("../src/integrations/servicenow");
const {
  incidentAdapter,
  caseAdapter,
  taskAdapter,
  workflowAdapter,
} = require("../src/integrations/servicenow/adapters");

test("client defaults to mock mode without credentials", () => {
  assert.equal(client.mode(), "mock");
  assert.equal(client.isLive(), false);
  const h = health();
  assert.equal(h.mode, "mock");
});

test("mock createRecord returns a ServiceNow-shaped ref", async () => {
  const ref = await client.createRecord("incident", { short_description: "x" });
  assert.equal(ref.system, "servicenow");
  assert.equal(ref.mode, "mock");
  assert.match(ref.sysId, /^[0-9a-f]{32}$/);
  assert.match(ref.number, /^INC\d{7}$/);
});

test("incidentAdapter maps priority/impact/urgency to ServiceNow codes", () => {
  const { table, fields } = incidentAdapter({
    title: "Unavailable: Pregabalin",
    incidentNumber: "INCABC12",
    priority: "high",
    impact: "high",
    urgency: "medium",
    medicine: { medicineName: "Pregabalin" },
    category: "medicine_not_found",
  });
  assert.equal(table, "incident");
  assert.equal(fields.priority, "2"); // high
  assert.equal(fields.impact, "1"); // high
  assert.equal(fields.urgency, "2"); // medium
  assert.equal(fields.correlation_id, "INCABC12");
  assert.equal(fields.correlation_display, "MediFast CareOps");
});

test("case/task/workflow adapters target the right tables", () => {
  assert.equal(caseAdapter({ caseNumber: "CASE1" }).table, "sn_customerservice_case");
  assert.equal(taskAdapter({ taskNumber: "TASK1" }).table, "task");
  assert.equal(workflowAdapter({ workflowNumber: "WF1", type: "family_care" }).table, "task");
});

test("syncRecord routes by kind and returns a ref in mock mode", async () => {
  const ref = await syncRecord("case", { caseNumber: "CASE9", title: "Family care" });
  assert.equal(ref.mode, "mock");
  assert.match(ref.number, /^CS\d{7}$/);
});

test("syncRecord returns null for unknown kind", async () => {
  const ref = await syncRecord("nonsense", {});
  assert.equal(ref, null);
});

test("SECURITY: secrets never appear in logs", async () => {
  // Capture logger output by temporarily swapping the transport-level methods.
  const logger = require("../src/utils/logger");
  const captured = [];
  const orig = { info: logger.info, warn: logger.warn, error: logger.error };
  logger.info = (m) => captured.push(String(m));
  logger.warn = (m) => captured.push(String(m));
  logger.error = (m) => captured.push(String(m));

  // Simulate live-ish config with a fake password, then run mock path (no
  // network). Even the cfg read must not leak the password into logs.
  process.env.SERVICENOW_USER = "demo.user";
  process.env.SERVICENOW_PASSWORD = "SUPER_SECRET_PW_123";
  try {
    await client.createRecord("incident", { short_description: "leak check" });
  } finally {
    logger.info = orig.info;
    logger.warn = orig.warn;
    logger.error = orig.error;
    delete process.env.SERVICENOW_USER;
    delete process.env.SERVICENOW_PASSWORD;
  }

  const joined = captured.join("\n");
  assert.doesNotMatch(joined, /SUPER_SECRET_PW_123/, "password leaked into logs");
  assert.doesNotMatch(joined, /Basic [A-Za-z0-9+/=]+/, "auth header leaked into logs");
});
