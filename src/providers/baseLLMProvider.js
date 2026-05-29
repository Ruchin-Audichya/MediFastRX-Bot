"use strict";

// Phase 5 / Task 7.1 of the medicine-context-integrity bugfix.
//
// `buildPrompt` produces a focused, ChatGPT-quality user message for the LLM.
// When `evidence.medicineContext.medicine.medicineName` is present, the prompt
// is grounded ONLY on the active medicine + validated retrieved evidence and
// instructs the model never to invent stock/dosage/side-effects/contraindi-
// cations and to ask one short clarifying question on low confidence. When
// no medicine is resolved, the original generic prompt structure is used so
// non-medicine flows are byte-for-byte identical (preservation contract).
//
// Helpers `extractValidatedRagContext` and `extractEnrichment` are exported
// so Task 7.4 can unit-test them without exercising the full provider.

const isObject = (value) => value !== null && typeof value === "object";

const extractValidatedRagContext = (evidence, fallbackContext = []) => {
  const fromEvidence = evidence && evidence.ragContext && evidence.ragContext.context;
  if (Array.isArray(fromEvidence) && fromEvidence.length) {
    // Phase 4's evidence integrity guard already filtered. Be defensive in
    // case a caller supplies pre-guard items.
    return fromEvidence.filter((item) => item && item.belongsToActiveMedicine !== false);
  }
  return Array.isArray(fallbackContext) ? fallbackContext : [];
};

const extractEnrichment = (evidence) => {
  const enrichment = evidence
    && evidence.medicineContext
    && evidence.medicineContext.medicine
    && evidence.medicineContext.medicine.enrichment;
  if (!isObject(enrichment)) return null;
  const present = {};
  for (const key of ["inventory", "forecast", "substitutes", "pharmacies"]) {
    if (enrichment[key] !== null && enrichment[key] !== undefined) {
      present[key] = enrichment[key];
    }
  }
  return Object.keys(present).length ? present : null;
};

class BaseLLMProvider {
  constructor(options = {}) {
    this.options = options;
  }

  buildPrompt({ prompt = "", context = [], memory = [], evidence = null } = {}) {
    const med = evidence
      && evidence.medicineContext
      && evidence.medicineContext.medicine;
    if (!med || !med.medicineName) {
      return this._buildGenericPrompt({ prompt, context, memory, evidence });
    }
    return this._buildMedicineGroundedPrompt({ prompt, context, memory, evidence, med });
  }

  // Preservation path — identical structure to today so non-medicine flows
  // (symptom education, family-only, low-confidence text) are unchanged.
  _buildGenericPrompt({ prompt, context, memory, evidence }) {
    const contextText = (context || [])
      .map((item, index) => `${index + 1}. ${item.text || item}`)
      .join("\n");
    const memoryText = (memory || [])
      .map((fact) => `${fact.entity || "memory"}: ${fact.value || fact.text || ""}`)
      .join("\n");
    const evidenceText = evidence ? JSON.stringify(evidence, null, 2).slice(0, 12000) : "";
    return [
      "You are MediFast AI, an India-first medicine discovery assistant.",
      "Use retrieved context and tool results only. Do not invent medicines, pharmacy stock, side effects, or dosage.",
      "If evidence is weak or missing, ask a short clarification question instead of guessing.",
      "Keep confidence and safety warnings intact. Keep the answer concise and safety-first.",
      evidenceText && `Structured evidence:\n${evidenceText}`,
      memoryText && `Relevant memory:\n${memoryText}`,
      contextText && `Retrieved context:\n${contextText}`,
      `User question:\n${prompt}`,
    ].filter(Boolean).join("\n\n");
  }

  // Grounded path — leads with the active MedicineContext and only uses
  // validated retrieved evidence + (optional) live enrichment.
  _buildMedicineGroundedPrompt({ prompt, context, memory, evidence, med }) {
    const validated = extractValidatedRagContext(evidence, context);
    const ragText = validated
      .slice(0, 5)
      .map((c, i) => `${i + 1}. ${String(c.text || "").trim()}`)
      .filter((line) => line.length > 3)
      .join("\n");

    const altSource = (evidence && evidence.medicineContext && evidence.medicineContext.alternatives) || [];
    const alternatives = altSource
      .map((a) => (a && (a.medicineName || a.genericName)) || null)
      .filter(Boolean)
      .slice(0, 5)
      .join(", ");

    const relSource = (evidence && evidence.medicineContext && evidence.medicineContext.relationships) || [];
    const relationships = relSource
      .map((r) => `${r && r.type ? r.type : "related"}: ${(r && r.from) || ""} -> ${(r && r.to) || ""}`)
      .filter((line) => line.length > 4)
      .slice(0, 5)
      .join("; ");

    const enrichment = extractEnrichment(evidence);
    // Truncate the enrichment payload so token usage stays bounded even when
    // MediAtlas returns a large response (kept well under the 12k evidence
    // cap used in the generic path).
    const enrichmentText = enrichment ? JSON.stringify(enrichment).slice(0, 4000) : "";

    const memoryText = (memory || [])
      .map((fact) => `${fact.entity || "memory"}: ${fact.value || fact.text || ""}`)
      .filter((line) => line.length > 4)
      .join("\n");

    const headerLine = `Active medicine: ${med.medicineName}${
      med.genericName && med.genericName !== med.medicineName ? ` (generic: ${med.genericName})` : ""
    }.`;

    return [
      "You are MediFast AI. Answer ONLY about the active medicine below using the supplied evidence.",
      headerLine,
      med.category ? `Category: ${med.category}.` : null,
      "Grounding rules:",
      "1. Use only the evidence below. Do not invent stock, prices, dosage, side effects, contraindications, or pharmacy names.",
      "2. If the evidence does not contain the answer, say 'I do not have that information confidently' and ask one short clarifying question.",
      "3. Be concise and friendly: 2-4 short sentences. No headers, no bullet lists unless the user asked for them.",
      "4. Keep safety warnings intact when present in the evidence.",
      ragText && `Validated retrieved evidence:\n${ragText}`,
      alternatives && `Alternatives (validated): ${alternatives}.`,
      relationships && `Relationships: ${relationships}.`,
      enrichmentText && `Live enrichment (inventory/forecast/substitutes/pharmacies): ${enrichmentText}`,
      memoryText && `Relevant user memory:\n${memoryText}`,
      `User question:\n${prompt}`,
    ].filter(Boolean).join("\n\n");
  }

  async generate() {
    throw new Error("LLM provider must implement generate().");
  }
}

module.exports = BaseLLMProvider;
module.exports.extractValidatedRagContext = extractValidatedRagContext;
module.exports.extractEnrichment = extractEnrichment;
