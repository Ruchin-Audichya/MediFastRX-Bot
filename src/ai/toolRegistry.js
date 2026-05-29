const { searchMedicine } = require("../services/searchService");
const { getOrCreateProfile } = require("../services/familyService");
const { getRecentRepeat, getRecentForFamilyMember } = require("../services/historyService");
const { getConversationMemory } = require("../services/memoryService");
const { findNearbyPharmacies } = require("../services/nearbyPharmacyService");
const { answerFromKnowledgeBase, retrieveKnowledge } = require("../services/ragService");
const { retrieveRelevantMemory } = require("../services/memoryService");
const { searchMedicineKnowledge } = require("../medicine/medicineKnowledgeService");
const { recommendNearbyPharmacies } = require("../pharmacy/pharmacyRecommendationService");
const { getMediAtlasContext } = require("../integrations/mediatlas");

const tools = {
  searchMedicine: {
    name: "searchMedicine",
    input: { medicineName: "string", searchTerms: "string[]", categories: "string[]" },
    output: { medicine: "string", availability: "array", confidence: "number" },
    execute: ({ medicineName, options }) => searchMedicine(medicineName, options),
  },
  getFamilyProfile: {
    name: "getFamilyProfile",
    input: { telegramUser: "object" },
    output: { profile: "UserProfile" },
    execute: ({ telegramUser }) => getOrCreateProfile(telegramUser),
  },
  getMemory: {
    name: "getMemory",
    input: { telegramId: "string" },
    output: { facts: "array", conversationSummary: "string" },
    execute: ({ telegramId }) => getConversationMemory(telegramId),
  },
  getRecentRepeat: {
    name: "getRecentRepeat",
    input: { telegramId: "string", normalizedQuery: "string" },
    output: { searchHistory: "SearchHistory|null" },
    execute: ({ telegramId, normalizedQuery }) => getRecentRepeat(telegramId, normalizedQuery),
  },
  getRecentForFamilyMember: {
    name: "getRecentForFamilyMember",
    input: { telegramId: "string", familyMemberName: "string" },
    output: { searchHistory: "SearchHistory|null" },
    execute: ({ telegramId, familyMemberName }) => getRecentForFamilyMember(telegramId, familyMemberName),
  },
  findNearbyPharmacies: {
    name: "findNearbyPharmacies",
    input: { latitude: "number", longitude: "number", radiusKm: "number" },
    output: { pharmacies: "array", radiusKm: "number" },
    execute: findNearbyPharmacies,
  },
  recommendNearbyPharmacies: {
    name: "recommendNearbyPharmacies",
    input: { latitude: "number", longitude: "number", medicineQuery: "string" },
    output: { ranked: "array", radiusKm: "number", inventoryMatchCount: "number" },
    execute: recommendNearbyPharmacies,
  },
  ragLookup: {
    name: "ragLookup",
    input: { query: "string", metadata: "object" },
    output: { answer: "string", sources: "array" },
    execute: ({ query, metadata }) => answerFromKnowledgeBase(query, metadata),
  },
  retrieveKnowledge: {
    name: "retrieveKnowledge",
    input: { question: "string", medicineScope: "object?" },
    output: { context: "array", confidence: "number" },
    // Forward medicineScope so the orchestrator can scope RAG to the active
    // MedicineContext (Phase 5 of medicine-context-integrity bugfix).
    execute: ({ question, metadata, medicineScope }) =>
      retrieveKnowledge({ question, metadata, medicineScope }),
  },
  retrieveRelevantMemory: {
    name: "retrieveRelevantMemory",
    input: { telegramId: "string", query: "string" },
    output: { facts: "array", confidence: "number" },
    execute: ({ telegramId, query }) => retrieveRelevantMemory({ telegramId, query }),
  },
  searchMedicineKnowledge: {
    name: "searchMedicineKnowledge",
    input: { query: "string" },
    output: { medicine: "object", alternatives: "array", confidence: "number" },
    execute: ({ query }) => searchMedicineKnowledge({ query }),
  },
  getMediAtlasContext: {
    name: "getMediAtlasContext",
    input: {
      q: "string",
      latitude: "number?",
      longitude: "number?",
      radiusKm: "number?",
      city: "string?",
      alsoTaking: "string[]?",
      includeAvailability: "boolean?",
      includeDrug: "boolean?",
      includeInteractions: "boolean?",
      limit: "number?",
    },
    output: {
      ok: "boolean",
      disabled: "boolean?",
      value: "object?",
      error: "object?",
      requestId: "string?",
    },
    // Feature-flagged in the implementation: returns
    // { ok:false, disabled:true } when ENABLE_MEDIATLAS != "true".
    // Wired here so toolExecutor / orchestrator can plan around it as soon
    // as MediAtlas Sprint 1 ships and the flag flips.
    execute: (input) => getMediAtlasContext(input),
  },
};

const getTool = (name) => tools[name];
const listTools = () => Object.values(tools).map(({ execute, ...tool }) => tool);
const toLangChainTools = () => {
  try {
    const { DynamicTool } = require("@langchain/core/tools");
    return Object.values(tools).map(
      (registeredTool) =>
        new DynamicTool({
          name: registeredTool.name,
          description: `MediFast tool. Input contract: ${JSON.stringify(registeredTool.input)}. Output contract: ${JSON.stringify(registeredTool.output)}.`,
          func: async (input) => {
            const parsed = typeof input === "string" && input.trim().startsWith("{") ? JSON.parse(input) : { query: input };
            const result = await registeredTool.execute(parsed);
            return JSON.stringify(result);
          },
        })
    );
  } catch {
    return [];
  }
};

module.exports = {
  getTool,
  listTools,
  toLangChainTools,
  tools,
};
