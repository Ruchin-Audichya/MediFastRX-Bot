"use strict";

// Adapters — map CareOps domain records into ServiceNow Table API field sets.
// Pure functions; no I/O. Priority/impact/urgency use ServiceNow's 1=high …
// 3=low convention.

const PRIORITY_MAP = { critical: "1", high: "2", medium: "3", low: "4" };
const IUMAP = { high: "1", medium: "2", low: "3" };

// Incident → `incident` table.
const incidentAdapter = (incident = {}) => ({
  table: "incident",
  fields: {
    short_description: incident.title || "MediFast CareOps incident",
    description:
      incident.description ||
      `Medicine: ${incident.medicine?.medicineName || "n/a"}. Category: ${incident.category}.`,
    category: "inquiry",
    impact: IUMAP[incident.impact] || "2",
    urgency: IUMAP[incident.urgency] || "2",
    priority: PRIORITY_MAP[incident.priority] || "3",
    // Free-text correlation so the CareOps record and the SN record link up.
    correlation_id: incident.incidentNumber,
    correlation_display: "MediFast CareOps",
  },
});

// Case → CSM `sn_customerservice_case` table (falls back gracefully if the
// instance lacks CSM; live callers can override the table via env).
const caseAdapter = (careCase = {}) => ({
  table: process.env.SERVICENOW_CASE_TABLE || "sn_customerservice_case",
  fields: {
    short_description: careCase.title || "MediFast CareOps case",
    description: careCase.description || `Subject: ${careCase.subject?.name || "self"}`,
    priority: PRIORITY_MAP[careCase.priority] || "3",
    correlation_id: careCase.caseNumber,
    correlation_display: "MediFast CareOps",
  },
});

// Task → generic `task` table (or SC task via env).
const taskAdapter = (task = {}) => ({
  table: process.env.SERVICENOW_TASK_TABLE || "task",
  fields: {
    short_description: task.title || "MediFast CareOps task",
    description: task.description || `Type: ${task.type}`,
    priority: PRIORITY_MAP[task.priority] || "3",
    correlation_id: task.taskNumber,
    correlation_display: "MediFast CareOps",
  },
});

// Workflow → represented as an incident-style record is overkill; we map it to
// the generic task table as a parent activity. Mock mode makes this harmless.
const workflowAdapter = (workflow = {}) => ({
  table: process.env.SERVICENOW_TASK_TABLE || "task",
  fields: {
    short_description: workflow.title || `CareOps ${workflow.type} workflow`,
    description: `Workflow ${workflow.workflowNumber} (${workflow.type})`,
    correlation_id: workflow.workflowNumber,
    correlation_display: "MediFast CareOps",
  },
});

module.exports = { incidentAdapter, caseAdapter, taskAdapter, workflowAdapter, PRIORITY_MAP };
