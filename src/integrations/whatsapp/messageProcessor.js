"use strict";

// WhatsApp message processor — channel-agnostic reuse of the EXISTING MediFast
// intelligence. It does NOT duplicate medicine logic; it calls the same
// services the Telegram bot uses (conversation context, search, family,
// memory) and emits the SAME events, so CareOps workflows fire identically on
// WhatsApp. Output is plain text (WhatsApp has no HTML parse mode).

const { searchMedicine } = require("../../services/searchService");
const { resolveContextualQuery, setActiveMedicineContext } = require("../../services/conversationContextService");
const { expandMedicineQuery } = require("../../services/medicineAliasService");
const { detectIntent } = require("../../services/intentEngine");
const { emitSearchCompleted } = require("../../services/historyService");
const eventBus = require("../../events/eventBus");
const logger = require("../../utils/logger");

// WhatsApp uses E.164 phone numbers ("wa:<number>") as the identity key so it
// never collides with Telegram numeric ids in the shared context store.
const waKey = (from) => `wa:${from}`;

const stripHtml = (s = "") =>
  String(s)
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

const formatResultText = (result, query) => {
  if (!result || !result.medicineName) return null;
  const lines = [];
  lines.push(`💊 *${result.medicineName}*`);
  if (result.genericName && result.genericName !== result.medicineName) {
    lines.push(`Salt: ${result.genericName}`);
  }
  if (result.category) lines.push(`Category: ${result.category}`);
  if (Array.isArray(result.symptoms) && result.symptoms.length) {
    lines.push(`Used for: ${result.symptoms.slice(0, 3).join(", ")}`);
  }
  if (Array.isArray(result.sideEffects) && result.sideEffects.length) {
    const se = result.sideEffects
      .slice(0, 3)
      .map((s) => (typeof s === "object" ? s.effect : s))
      .filter(Boolean);
    if (se.length) lines.push(`Common side effects: ${se.join(", ")}`);
  }
  if (result.requiresPrescription) lines.push("⚠️ Prescription required.");
  lines.push("");
  lines.push("Reply with a symptom or another medicine, or send your location for nearby pharmacies.");
  lines.push("_Always confirm dosage with a pharmacist or doctor._");
  return lines.join("\n");
};

// Process a single inbound WhatsApp text message and return the reply text.
const processTextMessage = async ({ from, text }) => {
  const id = waKey(from);
  const trimmed = String(text || "").trim();
  if (trimmed.length < 2) {
    return "Send a medicine name like *Dolo 650*, a symptom like *bukhar ki tablet*, or share your location for nearby pharmacies.";
  }

  // Greeting shortcut (mirrors the Telegram handler).
  if (/^(hi|hello|hey|namaste|namaskar|start)$/i.test(trimmed)) {
    return "Hi, I am *MediFast CareOps*. Send a medicine name (e.g. Dolo 650) or a symptom (e.g. gas ki dawa). I will track it as a care workflow.";
  }

  try {
    // 1. Follow-up / context resolution (same engine as Telegram).
    const contextual = await resolveContextualQuery(id, trimmed);
    const effectiveQuery = contextual.query || trimmed;

    // 2. Intent + alias expansion + search (same services).
    const aliasExpansion = expandMedicineQuery(effectiveQuery);
    const intent = detectIntent(aliasExpansion.alias ? aliasExpansion.normalizedQuery : effectiveQuery);
    const normalizedIntentQuery = aliasExpansion.alias ? aliasExpansion.normalizedQuery : intent.normalizedQuery;

    const { results, sos, query: normalizedQuery, suggestions = [] } = await searchMedicine(
      normalizedIntentQuery,
      {
        ...intent,
        searchTerms: [...(intent.searchTerms || []), ...(aliasExpansion.searchTerms || [])],
        categories: [...new Set([...(intent.categories || []), ...(aliasExpansion.categories || [])])],
        alias: aliasExpansion.alias,
      }
    );

    if (!results.length) {
      // Emit the SAME failure event → CareOps opens a shortage incident.
      eventBus.emitSafe("medicine.lookup.failed", {
        telegramId: id,
        query: effectiveQuery,
        normalizedQuery,
        suggestions,
      });
      const hint = suggestions
        .slice(0, 3)
        .map((s) => s.medicineName || s.genericName)
        .filter(Boolean)
        .join(", ");
      return (
        `😔 I could not find "${stripHtml(normalizedQuery)}" in the catalog.\n\n` +
        (hint ? `Did you mean: ${hint}?\n\n` : "") +
        "I have logged a shortage incident and will look for alternatives. You can also try a different spelling or the generic name."
      );
    }

    const top = results[0];
    // Store active context so WhatsApp follow-ups work just like Telegram.
    setActiveMedicineContext(id, {
      medicineName: top.medicineName,
      genericName: top.genericName || top.medicineName,
      query: normalizedQuery,
      confidence: typeof top.confidence === "number" ? top.confidence : 0.9,
    });

    // Emit the SAME success event → CareOps opens a continuity workflow.
    emitSearchCompleted({
      telegramId: id,
      originalQuery: trimmed,
      normalizedQuery,
      intentKey: intent.key,
      topMedicineName: top.medicineName,
    });

    return formatResultText(top, normalizedQuery) || `Found ${top.medicineName}.`;
  } catch (error) {
    logger.error(`WhatsApp processTextMessage error: ${error.message}`);
    return "⚠️ Something went wrong. Please try again in a moment.";
  }
};

// Process an inbound location share → reuse nearby recommendation service.
const processLocationMessage = async ({ from, latitude, longitude }) => {
  try {
    const { recommendNearbyPharmacies } = require("../../pharmacy/pharmacyRecommendationService");
    const recommendation = await recommendNearbyPharmacies({
      telegramId: waKey(from),
      latitude,
      longitude,
    });
    eventBus.emitSafe("nearby.completed", {
      telegramId: waKey(from),
      resultCount: recommendation.ranked?.length || 0,
      radiusKm: recommendation.radiusKm,
    });
    if (!recommendation.ranked?.length) {
      return "📍 No pharmacies found near you yet. Try again or type a medicine name.";
    }
    const lines = [`📍 *${recommendation.ranked.length} pharmacies near you* (within ${recommendation.radiusKm}km)`, ""];
    recommendation.ranked.slice(0, 5).forEach((p, i) => {
      const dist = p.distance ? ` · ${p.distance}` : "";
      const phone = p.phone ? ` · 📞 ${p.phone}` : "";
      lines.push(`${i + 1}. ${stripHtml(p.name)}${dist}${phone}`);
    });
    return lines.join("\n");
  } catch (error) {
    logger.error(`WhatsApp processLocationMessage error: ${error.message}`);
    return "⚠️ Could not process your location right now.";
  }
};

module.exports = { processTextMessage, processLocationMessage, waKey, stripHtml };
