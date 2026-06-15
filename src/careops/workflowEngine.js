"use strict";

// workflowEngine — orchestrates the three CareOps healthcare workflows on top
// of careOpsService. Each function is idempotent-friendly and best-effort: it
// returns the records it created so callers (listener / demo / tests) can
// assert, but never throws into the caller's path.
//
// The engine does NOT call medicine/pharmacy services directly — it receives
// already-resolved facts (medicine, pharmacyFound, alternatives) from the
// listener, which reads them off the events MediFast already emits. This keeps
// CareOps a thin, reuse-first layer with no duplication of intelligence.

const svc = require("./careOpsService");
const logger = require("../utils/logger");

const STEP = (key, label) => ({ key, label, status: "pending" });

// ---------------------------------------------------------------------------
// Workflow 1 — Medication Continuity
//   request → intelligence → pharmacy → task → tracking → resolution
// Triggered on a successful medicine search.
// ---------------------------------------------------------------------------
const runMedicationContinuity = async ({
  telegramId,
  medicine = {},
  pharmacyFound = false,
  pharmacyName = null,
} = {}) => {
  try {
    const careCase = await svc.findOrOpenCase({
      telegramId,
      title: `Medication continuity: ${medicine.medicineName || "medicine"}`,
      category: "medication_continuity",
      medicine,
    });

    const workflow = await svc.startWorkflow({
      type: "medication_continuity",
      title: `Continuity for ${medicine.medicineName || "medicine"}`,
      telegramId,
      caseId: careCase._id,
      medicine,
      steps: [
        STEP("request", "Patient requested medicine"),
        STEP("intelligence", "Medicine intelligence resolved"),
        STEP("pharmacy", "Pharmacy discovery"),
        STEP("task", "Fulfillment task created"),
        STEP("tracking", "Status tracking"),
        STEP("resolution", "Resolution"),
      ],
    });

    await svc.advanceWorkflow(workflow._id, "request", {
      detail: `Query for ${medicine.medicineName || "medicine"}`,
    });
    await svc.advanceWorkflow(workflow._id, "intelligence", {
      detail: medicine.genericName
        ? `Resolved to generic ${medicine.genericName}`
        : "Resolved medicine identity",
    });
    await svc.advanceWorkflow(workflow._id, "pharmacy", {
      status: pharmacyFound ? "done" : "skipped",
      detail: pharmacyFound
        ? `Pharmacy located${pharmacyName ? `: ${pharmacyName}` : ""}`
        : "No location shared yet",
    });

    const task = await svc.createTask({
      title: `Confirm availability of ${medicine.medicineName || "medicine"}`,
      telegramId,
      caseId: careCase._id,
      workflowId: workflow._id,
      type: "confirm_availability",
      priority: "medium",
    });
    await svc.advanceWorkflow(workflow._id, "task", {
      detail: `Task ${task.taskNumber} created`,
    });
    await svc.advanceWorkflow(workflow._id, "tracking", {
      detail: "Tracking fulfillment",
    });

    // If a pharmacy was already found we can resolve the workflow immediately;
    // otherwise it stays in-progress awaiting location/confirmation.
    if (pharmacyFound) {
      await svc.completeTask(task._id, pharmacyName ? `Available at ${pharmacyName}` : "Available");
      await svc.advanceWorkflow(workflow._id, "resolution", {
        detail: "Medicine located; continuity assured",
      });
    }

    return { careCase, workflow, task };
  } catch (error) {
    logger.error(`runMedicationContinuity failed: ${error.message}`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Workflow 2 — Medicine Shortage
//   request → no pharmacy/unknown → incident → alternatives → escalation → resolution
// Triggered on a failed medicine lookup OR a known medicine with no pharmacy.
// ---------------------------------------------------------------------------
const runMedicineShortage = async ({
  telegramId,
  medicine = {},
  query = "",
  reason = "medicine_not_found",
  alternatives = [],
} = {}) => {
  try {
    const careCase = await svc.findOrOpenCase({
      telegramId,
      title: `Shortage: ${medicine.medicineName || query || "medicine"}`,
      category: "shortage",
      priority: "high",
      medicine,
    });

    const workflow = await svc.startWorkflow({
      type: "medicine_shortage",
      title: `Shortage handling for ${medicine.medicineName || query || "medicine"}`,
      telegramId,
      caseId: careCase._id,
      medicine,
      steps: [
        STEP("request", "Patient requested medicine"),
        STEP("unavailable", "Medicine unavailable / not found"),
        STEP("incident", "Incident raised"),
        STEP("alternatives", "Alternative search"),
        STEP("escalation", "Escalation"),
        STEP("resolution", "Resolution"),
      ],
    });
    await svc.advanceWorkflow(workflow._id, "request", { detail: query || medicine.medicineName });
    await svc.advanceWorkflow(workflow._id, "unavailable", { detail: reason });

    const incident = await svc.openIncident({
      title: `Unavailable: ${medicine.medicineName || query || "medicine"}`,
      telegramId,
      caseId: careCase._id,
      workflowId: workflow._id,
      category: reason === "no_pharmacy" ? "no_pharmacy" : "medicine_not_found",
      medicine,
      alternativesSuggested: alternatives,
      priority: "high",
    });
    await svc.advanceWorkflow(workflow._id, "incident", { detail: `Incident ${incident.incidentNumber}` });

    if (alternatives.length) {
      await svc.advanceWorkflow(workflow._id, "alternatives", {
        detail: `Suggested: ${alternatives.slice(0, 3).join(", ")}`,
      });
      await svc.advanceWorkflow(workflow._id, "escalation", { status: "skipped", detail: "Alternatives available" });
      await svc.resolveIncident(incident._id, `Alternatives offered: ${alternatives.slice(0, 3).join(", ")}`);
      await svc.advanceWorkflow(workflow._id, "resolution", { detail: "Resolved via alternatives" });
    } else {
      await svc.advanceWorkflow(workflow._id, "alternatives", { status: "failed", detail: "No alternatives found" });
      await svc.escalateIncident(incident._id, "No alternatives; routed to SOS network");
      await svc.advanceWorkflow(workflow._id, "escalation", { detail: "Escalated to SOS network" });
      await svc.createTask({
        title: `Source ${medicine.medicineName || query || "medicine"} via network`,
        telegramId,
        caseId: careCase._id,
        workflowId: workflow._id,
        type: "escalation",
        priority: "high",
      });
    }

    return { careCase, workflow, incident };
  } catch (error) {
    logger.error(`runMedicineShortage failed: ${error.message}`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Workflow 3 — Family Care
//   family member mentioned → memory update → tracking → task → reminder → resolution
// Triggered when a family member is the subject of a query.
// ---------------------------------------------------------------------------
const runFamilyCare = async ({
  telegramId,
  member = {},
  medicine = {},
} = {}) => {
  try {
    const careCase = await svc.findOrOpenCase({
      telegramId,
      title: `Family care: ${member.name || "family member"}`,
      category: "family_care",
      subject: { name: member.name || "family member", relation: member.relation || "family" },
      medicine,
    });

    const workflow = await svc.startWorkflow({
      type: "family_care",
      title: `Care plan for ${member.name || "family member"}`,
      telegramId,
      caseId: careCase._id,
      medicine,
      steps: [
        STEP("mention", "Family member identified"),
        STEP("memory", "Memory updated"),
        STEP("tracking", "Medicine tracking"),
        STEP("task", "Care task created"),
        STEP("reminder", "Refill reminder scheduled"),
        STEP("resolution", "Resolution"),
      ],
    });
    await svc.advanceWorkflow(workflow._id, "mention", { detail: `${member.name} (${member.relation})` });
    await svc.advanceWorkflow(workflow._id, "memory", { detail: "Family context stored" });
    await svc.advanceWorkflow(workflow._id, "tracking", {
      detail: medicine.medicineName ? `Tracking ${medicine.medicineName}` : "Tracking care",
    });

    const task = await svc.createTask({
      title: `Care follow-up for ${member.name || "family member"}`,
      telegramId,
      caseId: careCase._id,
      workflowId: workflow._id,
      type: "follow_up",
      priority: "medium",
    });
    await svc.advanceWorkflow(workflow._id, "task", { detail: `Task ${task.taskNumber}` });

    // Schedule a refill reminder task ~30 days out (representative).
    const dueAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const reminder = await svc.createTask({
      title: `Refill reminder: ${medicine.medicineName || "medicine"} for ${member.name || "family member"}`,
      telegramId,
      caseId: careCase._id,
      workflowId: workflow._id,
      type: "refill_reminder",
      priority: "low",
      dueAt,
    });
    await svc.advanceWorkflow(workflow._id, "reminder", { detail: `Reminder ${reminder.taskNumber} for ${dueAt.toDateString()}` });
    await svc.advanceWorkflow(workflow._id, "resolution", { detail: "Care plan active" });

    return { careCase, workflow, task, reminder };
  } catch (error) {
    logger.error(`runFamilyCare failed: ${error.message}`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Follow-up → Agent Task on the active case (no new workflow).
// ---------------------------------------------------------------------------
const runFollowUpTask = async ({ telegramId, medicine = {}, question = "" } = {}) => {
  try {
    const careCase = await svc.findOrOpenCase({
      telegramId,
      title: `Medication continuity: ${medicine.medicineName || "medicine"}`,
      category: "medication_continuity",
      medicine,
    });
    const task = await svc.createTask({
      title: `Answer: "${(question || "follow-up").slice(0, 80)}"`,
      telegramId,
      caseId: careCase._id,
      type: "answer_query",
      priority: "low",
    });
    // Follow-up answers are produced by the existing bot synthesis, so the
    // task is immediately satisfied from the agent's perspective.
    await svc.completeTask(task._id, "Answered from medicine intelligence");
    return { careCase, task };
  } catch (error) {
    logger.error(`runFollowUpTask failed: ${error.message}`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Flagship composite — Family Medication Shortage.
//   "My father's Pregabalin is unavailable"
//   → Family Case + Shortage Workflow + Incident + (alternatives | escalation)
//     + follow-up Task, all linked. This is the headline demo journey: one
//   message produces a coordinated, end-to-end healthcare operation.
// ---------------------------------------------------------------------------
const runFamilyMedicationShortage = async ({
  telegramId,
  member = {},
  medicine = {},
  query = "",
  alternatives = [],
} = {}) => {
  try {
    const subjectName = member.name || member.relation || "family member";
    // One Case scoped to the family member ties everything together.
    const careCase = await svc.findOrOpenCase({
      telegramId,
      title: `Family care: ${subjectName} — ${medicine.medicineName || query || "medicine"}`,
      category: "family_care",
      priority: "high",
      subject: { name: subjectName, relation: member.relation || "family" },
      medicine,
    });

    const workflow = await svc.startWorkflow({
      type: "medicine_shortage",
      title: `Shortage for ${subjectName}: ${medicine.medicineName || query || "medicine"}`,
      telegramId,
      caseId: careCase._id,
      medicine,
      steps: [
        STEP("request", `${subjectName}'s medicine requested`),
        STEP("family", "Family context resolved"),
        STEP("intelligence", "Medicine intelligence checked"),
        STEP("pharmacy", "Pharmacy availability checked"),
        STEP("incident", "Unavailability incident raised"),
        STEP("alternatives", "Alternative search"),
        STEP("escalation", "Escalation"),
        STEP("resolution", "Resolution"),
      ],
    });
    await svc.advanceWorkflow(workflow._id, "request", { detail: query || medicine.medicineName });
    await svc.advanceWorkflow(workflow._id, "family", { detail: `${subjectName} (${member.relation || "family"})` });
    await svc.advanceWorkflow(workflow._id, "intelligence", {
      detail: medicine.genericName ? `Generic: ${medicine.genericName}` : "Identity checked",
    });
    await svc.advanceWorkflow(workflow._id, "pharmacy", { status: "failed", detail: "Not available nearby" });

    const incident = await svc.openIncident({
      title: `Unavailable for ${subjectName}: ${medicine.medicineName || query || "medicine"}`,
      telegramId,
      caseId: careCase._id,
      workflowId: workflow._id,
      category: "medicine_unavailable",
      medicine,
      alternativesSuggested: alternatives,
      impact: "high",
      urgency: "high",
      priority: "high",
    });
    await svc.advanceWorkflow(workflow._id, "incident", { detail: `Incident ${incident.incidentNumber}` });

    // Always create a follow-up task so the care loop is owned by the agent.
    const followUp = await svc.createTask({
      title: `Follow up on ${medicine.medicineName || query || "medicine"} for ${subjectName}`,
      telegramId,
      caseId: careCase._id,
      workflowId: workflow._id,
      type: "follow_up",
      priority: "high",
    });

    if (alternatives.length) {
      await svc.advanceWorkflow(workflow._id, "alternatives", {
        detail: `Suggested: ${alternatives.slice(0, 3).join(", ")}`,
      });
      await svc.advanceWorkflow(workflow._id, "escalation", { status: "skipped", detail: "Alternatives available" });
      await svc.resolveIncident(incident._id, `Alternatives offered for ${subjectName}: ${alternatives.slice(0, 3).join(", ")}`);
      await svc.advanceWorkflow(workflow._id, "resolution", { detail: "Resolved via alternatives" });
    } else {
      await svc.advanceWorkflow(workflow._id, "alternatives", { status: "failed", detail: "No alternatives found" });
      await svc.escalateIncident(incident._id, `Escalated to SOS network for ${subjectName}`);
      await svc.advanceWorkflow(workflow._id, "escalation", { detail: "Escalated to SOS network" });
    }

    return { careCase, workflow, incident, followUp };
  } catch (error) {
    logger.error(`runFamilyMedicationShortage failed: ${error.message}`);
    return null;
  }
};

// ---------------------------------------------------------------------------
// Medication Fulfillment — fired when the user SELECTS a pharmacy to fulfill
// a medicine. This is the "operational action, not information retrieval"
// differentiator: a selection becomes a tracked fulfillment workflow + task,
// visible on the dashboard and mirrored to ServiceNow.
//   selection → reserve task → confirm availability → fulfillment tracking → resolution
// ---------------------------------------------------------------------------
const runMedicationFulfillment = async ({
  telegramId,
  medicine = {},
  pharmacy = {},
} = {}) => {
  try {
    const careCase = await svc.findOrOpenCase({
      telegramId,
      title: `Medication continuity: ${medicine.medicineName || "medicine"}`,
      category: "medication_continuity",
      medicine,
    });

    const workflow = await svc.startWorkflow({
      type: "medication_continuity",
      title: `Fulfill ${medicine.medicineName || "medicine"} at ${pharmacy.name || "pharmacy"}`,
      telegramId,
      caseId: careCase._id,
      medicine,
      steps: [
        STEP("selection", "Pharmacy selected by patient"),
        STEP("reserve", "Reservation task created"),
        STEP("confirm", "Availability confirmation"),
        STEP("fulfillment", "Fulfillment tracking"),
        STEP("resolution", "Resolution"),
      ],
    });
    await svc.advanceWorkflow(workflow._id, "selection", {
      detail: `${pharmacy.name || "pharmacy"}${pharmacy.distance ? ` (${pharmacy.distance})` : ""}`,
    });

    const task = await svc.createTask({
      title: `Reserve ${medicine.medicineName || "medicine"} at ${pharmacy.name || "pharmacy"}`,
      description: pharmacy.phone ? `Call ${pharmacy.phone} to confirm and reserve.` : "Confirm availability and reserve.",
      telegramId,
      caseId: careCase._id,
      workflowId: workflow._id,
      type: "confirm_availability",
      priority: "high",
    });
    await svc.advanceWorkflow(workflow._id, "reserve", { detail: `Task ${task.taskNumber} created` });
    await svc.advanceWorkflow(workflow._id, "confirm", {
      detail: pharmacy.phone ? `Pharmacy reachable at ${pharmacy.phone}` : "Awaiting confirmation",
    });
    await svc.advanceWorkflow(workflow._id, "fulfillment", { detail: "Tracking pickup/fulfillment" });
    await svc.advanceWorkflow(workflow._id, "resolution", {
      detail: `Reservation in progress at ${pharmacy.name || "pharmacy"}`,
    });

    return { careCase, workflow, task };
  } catch (error) {
    logger.error(`runMedicationFulfillment failed: ${error.message}`);
    return null;
  }
};

module.exports = {
  runMedicationContinuity,
  runMedicationFulfillment,
  runMedicineShortage,
  runFamilyMedicationShortage,
  runFamilyCare,
  runFollowUpTask,
};
