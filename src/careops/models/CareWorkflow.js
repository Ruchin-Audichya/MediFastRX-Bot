"use strict";

// CareWorkflow — ServiceNow-style Workflow / Flow run. An ordered set of steps
// the agent executes end to end (e.g., Medication Continuity:
// request → intelligence → pharmacy → task → tracking → resolution). Each step
// carries its own status so the dashboard can render a live progress trail.

const mongoose = require("mongoose");

const workflowStepSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    status: {
      type: String,
      enum: ["pending", "in_progress", "done", "skipped", "failed"],
      default: "pending",
    },
    detail: { type: String, trim: true, default: "" },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
  },
  { _id: false }
);

const careWorkflowSchema = new mongoose.Schema(
  {
    workflowNumber: { type: String, required: true, unique: true, index: true },
    type: {
      type: String,
      enum: ["medication_continuity", "medicine_shortage", "family_care"],
      required: true,
      index: true,
    },
    title: { type: String, required: true, trim: true },
    telegramId: { type: String, index: true },
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: "CareCase", index: true, default: null },
    medicine: {
      medicineName: { type: String, trim: true },
      genericName: { type: String, trim: true },
    },
    steps: { type: [workflowStepSchema], default: [] },
    status: {
      type: String,
      enum: ["open", "in_progress", "escalated", "resolved", "closed"],
      default: "open",
      index: true,
    },
    currentStep: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.CareWorkflow || mongoose.model("CareWorkflow", careWorkflowSchema);
