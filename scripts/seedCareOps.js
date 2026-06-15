"use strict";

// Demo seed for MediFast CareOps. Produces a believable operations board so the
// dashboard (GET /careops) and `/careops` Telegram command show a full story
// within seconds — without needing a live conversation first.
//
//   npm run demo:careops
//
// Idempotent-ish: clears prior CareOps demo records (those tagged demo:true via
// metadata is overkill; we simply wipe the four CareOps collections + actions
// so the board is clean for the demo run).

require("dotenv").config();
const connectDB = require("../config/database");
const mongoose = require("mongoose");
const engine = require("../src/careops/workflowEngine");
const svc = require("../src/careops/careOpsService");
const CareCase = require("../src/careops/models/CareCase");
const CareTask = require("../src/careops/models/CareTask");
const CareIncident = require("../src/careops/models/CareIncident");
const CareWorkflow = require("../src/careops/models/CareWorkflow");
const AgentAction = require("../src/careops/models/AgentAction");
const logger = require("../src/utils/logger");

const DEMO_USER = "demo-judge";

const run = async () => {
  await connectDB();

  // Clean slate for a crisp demo.
  await Promise.all([
    CareCase.deleteMany({}),
    CareTask.deleteMany({}),
    CareIncident.deleteMany({}),
    CareWorkflow.deleteMany({}),
    AgentAction.deleteMany({}),
  ]);
  logger.info("CareOps demo: cleared prior records.");

  // 1. Medication continuity — happy path (pharmacy found).
  await engine.runMedicationContinuity({
    telegramId: DEMO_USER,
    medicine: { medicineName: "Dolo 650", genericName: "Paracetamol" },
    pharmacyFound: true,
    pharmacyName: "Apollo Pharmacy, Vaishali Nagar",
  });

  // 2. Follow-up agent task on the active medicine.
  await engine.runFollowUpTask({
    telegramId: DEMO_USER,
    medicine: { medicineName: "Dolo 650" },
    question: "Can my father take it with his BP medicine?",
  });

  // 3. Family care — father's BP medicine, with refill reminder.
  await engine.runFamilyCare({
    telegramId: DEMO_USER,
    member: { name: "Papa", relation: "father" },
    medicine: { medicineName: "Telma 40", genericName: "Telmisartan" },
  });

  // 4. Flagship: father's Pregabalin unavailable → Family Case + Shortage
  //    Workflow + Incident + escalation + follow-up task (the headline journey).
  await engine.runFamilyMedicationShortage({
    telegramId: DEMO_USER,
    member: { name: "Papa", relation: "father" },
    medicine: { medicineName: "Pregabalin 75", genericName: "Pregabalin" },
    query: "Pregabalin 75",
    alternatives: [],
  });

  // 5. Medicine shortage — resolved via alternatives (self).
  await engine.runMedicineShortage({
    telegramId: DEMO_USER,
    medicine: { medicineName: "Mycophenolate 500mg", genericName: "Mycophenolate Mofetil" },
    query: "Mycophenolate 500mg",
    reason: "no_pharmacy",
    alternatives: ["Mofilet 500", "Cellcept 500"],
  });

  // ---- Realism pass --------------------------------------------------------
  // Records created above resolve instantly, which makes MTTR read as 0 min and
  // SLA as trivially 100%. Backdate created/resolved timestamps so the KPIs
  // reflect a believable operations day: a spread of resolution times and one
  // SLA breach. Cosmetic demo data only — the live conversation path is
  // unaffected. INVARIANT: resolvedAt = createdAt + durationMinutes (always
  // after createdAt) so MTTR is always positive.
  const minsAgo = (m) => new Date(Date.now() - m * 60 * 1000);
  const SLA_HIGH_MIN = 240;

  const resolvedIncidents = await CareIncident.find({ status: "resolved" }).sort({ createdAt: 1 });
  const startMinsAgo = [185, 150, 95, 60]; // when each incident was opened
  const durations = [22, 41, 35, 18]; // how long each took to resolve
  // Use the raw MongoDB collection to set createdAt — mongoose protects
  // createdAt on model updates even with timestamps:false, so we bypass it.
  const coll = CareIncident.collection;
  for (let i = 0; i < resolvedIncidents.length; i++) {
    const inc = resolvedIncidents[i];
    const openedAt = minsAgo(startMinsAgo[i % startMinsAgo.length]);
    const dur = durations[i % durations.length];
    const resolvedAt = new Date(openedAt.getTime() + dur * 60 * 1000);
    const slaDueAt = new Date(openedAt.getTime() + SLA_HIGH_MIN * 60 * 1000);
    await coll.updateOne(
      { _id: inc._id },
      { $set: { createdAt: openedAt, resolvedAt, slaDueAt, slaBreached: resolvedAt > slaDueAt } }
    );
  }

  // Make the escalated incident a realistic SLA breach: opened 5h ago, took
  // 265 min to resolve (> 240 min SLA target) → breached but resolved.
  const escalated = await CareIncident.findOne({ escalated: true }).sort({ createdAt: 1 });
  if (escalated) {
    const openedAt = minsAgo(300);
    const resolvedAt = new Date(openedAt.getTime() + 265 * 60 * 1000);
    const slaDueAt = new Date(openedAt.getTime() + SLA_HIGH_MIN * 60 * 1000);
    await coll.updateOne(
      { _id: escalated._id },
      {
        $set: {
          status: "resolved",
          createdAt: openedAt,
          resolvedAt,
          slaDueAt,
          slaBreached: true,
          resolutionNote: "Sourced via SOS network after escalation",
        },
      }
    );
  }

  const snap = await svc.getDashboardSnapshot();
  logger.info("CareOps demo seed complete.");
  console.log("\n=== CareOps Demo Snapshot ===");
  console.log(`SLA compliance:  ${snap.metrics.slaCompliancePct}%`);
  console.log(`MTTR:            ${snap.metrics.mttrMinutes} min`);
  console.log(`Incident resol.: ${snap.metrics.incidentResolutionRate}%`);
  console.log(`Open cases:      ${snap.counts.openCases}`);
  console.log(`Open tasks:      ${snap.counts.openTasks}`);
  console.log(`Open incidents:  ${snap.counts.openIncidents}`);
  console.log(`Active workflows:${snap.counts.openWorkflows}`);
  console.log(`Escalations:     ${snap.counts.escalations}`);
  console.log(`Agent actions:   ${snap.recentActions.length} (most recent shown on dashboard)`);
  console.log("\nOpen the dashboard:  GET http://localhost:3001/careops");
  console.log("Telegram summary:    /careops\n");

  await mongoose.connection.close();
  process.exit(0);
};

run().catch((error) => {
  logger.error(`CareOps demo seed failed: ${error.message}`);
  process.exit(1);
});
