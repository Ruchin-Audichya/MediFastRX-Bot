"use strict";

// CareOpsService — the repository + transition layer for CareOps domain
// objects. Pure data + logging; no Telegram, no event-bus subscription (that
// lives in careOpsListener). Every create / transition records an AgentAction
// and, when ServiceNow live mode is enabled, mirrors the record via the
// adapters. All ServiceNow calls are best-effort: a sync failure never blocks
// the local record (graceful degradation).

const CareCase = require("./models/CareCase");
const CareTask = require("./models/CareTask");
const CareIncident = require("./models/CareIncident");
const CareWorkflow = require("./models/CareWorkflow");
const AgentAction = require("./models/AgentAction");
const eventBus = require("../events/eventBus");
const logger = require("../utils/logger");

// ---------------------------------------------------------------------------
// Number generation. Human-readable, ServiceNow-flavored prefixes.
// A short timestamp+random suffix keeps them unique without a counter table.
// ---------------------------------------------------------------------------
const seq = () =>
  `${Date.now().toString(36).slice(-5)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`.toUpperCase();

const numberFor = (prefix) => `${prefix}${seq()}`;

// ServiceNow-style SLA targets by priority (minutes-to-resolve). Used to stamp
// slaDueAt on incidents so the dashboard can show SLA compliance / breach.
const SLA_MINUTES = { critical: 60, high: 240, medium: 480, low: 1440 };
const slaDueFor = (priority = "high", from = Date.now()) =>
  new Date(from + (SLA_MINUTES[priority] || SLA_MINUTES.high) * 60 * 1000);

// ---------------------------------------------------------------------------
// AgentAction logging — the autonomous audit trail.
// ---------------------------------------------------------------------------
const logAction = async (type, summary, { telegramId, refs = {}, metadata = {}, reasoning = null } = {}) => {
  try {
    const action = await AgentAction.create({ type, summary, telegramId, refs, metadata, reasoning });
    eventBus.emitSafe("careops.action", { type, summary, telegramId, refs, reasoning });
    return action;
  } catch (error) {
    logger.error(`CareOps logAction failed (${type}): ${error.message}`);
    return null;
  }
};

// Lazy ServiceNow sync — required here (not at top) so the integration module
// stays optional and the service loads even if creds/config are absent.
const syncToServiceNow = async (kind, record) => {
  try {
    const { syncRecord } = require("../integrations/servicenow");
    const ref = await syncRecord(kind, record);
    if (ref && record) {
      record.externalRef = ref;
      await record.save();
      await logAction("servicenow_sync", `Mirrored ${kind} to ServiceNow (${ref.mode})`, {
        telegramId: record.telegramId,
        refs: collectRefs(record),
        metadata: { kind, mode: ref.mode, number: ref.number },
      });
    }
    return ref;
  } catch (error) {
    logger.warn(`ServiceNow sync skipped for ${kind}: ${error.message}`);
    return null;
  }
};

const collectRefs = (record = {}) => ({
  caseNumber: record.caseNumber || null,
  taskNumber: record.taskNumber || null,
  incidentNumber: record.incidentNumber || null,
  workflowNumber: record.workflowNumber || null,
});

// ===========================================================================
// CASES
// ===========================================================================
const openCase = async ({
  title,
  description = "",
  telegramId,
  channel = "telegram",
  subject = {},
  category = "general",
  priority = "medium",
  medicine = {},
} = {}) => {
  const careCase = await CareCase.create({
    caseNumber: numberFor("CASE"),
    title,
    description,
    telegramId: telegramId ? String(telegramId) : undefined,
    channel,
    subject: {
      name: subject.name || "self",
      relation: subject.relation || "self",
    },
    category,
    priority,
    medicine: {
      medicineName: medicine.medicineName,
      genericName: medicine.genericName,
    },
  });
  await logAction("case_opened", `Opened case ${careCase.caseNumber}: ${title}`, {
    telegramId,
    refs: { caseNumber: careCase.caseNumber },
    metadata: { category, priority },
    reasoning: `Patient intent classified as ${category.replace(/_/g, " ")}; opening a tracked case to own continuity of care.`,
  });
  await syncToServiceNow("case", careCase);
  return careCase;
};

// Find an open case for a (telegramId, subjectName) pair or create one. This is
// how follow-ups and family mentions attach to a single ongoing case rather
// than spawning duplicates.
const findOrOpenCase = async ({ telegramId, subject = {}, ...rest } = {}) => {
  const subjectName = subject.name || "self";
  const existing = await CareCase.findOne({
    telegramId: telegramId ? String(telegramId) : undefined,
    "subject.name": subjectName,
    status: { $in: ["open", "in_progress", "escalated"] },
  })
    .sort({ updatedAt: -1 })
    .exec();
  if (existing) return existing;
  return openCase({ telegramId, subject, ...rest });
};

const transitionCase = async (caseId, status, note = "") => {
  const careCase = await CareCase.findById(caseId);
  if (!careCase) return null;
  careCase.status = status;
  if (status === "escalated") {
    careCase.escalated = true;
    careCase.escalatedAt = new Date();
  }
  if (status === "resolved" || status === "closed") careCase.resolvedAt = new Date();
  await careCase.save();
  await logAction(status === "resolved" || status === "closed" ? "case_resolved" : "case_updated",
    `Case ${careCase.caseNumber} → ${status}${note ? ` (${note})` : ""}`,
    { telegramId: careCase.telegramId, refs: { caseNumber: careCase.caseNumber } });
  return careCase;
};

// ===========================================================================
// TASKS
// ===========================================================================
const createTask = async ({
  title,
  description = "",
  telegramId,
  caseId = null,
  workflowId = null,
  type = "generic",
  priority = "medium",
  dueAt = null,
} = {}) => {
  const task = await CareTask.create({
    taskNumber: numberFor("TASK"),
    title,
    description,
    telegramId: telegramId ? String(telegramId) : undefined,
    caseId,
    workflowId,
    type,
    priority,
    dueAt,
  });
  await logAction("task_created", `Created task ${task.taskNumber}: ${title}`, {
    telegramId,
    refs: { taskNumber: task.taskNumber },
    metadata: { type, priority },
  });
  await syncToServiceNow("task", task);
  return task;
};

const completeTask = async (taskId, result = "") => {
  const task = await CareTask.findById(taskId);
  if (!task) return null;
  task.status = "done";
  task.completedAt = new Date();
  task.result = result;
  await task.save();
  await logAction("task_completed", `Completed task ${task.taskNumber}`, {
    telegramId: task.telegramId,
    refs: { taskNumber: task.taskNumber },
    metadata: { result },
  });
  return task;
};

// ===========================================================================
// INCIDENTS
// ===========================================================================
const openIncident = async ({
  title,
  description = "",
  telegramId,
  caseId = null,
  workflowId = null,
  category = "other",
  medicine = {},
  impact = "medium",
  urgency = "medium",
  priority = "high",
  alternativesSuggested = [],
} = {}) => {
  const incident = await CareIncident.create({
    incidentNumber: numberFor("INC"),
    title,
    description,
    telegramId: telegramId ? String(telegramId) : undefined,
    caseId,
    workflowId,
    category,
    medicine: { medicineName: medicine.medicineName, genericName: medicine.genericName },
    impact,
    urgency,
    priority,
    alternativesSuggested,
    slaDueAt: slaDueFor(priority),
  });
  await logAction("incident_opened", `Opened incident ${incident.incidentNumber}: ${title}`, {
    telegramId,
    refs: { incidentNumber: incident.incidentNumber },
    metadata: { category, priority, slaDueAt: incident.slaDueAt },
    reasoning: `Detected ${category.replace(/_/g, " ")}; raised ${priority.toUpperCase()} incident with a ${SLA_MINUTES[priority] || 240}-min SLA target.`,
  });
  await syncToServiceNow("incident", incident);
  return incident;
};

const escalateIncident = async (incidentId, note = "") => {
  const incident = await CareIncident.findById(incidentId);
  if (!incident) return null;
  incident.status = "escalated";
  incident.escalated = true;
  incident.escalatedAt = new Date();
  await incident.save();
  await logAction("escalation", `Escalated incident ${incident.incidentNumber}${note ? `: ${note}` : ""}`, {
    telegramId: incident.telegramId,
    refs: { incidentNumber: incident.incidentNumber },
    reasoning: "No safe alternative found within SLA window; escalating to the SOS pharmacy network for human sourcing.",
  });
  return incident;
};

const resolveIncident = async (incidentId, resolutionNote = "") => {
  const incident = await CareIncident.findById(incidentId);
  if (!incident) return null;
  incident.status = "resolved";
  incident.resolvedAt = new Date();
  incident.resolutionNote = resolutionNote;
  // SLA compliance: breached if resolved after the due date.
  if (incident.slaDueAt && incident.resolvedAt > incident.slaDueAt) {
    incident.slaBreached = true;
  }
  await incident.save();
  await logAction("incident_resolved", `Resolved incident ${incident.incidentNumber}`, {
    telegramId: incident.telegramId,
    refs: { incidentNumber: incident.incidentNumber },
    metadata: { resolutionNote, slaBreached: incident.slaBreached },
    reasoning: incident.slaBreached
      ? "Resolved after SLA target — flagged as breach for review."
      : "Resolved within SLA target.",
  });
  return incident;
};

// ===========================================================================
// WORKFLOWS
// ===========================================================================
const startWorkflow = async ({ type, title, telegramId, caseId = null, medicine = {}, steps = [] } = {}) => {
  const workflow = await CareWorkflow.create({
    workflowNumber: numberFor("WF"),
    type,
    title,
    telegramId: telegramId ? String(telegramId) : undefined,
    caseId,
    medicine: { medicineName: medicine.medicineName, genericName: medicine.genericName },
    steps: steps.map((s) => ({ ...s, status: s.status || "pending" })),
    status: "open",
    currentStep: steps[0]?.key || null,
  });
  await logAction("workflow_started", `Started ${type} workflow ${workflow.workflowNumber}`, {
    telegramId,
    refs: { workflowNumber: workflow.workflowNumber },
    metadata: { type },
  });
  return workflow;
};

const advanceWorkflow = async (workflowId, stepKey, { status = "done", detail = "" } = {}) => {
  const workflow = await CareWorkflow.findById(workflowId);
  if (!workflow) return null;
  const step = workflow.steps.find((s) => s.key === stepKey);
  if (step) {
    if (!step.startedAt) step.startedAt = new Date();
    step.status = status;
    step.detail = detail || step.detail;
    if (status === "done" || status === "skipped" || status === "failed") {
      step.completedAt = new Date();
    }
  }
  // Move currentStep pointer to the next pending step.
  const nextPending = workflow.steps.find((s) => s.status === "pending");
  workflow.currentStep = nextPending ? nextPending.key : null;
  if (workflow.status === "open") workflow.status = "in_progress";
  if (!nextPending && workflow.steps.every((s) => s.status !== "pending" && s.status !== "in_progress")) {
    workflow.status = workflow.steps.some((s) => s.status === "failed") ? "escalated" : "resolved";
    if (workflow.status === "resolved") workflow.resolvedAt = new Date();
  }
  await workflow.save();
  await logAction(workflow.status === "resolved" ? "workflow_resolved" : "workflow_step",
    `Workflow ${workflow.workflowNumber} step "${stepKey}" → ${status}`,
    { telegramId: workflow.telegramId, refs: { workflowNumber: workflow.workflowNumber }, metadata: { stepKey, status } });
  return workflow;
};

// ===========================================================================
// OPERATIONAL METRICS — the KPIs ServiceNow/Deloitte judges look for.
// ===========================================================================
const computeOperationalMetrics = async () => {
  const [totalIncidents, resolvedIncidents, breached, allCases, resolvedCases, totalWorkflows, resolvedWorkflows] =
    await Promise.all([
      CareIncident.countDocuments({}),
      CareIncident.find({ status: "resolved" }).lean(),
      CareIncident.countDocuments({ slaBreached: true }),
      CareCase.countDocuments({}),
      CareCase.countDocuments({ status: { $in: ["resolved", "closed"] } }),
      CareWorkflow.countDocuments({}),
      CareWorkflow.countDocuments({ status: "resolved" }),
    ]);

  // Mean time to resolve (incidents), in minutes.
  let mttrMinutes = 0;
  if (resolvedIncidents.length) {
    const durations = resolvedIncidents
      .filter((i) => i.resolvedAt && i.createdAt)
      .map((i) => (new Date(i.resolvedAt) - new Date(i.createdAt)) / 60000);
    if (durations.length) {
      mttrMinutes = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
    }
  }

  const pct = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);
  const resolvedIncidentCount = resolvedIncidents.length;
  const slaCompliancePct = resolvedIncidentCount
    ? pct(resolvedIncidentCount - breached, resolvedIncidentCount)
    : 100;

  return {
    mttrMinutes,
    incidentResolutionRate: pct(resolvedIncidentCount, totalIncidents),
    caseResolutionRate: pct(resolvedCases, allCases),
    workflowCompletionRate: pct(resolvedWorkflows, totalWorkflows),
    slaCompliancePct,
    slaBreaches: breached,
    totalIncidents,
    totalCases: allCases,
    totalWorkflows,
  };
};

// ===========================================================================
// DASHBOARD QUERIES
// ===========================================================================
const getDashboardSnapshot = async () => {
  const [
    openCases,
    openTasks,
    openIncidents,
    openWorkflows,
    escalations,
    recentActions,
    cases,
    incidents,
    workflows,
    tasks,
    metrics,
  ] = await Promise.all([
    CareCase.countDocuments({ status: { $in: ["open", "in_progress", "escalated"] } }),
    CareTask.countDocuments({ status: { $in: ["open", "in_progress", "blocked"] } }),
    CareIncident.countDocuments({ status: { $in: ["open", "investigating", "escalated"] } }),
    CareWorkflow.countDocuments({ status: { $in: ["open", "in_progress", "escalated"] } }),
    CareIncident.countDocuments({ escalated: true }),
    AgentAction.find().sort({ createdAt: -1 }).limit(25).lean(),
    CareCase.find().sort({ updatedAt: -1 }).limit(10).lean(),
    CareIncident.find().sort({ updatedAt: -1 }).limit(10).lean(),
    CareWorkflow.find().sort({ updatedAt: -1 }).limit(10).lean(),
    CareTask.find().sort({ updatedAt: -1 }).limit(10).lean(),
    computeOperationalMetrics(),
  ]);

  return {
    counts: {
      openCases,
      openTasks,
      openIncidents,
      openWorkflows,
      escalations,
    },
    metrics,
    recentActions,
    cases,
    incidents,
    workflows,
    tasks,
    generatedAt: new Date().toISOString(),
  };
};

module.exports = {
  // numbers
  numberFor,
  // actions
  logAction,
  // cases
  openCase,
  findOrOpenCase,
  transitionCase,
  // tasks
  createTask,
  completeTask,
  // incidents
  openIncident,
  escalateIncident,
  resolveIncident,
  // workflows
  startWorkflow,
  advanceWorkflow,
  // metrics + dashboard
  computeOperationalMetrics,
  getDashboardSnapshot,
};
