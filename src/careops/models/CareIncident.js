"use strict";

// CareIncident — ServiceNow-style Incident. Raised when something blocks care:
// a medicine is unavailable / not found, a pharmacy can't be located, or a
// refill is missed. Incidents are the records judges recognize most clearly as
// "operations", and they drive alternative-search + escalation.

const mongoose = require("mongoose");

const careIncidentSchema = new mongoose.Schema(
  {
    incidentNumber: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    telegramId: { type: String, index: true },
    caseId: { type: mongoose.Schema.Types.ObjectId, ref: "CareCase", index: true, default: null },
    workflowId: { type: mongoose.Schema.Types.ObjectId, ref: "CareWorkflow", index: true, default: null },
    category: {
      type: String,
      enum: ["medicine_unavailable", "medicine_not_found", "no_pharmacy", "missed_refill", "other"],
      default: "other",
      index: true,
    },
    medicine: {
      medicineName: { type: String, trim: true },
      genericName: { type: String, trim: true },
    },
    impact: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    urgency: { type: String, enum: ["low", "medium", "high"], default: "medium" },
    priority: { type: String, enum: ["low", "medium", "high", "critical"], default: "high" },
    status: {
      type: String,
      enum: ["open", "investigating", "escalated", "resolved", "closed"],
      default: "open",
      index: true,
    },
    alternativesSuggested: [{ type: String, trim: true }],
    escalated: { type: Boolean, default: false },
    escalatedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolutionNote: { type: String, trim: true, default: "" },
    // SLA tracking — ServiceNow-style due date + breach flag. Set on creation
    // based on priority; resolution before slaDueAt = compliant.
    slaDueAt: { type: Date, default: null },
    slaBreached: { type: Boolean, default: false },
    externalRef: {
      system: { type: String, default: null },
      sysId: { type: String, default: null },
      number: { type: String, default: null },
      mode: { type: String, enum: ["mock", "live", null], default: null },
    },
  },
  { timestamps: true }
);

module.exports =
  mongoose.models.CareIncident || mongoose.model("CareIncident", careIncidentSchema);
