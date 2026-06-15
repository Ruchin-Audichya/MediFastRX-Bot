"use strict";

// ServiceNow integration entrypoint. `syncRecord(kind, record)` is the single
// function CareOps calls. It picks the right adapter, sends through the client
// (mock or live), and returns the externalRef to stamp on the CareOps record.
// Best-effort: errors are caught by the caller (careOpsService) and never block
// the local operation — MediFast keeps working if ServiceNow is down/absent.

const client = require("./serviceNowClient");
const {
  incidentAdapter,
  caseAdapter,
  taskAdapter,
  workflowAdapter,
} = require("./adapters");
const logger = require("../../utils/logger");

const ADAPTERS = {
  incident: incidentAdapter,
  case: caseAdapter,
  task: taskAdapter,
  workflow: workflowAdapter,
};

// kind: "incident" | "case" | "task" | "workflow"
const syncRecord = async (kind, record) => {
  const adapter = ADAPTERS[kind];
  if (!adapter) {
    logger.warn(`ServiceNow syncRecord: unknown kind "${kind}"`);
    return null;
  }
  const { table, fields } = adapter(record);
  const ref = await client.createRecord(table, fields);
  return ref;
};

const health = () => client.health();

// previewPayload — returns the EXACT ServiceNow Table API call (table + fields)
// that WOULD be POSTed for a given record, without sending it. This makes the
// integration tangible to judges even in mock mode ("show me the real call").
const previewPayload = (kind, record) => {
  const adapter = ADAPTERS[kind];
  if (!adapter) return null;
  const { table, fields } = adapter(record);
  const base = client.baseUrlForPreview();
  return {
    method: "POST",
    url: `${base}/api/now/table/${table}`,
    endpoint: `/api/now/table/${table}`,
    mode: client.mode(),
    auth: "Basic (instance user) — credentials never logged",
    body: fields,
  };
};

module.exports = { syncRecord, health, previewPayload, mode: client.mode, isLive: client.isLive };
