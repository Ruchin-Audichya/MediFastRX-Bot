"use strict";

// E2E-ish test for the Telegram search handler (`handleSearch`). Closes the
// audit gap: the user-visible reply path had no automated coverage.
//
// Strategy: stub the heavy service modules via require.cache BEFORE requiring
// search.js, and drive the handler with a recording fake grammY `ctx`. We
// assert the USER ACTUALLY RECEIVES A REPLY for the key flows — which the
// engine-level tests never verified.
//
// No Mongo, no network, no Groq, no Telegram.

const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { stubModule, REPO_ROOT } = require("./_mocks/installShims");

// Ensure conversational mode + two-stage are ON (defaults) for the test.
delete process.env.CONVERSATIONAL_MODE;
delete process.env.ENABLE_TWO_STAGE_SEND;

// --- Stub heavy/IO modules BEFORE requiring search.js ----------------------

// searchMedicine: returns a confident catalog hit for "Dolo 650", empty for unknown.
stubModule("src/services/searchService.js", {
  searchMedicine: async (q) => {
    const query = String(q || "").toLowerCase();
    if (query.includes("dolo") || query.includes("paracetamol")) {
      return {
        results: [
          {
            _id: "med1",
            medicineName: "Dolo 650",
            genericName: "Paracetamol",
            category: "painkiller",
            symptoms: ["fever", "pain"],
            sideEffects: ["nausea"],
            confidence: 0.95,
            knowledgeOnly: true,
          },
        ],
        sos: false,
        query: "Dolo 650",
        suggestions: [],
      };
    }
    return { results: [], sos: true, query: q, suggestions: [] };
  },
  searchMedicineFull: async () => [],
  createSosRequest: async () => ({ created: true }),
  getOpenSosRequests: async () => [],
});

// Orchestrator: returns a deterministic-ish workflow with a Groq-style answer.
stubModule("src/orchestrator/orchestrator.js", {
  runMediFastWorkflow: async () => ({
    generated: { text: "Dolo 650 is commonly used for fever and mild pain relief.", skipped: false },
    knowledge: { sources: [], context: [], confidence: 0.9 },
    memory: [],
    evidence: { medicineContext: { medicine: { medicineName: "Dolo 650", symptoms: ["fever"] } } },
    debug: { toolSequence: [], providerLatencyMs: 10 },
  }),
  llmSynthesisEnabled: () => true,
});

// Family/history/memory/profile — no-ops that return safe shapes.
stubModule("src/services/familyService.js", {
  findMentionedFamilyMember: () => null,
  getOrCreateProfile: async () => ({ familyMembers: [], preferredLanguage: "english" }),
  setLanguage: async () => {},
});
stubModule("src/services/historyService.js", {
  emitSearchCompleted: () => {},
  getRecentForFamilyMember: async () => null,
  getRecentRepeat: async () => null,
  recordSearch: async () => {},
});
stubModule("src/services/memoryService.js", {
  addConversationTurn: async () => ({ facts: [] }),
});
stubModule("src/pharmacy/pharmacyLocationService.js", {
  getSessionLocation: async () => null,
  shareLocationKeyboard: () => ({ keyboard: [] }),
  formatDistance: (d) => `${d} km`,
  getPharmacyCoordinates: () => null,
  haversineDistanceKm: () => null,
  normalizeCoordinates: () => null,
});
// Apollo + augment disabled so the unknown path is deterministic.
stubModule("src/integrations/parse/apolloMedicineClient.js", {
  isEnabled: () => false,
  search: async () => ({ ok: false, disabled: true, results: [] }),
  health: () => ({ mode: "disabled" }),
});
stubModule("src/medicine/llmAugmentService.js", {
  augmentUnknownMedicine: async () => ({ ok: false, augmented: false }),
  suggestMedicinesForNeed: async () => ({ ok: false, suggestions: [] }),
  looksLikeMedicineQuery: () => true,
  looksLikeMedicineNeed: () => false,
  stripUnsafeLines: (t) => t,
});
// CareOps workflow engine — record calls, return a fake incident with a number.
const careOpsCalls = [];
stubModule("src/careops/workflowEngine.js", {
  runMedicineShortage: async (args) => {
    careOpsCalls.push({ fn: "runMedicineShortage", args });
    return { incident: { incidentNumber: "INCTEST001", externalRef: { number: "INC0099999" }, status: "escalated" } };
  },
  runFamilyMedicationShortage: async (args) => {
    careOpsCalls.push({ fn: "runFamilyMedicationShortage", args });
    return { incident: { incidentNumber: "INCTEST002", externalRef: { number: "INC0088888" }, status: "escalated" } };
  },
  runMedicationContinuity: async () => ({}),
  runFamilyCare: async () => ({}),
  runFollowUpTask: async () => ({}),
  runMedicationFulfillment: async () => ({}),
});

// Now require the handler — it will pick up all stubs.
const { handleSearch } = require(path.join(REPO_ROOT, "src/bot/commands/search.js"));

// --- Recording fake grammY ctx ---------------------------------------------
const makeCtx = (fromId = 12345) => {
  const sent = [];
  const edited = [];
  return {
    from: { id: fromId, first_name: "Test" },
    chat: { id: fromId },
    sent,
    edited,
    reply: async (text, opts) => {
      sent.push({ text, opts });
      return { message_id: sent.length };
    },
    replyWithChatAction: async () => {},
    api: {
      editMessageText: async (chatId, messageId, text, opts) => {
        edited.push({ text, opts });
      },
      deleteMessage: async () => {},
    },
  };
};

test("known medicine → user receives a conversational reply mentioning the medicine", async () => {
  const ctx = makeCtx();
  await handleSearch(ctx, "Dolo 650");
  const allText = [...ctx.sent.map((s) => s.text), ...ctx.edited.map((e) => e.text)].join("\n");
  assert.match(allText, /Dolo 650/, "user should see the medicine name");
  assert.ok(ctx.sent.length + ctx.edited.length > 0, "user must receive at least one message");
});

test("known medicine → the AI narrative reaches the user", async () => {
  const ctx = makeCtx(222);
  await handleSearch(ctx, "Dolo 650");
  const allText = [...ctx.sent.map((s) => s.text), ...ctx.edited.map((e) => e.text)].join("\n");
  assert.match(allText, /fever/i, "the Groq narrative (fever/pain) should reach the user");
});

test("unknown medicine → user gets a reply and a CareOps incident is created inline", async () => {
  careOpsCalls.length = 0;
  const ctx = makeCtx(333);
  await handleSearch(ctx, "Zxqwlmed");
  const allText = [...ctx.sent.map((s) => s.text), ...ctx.edited.map((e) => e.text)].join("\n");
  assert.ok(ctx.sent.length > 0, "user must receive a reply for an unknown medicine");
  assert.ok(
    careOpsCalls.some((c) => c.fn === "runMedicineShortage" || c.fn === "runFamilyMedicationShortage"),
    "an inline CareOps shortage operation should be created"
  );
  // The live incident number should surface in chat.
  assert.match(allText, /INC00\d+/, "the ServiceNow incident number should be shown to the user");
});

test("too-short query → helpful prompt, no crash", async () => {
  const ctx = makeCtx(444);
  await handleSearch(ctx, "a");
  assert.ok(ctx.sent.length > 0);
  assert.match(ctx.sent[0].text, /medicine name/i);
});

test("greeting → friendly onboarding, no search", async () => {
  const ctx = makeCtx(555);
  await handleSearch(ctx, "hi");
  assert.match(ctx.sent[0].text, /MediFast/i);
});
