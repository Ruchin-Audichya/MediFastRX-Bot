"use strict";

// careOpsListener — subscribes to events MediFast ALREADY emits and turns them
// into CareOps operations. This is the entire integration surface: no core
// medicine/pharmacy/memory code is modified. Because the bot uses
// `eventBus.emitSafe`, a throw in any handler here is isolated and never
// affects the user-facing conversation.
//
// Event → CareOps mapping (all reuse existing emitters):
//   search.completed        → Medication Continuity workflow (+ family care if
//                             a family member is the subject)
//   medicine.lookup.failed  → Medicine Shortage workflow (Incident + escalate)
//   side_effect.query       → Follow-up Agent Task on the active case
//   nearby.completed        → advances continuity workflow (pharmacy located)

const engine = require("./workflowEngine");
const logger = require("../utils/logger");

// Guard so double-registration (tests + bot) doesn't double-handle events.
let registered = false;

const registerCareOpsListener = (eventBus) => {
  if (registered) return;
  registered = true;

  // ---- Successful medicine search → continuity (+ optional family care) -----
  eventBus.on("search.completed", (payload = {}) => {
    const {
      telegramId,
      topMedicineName,
      normalizedQuery,
      familyMemberName,
    } = payload;
    if (!topMedicineName) return;

    const medicine = { medicineName: topMedicineName, genericName: payload.genericName };

    engine
      .runMedicationContinuity({ telegramId, medicine })
      .catch((e) => logger.error(`careops continuity error: ${e.message}`));

    if (familyMemberName) {
      engine
        .runFamilyCare({
          telegramId,
          member: { name: familyMemberName, relation: payload.relation || "family" },
          medicine,
        })
        .catch((e) => logger.error(`careops family error: ${e.message}`));
    }
  });

  // ---- Failed lookup → shortage (incident + alternatives/escalation) --------
  // When a family member is named, run the flagship composite journey
  // (Family Case + Shortage Workflow + Incident + follow-up Task).
  eventBus.on("medicine.lookup.failed", (payload = {}) => {
    // If the search handler already created the shortage operation inline (so
    // it could surface the live incident number in chat), skip here to avoid
    // duplicate incidents.
    if (payload.handledInline) return;
    const { telegramId, query, normalizedQuery, familyMemberName, relation } = payload;
    const alternatives = Array.isArray(payload.suggestions)
      ? payload.suggestions.map((s) => s.medicineName || s.genericName || s).filter(Boolean)
      : [];
    const medicine = { medicineName: normalizedQuery || query };

    if (familyMemberName || (relation && relation !== "self")) {
      engine
        .runFamilyMedicationShortage({
          telegramId,
          member: { name: familyMemberName || relation, relation: relation || "family" },
          medicine,
          query: normalizedQuery || query,
          alternatives,
        })
        .catch((e) => logger.error(`careops family-shortage error: ${e.message}`));
      return;
    }

    engine
      .runMedicineShortage({
        telegramId,
        query: normalizedQuery || query,
        medicine,
        reason: "medicine_not_found",
        alternatives,
      })
      .catch((e) => logger.error(`careops shortage error: ${e.message}`));
  });

  // ---- Follow-up (side-effects etc.) → agent task ---------------------------
  eventBus.on("side_effect.query", (payload = {}) => {
    const { telegramId, medicine, query } = payload;
    if (!medicine) return;
    engine
      .runFollowUpTask({
        telegramId,
        medicine: { medicineName: medicine },
        question: query,
      })
      .catch((e) => logger.error(`careops followup error: ${e.message}`));
  });

  // ---- Nearby completed → note that pharmacy discovery ran ------------------
  // We don't have the workflow id here, but the continuity workflow for this
  // user/medicine is already open; the AgentAction stream records the discovery
  // for the dashboard narrative. Kept lightweight to avoid extra queries.
  eventBus.on("nearby.completed", (payload = {}) => {
    const { telegramId, resultCount } = payload;
    if (!telegramId) return;
    const svc = require("./careOpsService");
    svc
      .logAction("note", `Pharmacy discovery ran (${resultCount || 0} matches)`, {
        telegramId: String(telegramId),
        metadata: { resultCount },
      })
      .catch((e) => logger.error(`careops nearby note error: ${e.message}`));
  });

  logger.info("CareOps listener registered (continuity / shortage / family / follow-up).");
};

// Test helper to reset the registration guard between suites.
const __resetForTests = () => {
  registered = false;
};

module.exports = { registerCareOpsListener, __resetForTests };
