"use strict";

// CareTask — ServiceNow-style Task / Agent Task. A concrete unit of work the
// agent (or a human) must complete: confirm availability, follow up on a
// medicine, set a refill reminder, answer a side-effects question, etc.

const mongoose = require("mongoose");

const careTaskSchema = new mongoose.Schema(
  {
    taskNumber: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    telegramId: { type: String, index: true },
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: "CareCase", index: true, default: null },
    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "CareWorkflow", index: true, default: null },
    type: {
      type: String,
      enum: [
        "confirm_availability",
        "follow_up",
        "refill_reminder",
        "answer_query",
        "alternative_search",
        "escalation",
        "generic",
      ],
      default: "generic",
      index: true,
    },
    assignee: { type: String, default: "careops-agent" }, // agent | human handle
    priority: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
    status: {
      type: String,
      enum: ["open", "in_progress", "blocked", "done", "cancelled"],
      default: "open",
      index: true,
    },
    dueAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    result: { type: String, trim: true, default: "" },
    externalRef: {
      system: { type: String, default: null },
      sysId: { type: String, default: null },
      number: { type: String, default: null },
      mode: { type: String, enum: ["mock", "live", null], default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.CareTask || mongoose.model("CareTask", careTaskSchema);
