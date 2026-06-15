"use strict";

// AgentAction — the autonomous "agent did X" audit trail. Every CareOps state
// change (create case, advance workflow, open incident, escalate, resolve)
// writes an AgentAction. This is what makes the platform *feel* like an
// autonomous operations agent rather than a chatbot: the dashboard renders a
// reverse-chronological stream of decisions and actions the agent took.

const mongoose = require("mongoose");

const agentActionSchema = new mongoose.Schema(
  {
    telegramId: { type: String, index: true },
    actor: { type: String, default: "careops-agent" },
    type: {
      type: String,
      enum: [
        "case_opened",
        "case_updated",
        "case_resolved",
        "task_created",
        "task_completed",
        "incident_opened",
        "incident_resolved",
        "workflow_started",
        "workflow_step",
        "workflow_resolved",
        "escalation",
        "servicenow_sync",
        "note",
      ],
      required: true,
      index: true,
    },
    summary: { type: String, required: true, trim: true },
    // The agent's stated rationale for this action — what makes the stream read
    // as autonomous decision-making rather than passive logging.
    reasoning: { type: String, trim: true, default: null },
    // Loose links to the records this action touched (no hard refs needed for
    // the audit stream; kept as strings so the action survives deletes).
    refs: {
      caseNumber: { type: String, default: null },
      taskNumber: { type: String, default: null },
      incidentNumber: { type: String, default: null },
      workflowNumber: { type: String, default: null },
    },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.AgentAction || mongoose.model("AgentAction", agentActionSchema);
