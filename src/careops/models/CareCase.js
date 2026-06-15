"use strict";

// CareCase — ServiceNow-style Case. Represents an ongoing healthcare concern
// for a user or a family member (e.g., "Father's BP medication continuity").
// A Case is the umbrella that Tasks, Incidents, and Workflows attach to.

const mongoose = require("mongoose");

const careCaseSchema = new mongoose.Schema(
  {
    caseNumber: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },
    telegramId: { type: String, index: true },
    channel: { type: String, enum: ["telegram", "whatsapp", "system"], default: "telegram" },
    // Who the case is about — self or a named family member.
    subject: {
      name: { type: String, trim: true, default: "self" },
      relation: { type: String, trim: true, default: "self" },
    },
    category: {
      type: String,
      enum: ["medication_continuity", "family_care", "shortage", "general"],
      default: "general",
      index: true,
    },
    priority: { type: String, enum: ["low", "medium", "high", "critical"], default: "medium" },
    status: {
      type: String,
      enum: ["open", "in_progress", "escalated", "resolved", "closed"],
      default: "open",
      index: true,
    },
    medicine: {
      medicineName: { type: String, trim: true },
      genericName: { type: String, trim: true },
    },
    escalated: { type: Boolean, default: false },
    escalatedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    // Mirrored to ServiceNow when live mode is enabled.
    externalRef: {
      system: { type: String, default: null }, // "servicenow"
      sysId: { type: String, default: null },
      number: { type: String, default: null },
      mode: { type: String, enum: ["mock", "live", null], default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.models.CareCase || mongoose.model("CareCase", careCaseSchema);
