const { searchMedicine } = require("../../services/searchService");
const { detectIntent } = require("../../services/intentEngine");
const { expandMedicineQuery } = require("../../services/medicineAliasService");
const { extractEntities } = require("../../ai/entityExtractor");
const { routeMessage } = require("../../ai/router");
const { assessSafety } = require("../../ai/safetyGuard");
const { findMentionedFamilyMember, getOrCreateProfile } = require("../../services/familyService");
const { emitSearchCompleted, getRecentForFamilyMember, getRecentRepeat } = require("../../services/historyService");
const { addConversationTurn } = require("../../services/memoryService");
const { answerFromKnowledgeBase } = require("../../services/ragService");
const { getSessionLocation, shareLocationKeyboard } = require("../../pharmacy/pharmacyLocationService");
const { handleNearbyMedicineSearch } = require("./nearby");
const { runMediFastWorkflow } = require("../../orchestrator/orchestrator");
const { resolveContextualQuery, setActiveMedicineContext, getActiveContext } = require("../../services/conversationContextService");
const { augmentUnknownMedicine, suggestMedicinesForNeed, looksLikeMedicineQuery, looksLikeMedicineNeed } = require("../../medicine/llmAugmentService");
const apolloMedicineClient = require("../../integrations/parse/apolloMedicineClient");
const eventBus = require("../../events/eventBus");
const {
  formatSearchResults,
  formatMedicineCard,
  formatApolloResults,
  formatConversationalMedicine,
  buildQuickActionKeyboard,
  formatNotFound,
  formatReorderPrompt,
  formatSearchFollowUp,
  buildSearchActionKeyboard,
  formatMemorySaved,
  escapeHtml,
} = require("../../utils/formatter");
const logger = require("../../utils/logger");

// Conversational mode (UX redesign): short, WhatsApp-like medicine replies with
// quick-action buttons instead of the verbose card. Default ON; set
// CONVERSATIONAL_MODE=false to fall back to the legacy medicine card.
const CONVERSATIONAL_MODE = () => process.env.CONVERSATIONAL_MODE !== "false";

// ---------------------------------------------------------------------------
// Phase 6 / Task 8.3 — two-stage send scaffold + typing indicator on slow LLM paths.
//
// Today the LLM resolves before the reply (`runMediFastWorkflow` returns the
// full provider text), so a true "send instant card, then editMessageText"
// pipeline would require issuing the LLM call in parallel with search. That
// is a future optimization. For now this module:
//
//   1. Exposes the env-flag helpers required by Task 8.5's tests
//      (`TWO_STAGE_SEND_ENABLED`, `LLM_EDIT_BUDGET_MS`, `TYPING_THRESHOLD_MS`).
//   2. Triggers a `ctx.replyWithChatAction("typing")` once before the final
//      reply when the Groq path has been spending more than
//      `TYPING_THRESHOLD_MS` (default 800ms) on this turn — gives the user a
//      visible signal that something is happening.
//   3. Keeps every other code path byte-for-byte identical to today.
//
// The flags are intentionally read each call (function form, not constant)
// so tests can flip env vars between subtests without re-requiring the module.
// ---------------------------------------------------------------------------
const TWO_STAGE_SEND_ENABLED = () =>
  process.env.ENABLE_TWO_STAGE_SEND !== "false"; // default ON
const LLM_EDIT_BUDGET_MS = () =>
  Number(process.env.LLM_EDIT_BUDGET_MS || 2500);
const TYPING_THRESHOLD_MS = () =>
  Number(process.env.TYPING_THRESHOLD_MS || 800);

const isGreeting = (text = "") =>
  /^(hi|hello|hey|namaste|namaskar|ji|haan|han|yes|yo|hii|helo)$/i.test(String(text).trim());

/**
 * Handles /search <medicine> command and plain text messages.
 * @param {import("grammy").Context} ctx
 * @param {string} query - the medicine name to search
 */
const handleSearch = async (ctx, query, contextOptions = {}) => {
  if (!query || query.trim().length < 2) {
    return ctx.reply(
      "Please provide a medicine name.\nExample: /search Paracetamol",
      { parse_mode: "HTML" }
    );
  }

  if (isGreeting(query)) {
    return ctx.reply(
      "Hi, I am MediFast AI. Send a medicine name like <code>Dolo 650</code>, a symptom like <code>bukhar ki tablet</code>, or use /nearby to find pharmacies.",
      { parse_mode: "HTML" }
    );
  }

  // Show typing indicator
  await ctx.replyWithChatAction("typing");

  const handlerStartedAt = Date.now();
  try {
    const contextual = contextOptions.usedContext
      ? { query, ...contextOptions }
      : await resolveContextualQuery(ctx.from.id, query);
    const effectiveQuery = contextual.query || query;
    const activeCtxFromContextual = (contextual && contextual.context) || null;
    const profile = await getOrCreateProfile(ctx.from);
    const entities = extractEntities(effectiveQuery, profile);
    const routes = routeMessage({ entities, profile });
    const aliasExpansion = expandMedicineQuery(effectiveQuery);
    const intent = detectIntent(aliasExpansion.alias ? aliasExpansion.normalizedQuery : effectiveQuery);
    const mentionedMember = findMentionedFamilyMember(profile, effectiveQuery);
    const familyTarget = mentionedMember || (entities.person && entities.person !== "self"
      ? { name: entities.familyMemberName || entities.person, relation: entities.person, ageGroup: "adult" }
      : null);
    const safety = assessSafety({ entities, intent, mentionedMember, query: effectiveQuery });
    const userLocation = await getSessionLocation(ctx.from.id);
    if (entities.intentType === "side_effects") {
      eventBus.emitSafe("side_effect.query", {
        telegramId: ctx.from.id,
        query: effectiveQuery,
        medicine: entities.medicine,
      });
    }

    if (/\b(reorder|repeat|refill|phir se|dobara)\b/i.test(effectiveQuery) && mentionedMember) {
      const recent = await getRecentForFamilyMember(ctx.from.id, mentionedMember.name);
      await addConversationTurn({ telegramId: ctx.from.id, userText: effectiveQuery, entities });
      return ctx.reply(formatReorderPrompt(mentionedMember, recent), {
        parse_mode: "HTML",
        reply_markup: recent?.topMedicineName
          ? {
              inline_keyboard: [
                [
                  {
                    text: "🔍 Check Availability",
                    callback_data: `search_intent:${recent.topMedicineName.substring(0, 50)}`,
                  },
                ],
                [{ text: "📍 Nearby Pharmacy", callback_data: "nearby:open" }],
              ],
            }
          : undefined,
      });
    }

    const genericFamilyMedicineAsk = /\b(medicine|tablet|dawa|goli|meds?)\b/i.test(effectiveQuery) && familyTarget && !entities.symptom && !entities.medicine;
    if (genericFamilyMedicineAsk) {
      const recent = await getRecentForFamilyMember(ctx.from.id, familyTarget.name);
      await addConversationTurn({ telegramId: ctx.from.id, userText: effectiveQuery, entities });
      return ctx.reply(formatReorderPrompt(familyTarget, recent), {
        parse_mode: "HTML",
        reply_markup: recent?.topMedicineName
          ? {
              inline_keyboard: [
                [{ text: "🔍 Check Availability", callback_data: `search_intent:${recent.topMedicineName.substring(0, 50)}` }],
                [{ text: "📍 Nearby Pharmacy", callback_data: "nearby:open" }],
              ],
            }
          : undefined,
      });
    }

    if (entities.condition && familyTarget && !entities.symptom && !entities.medicine && !entities.nearbyIntent) {
      const updatedMemory = await addConversationTurn({ telegramId: ctx.from.id, userText: effectiveQuery, entities });
      const newFacts = (updatedMemory?.facts || []).filter((fact) =>
        fact.entity === entities.person || fact.entity === familyTarget.relation
      );
      return ctx.reply(formatMemorySaved({ member: familyTarget, facts: newFacts, query: effectiveQuery }), {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [{ text: "🔍 Search Medicine", callback_data: "prompt_search" }],
            [{ text: "👨‍👩‍👧 View Family", callback_data: "family:members" }],
          ],
        },
      });
    }

    if (intent.needsFollowUp) {
      await addConversationTurn({ telegramId: ctx.from.id, userText: effectiveQuery, entities });
      return ctx.reply(formatSearchFollowUp(effectiveQuery), {
        parse_mode: "HTML",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "Fever", callback_data: "search_intent:fever" },
              { text: "Cough", callback_data: "search_intent:cough" },
              { text: "Acidity", callback_data: "search_intent:acidity" },
            ],
          ],
        },
      });
    }

    const normalizedIntentQuery = aliasExpansion.alias
      ? aliasExpansion.normalizedQuery
      : entities.medicine || intent.normalizedQuery;

    if (entities.nearbyIntent) {
      await addConversationTurn({ telegramId: ctx.from.id, userText: effectiveQuery, entities });
      if (!userLocation) {
        return ctx.reply(
          "📍 <b>Share your location to find nearby pharmacies</b>\n\nI can search within 5 km and expand to 10 km if needed.",
          {
            parse_mode: "HTML",
            reply_markup: shareLocationKeyboard(),
          }
        );
      }
      return handleNearbyMedicineSearch(ctx, {
        latitude: userLocation.latitude,
        longitude: userLocation.longitude,
        medicineQuery: normalizedIntentQuery,
      });
    }

    const searchOptions = {
      ...intent,
      searchTerms: [...(intent.searchTerms || []), ...(aliasExpansion.searchTerms || [])],
      categories: [...new Set([...(intent.categories || []), ...(aliasExpansion.categories || [])])],
      alias: aliasExpansion.alias,
    };
    const repeatSearch = await getRecentRepeat(ctx.from.id, normalizedIntentQuery);
    const { results, sos, query: normalizedQuery, suggestions = [] } = await searchMedicine(normalizedIntentQuery, searchOptions);
    const memory = await addConversationTurn({ telegramId: ctx.from.id, userText: effectiveQuery, entities });

    if (results.length === 0) {
      // CareOps: create the shortage operation INLINE (awaited) so we can show
      // the user the REAL ServiceNow incident number in chat — the live-instance
      // wow moment. The listener is told `handledInline` so it does not also
      // create a duplicate operation for this same event.
      const familyName = mentionedMember?.name || familyTarget?.name || null;
      const familyRelation = mentionedMember?.relation || familyTarget?.relation || entities.person || null;
      const altNames = (suggestions || [])
        .map((s) => s.medicineName || s.genericName || s)
        .filter(Boolean);

      let shortageOp = null;
      try {
        const careEngine = require("../../careops/workflowEngine");
        if (familyName || (familyRelation && familyRelation !== "self")) {
          shortageOp = await careEngine.runFamilyMedicationShortage({
            telegramId: ctx.from.id,
            member: { name: familyName || familyRelation, relation: familyRelation || "family" },
            medicine: { medicineName: normalizedQuery || effectiveQuery },
            query: normalizedQuery || effectiveQuery,
            alternatives: altNames,
          });
        } else {
          shortageOp = await careEngine.runMedicineShortage({
            telegramId: ctx.from.id,
            medicine: { medicineName: normalizedQuery || effectiveQuery },
            query: normalizedQuery || effectiveQuery,
            reason: "medicine_not_found",
            alternatives: altNames,
          });
        }
      } catch (opErr) {
        logger.warn(`Inline shortage op failed: ${opErr.message}`);
      }

      eventBus.emitSafe("medicine.lookup.failed", {
        telegramId: ctx.from.id,
        query: effectiveQuery,
        normalizedQuery,
        intentKey: intent.key,
        // CareOps: carry family context so an unavailable family-member medicine
        // drives the combined Family Medication Shortage journey.
        familyMemberName: familyName,
        relation: familyRelation,
        suggestions,
        // We already created the operation inline above — listener must skip.
        handledInline: true,
      });

      // Surface the live ServiceNow incident number so the judge can match it
      // against the real instance. `externalRef.number` is the ServiceNow
      // INC… in live mode, or a realistic mock number otherwise.
      const incidentNumber = shortageOp?.incident?.externalRef?.number || null;
      const localIncidentNumber = shortageOp?.incident?.incidentNumber || null;
      const escalated = shortageOp?.incident?.status === "escalated";
      let incidentShown = false;
      if (incidentNumber || localIncidentNumber) {
        const who = familyName ? ` for ${escapeHtml(familyName)}` : "";
        const ref = incidentNumber || localIncidentNumber;
        const opLines = [
          `⚠️ <b>${escapeHtml(normalizedQuery || effectiveQuery)}</b> isn't available right now${who}.`,
          "",
          `🩺 I've raised a ServiceNow incident <b>${escapeHtml(ref)}</b> and started tracking it.`,
        ];
        if (altNames.length) {
          opLines.push(`🔁 Checking alternatives: ${altNames.slice(0, 3).map((n) => escapeHtml(n)).join(", ")}.`);
        }
        if (escalated) {
          opLines.push("⏫ Escalated to our SOS pharmacy network to source it.");
        }
        await ctx.reply(opLines.join("\n"), {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [{ text: "📍 Nearby Pharmacy", callback_data: "nearby:open" }],
              [{ text: "🩺 CareOps Status", callback_data: "careops:status" }],
            ],
          },
        });
        // Still try the Apollo/need-suggestion enrichment below so the user
        // also gets real options, but the operational moment is now visible.
        incidentShown = true;
      }

      // ---- LLM augment fallback for unknown medicines -----------------------
      // If the user's query looks like a medicine name and our DB doesn't
      // recognize it, ask Groq for a brief, sanitized general-knowledge
      // summary. The answer is post-sanitized to strip dosage / stock /
      // prescription claims, carries a soft "compiled from general knowledge"
      // footnote, and is logged to UnmatchedMedicineEnrichment so the catalog
      // can be promoted by an admin later (continuous-improvement loop).
      const augmentTarget = entities.medicine || normalizedIntentQuery || normalizedQuery || effectiveQuery;
      if (looksLikeMedicineQuery(augmentTarget) && !looksLikeMedicineNeed(effectiveQuery)) {
        // ---- Apollo Pharmacy live enrichment (real India catalog) ----------
        // When enabled, try the real Apollo brand/price/stock data first. This
        // is the "feels like it knows every medicine" moment. Best-effort:
        // any failure falls through to the Groq general-knowledge augment.
        if (apolloMedicineClient.isEnabled()) {
          try {
            const apollo = await apolloMedicineClient.search(augmentTarget);
            if (apollo.ok && apollo.results.length) {
              const apolloText = formatApolloResults(augmentTarget, apollo.results);
              const apolloMarkup = {
                inline_keyboard: [
                  [
                    { text: "📍 Nearby Pharmacy", callback_data: "nearby:open" },
                    { text: "⚠️ Side Effects", callback_data: `details:side:${augmentTarget.substring(0, 45)}` },
                  ],
                  [{ text: "🔄 Search Again", callback_data: "prompt_search" }],
                ],
              };
              await ctx.reply(apolloText, { parse_mode: "HTML", reply_markup: apolloMarkup });
              // Real-brand match → set active context so follow-ups work, and
              // emit search.completed so CareOps opens a continuity workflow.
              const top = apollo.results[0];
              setActiveMedicineContext(ctx.from.id, {
                medicineName: top.medicineName,
                genericName: top.tags?.[0] || top.medicineName,
                query: augmentTarget,
                confidence: 0.8,
              });
              eventBus.emitSafe("search.completed", {
                telegramId: ctx.from.id,
                normalizedQuery: augmentTarget,
                intentKey: intent.key,
                topMedicineName: top.medicineName,
              });
              return;
            }
          } catch (err) {
            logger.warn(`Apollo enrichment skipped: ${err.message}`);
          }
        }

        let augmentPlaceholder = null;
        if (TWO_STAGE_SEND_ENABLED()) {
          try {
            augmentPlaceholder = await ctx.reply(
              `🤔 Checking <b>${escapeHtml(augmentTarget)}</b>…`,
              { parse_mode: "HTML" }
            );
          } catch {
            augmentPlaceholder = null;
          }
        }
        const augment = await augmentUnknownMedicine({
          telegramId: ctx.from.id,
          query: augmentTarget,
          normalizedQuery,
        });
        if (augment.ok && augment.text) {
          const lines = [];
          lines.push(`💊 <b>${escapeHtml(augmentTarget)}</b>`);
          lines.push("");
          lines.push(escapeHtml(augment.text));
          lines.push("");
          lines.push("<i>Compiled from general medical knowledge — not yet in our verified catalog. Please confirm with a pharmacist before use.</i>");
          const replyText = lines.join("\n");
          const replyMarkup = {
            inline_keyboard: [
              [
                { text: "📍 Nearby Pharmacy", callback_data: "nearby:open" },
                { text: "🆘 Raise SOS", callback_data: `sos:${augmentTarget.substring(0, 50)}` },
              ],
              [{ text: "🔄 Search Again", callback_data: "prompt_search" }],
            ],
          };
          if (augmentPlaceholder) {
            try {
              await ctx.api.editMessageText(
                ctx.chat.id,
                augmentPlaceholder.message_id,
                replyText,
                { parse_mode: "HTML", reply_markup: replyMarkup }
              );
            } catch (err) {
              logger.warn(`Augment edit fallback to fresh send: ${err.message}`);
              await ctx.reply(replyText, { parse_mode: "HTML", reply_markup: replyMarkup });
            }
          } else {
            await ctx.reply(replyText, { parse_mode: "HTML", reply_markup: replyMarkup });
          }
          // Set the augmented medicine as the active context so follow-ups
          // (side effects / what does it do / can my father take it) keep
          // working with the same name. Confidence is intentionally below
          // the verified threshold so the bot still treats it as soft data.
          setActiveMedicineContext(ctx.from.id, {
            medicineName: augmentTarget,
            genericName: augmentTarget,
            query: augmentTarget,
            confidence: 0.5,
          });
          return;
        }
        // Augment failed — clean up the placeholder if it exists.
        if (augmentPlaceholder) {
          try {
            await ctx.api.deleteMessage(ctx.chat.id, augmentPlaceholder.message_id);
          } catch {
            /* ignore */
          }
        }
      }

      // ---- Need-based suggestion fallback --------------------------------
      // The query was not a known medicine and not a medicine-like name (e.g.
      // "sex medicine", "medicine for acidity", "nind ki dawa"). Ask Groq for
      // REAL medicine names for that need so the user is never stuck. Each
      // suggestion is a tap-to-search button; we also try to enrich the top
      // one with live Apollo data inline.
      const needSuggest = await suggestMedicinesForNeed({
        telegramId: ctx.from.id,
        query: effectiveQuery,
      });
      if (needSuggest.ok && needSuggest.suggestions.length) {
        const names = needSuggest.suggestions;
        const lines = [];
        lines.push(`💡 <b>For "${escapeHtml(effectiveQuery)}", these are commonly used:</b>`);
        lines.push("");
        names.forEach((n) => lines.push(`• <b>${escapeHtml(n)}</b>`));
        lines.push("");
        lines.push("<i>Compiled from general medical knowledge — tap one to see details and nearby availability. Confirm with a pharmacist before use.</i>");

        // Tap-to-search buttons (use the first word so the resolver gets a
        // clean token, e.g. "Sildenafil (Viagra)" → "Sildenafil").
        const cleanFirst = (s) => s.replace(/\(.*?\)/g, "").trim().split(/\s+/)[0] || s;
        const rows = names.slice(0, 4).map((n) => [
          { text: `🔍 ${n.slice(0, 40)}`, callback_data: `search_intent:${cleanFirst(n).substring(0, 48)}` },
        ]);
        rows.push([{ text: "📍 Nearby Pharmacy", callback_data: "nearby:open" }]);

        await ctx.reply(lines.join("\n"), {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: rows },
        });
        return;
      }

      if (sos) {
        // Prompt user to use SOS
        if (incidentShown) return; // incident message already sent — don't contradict
        await ctx.reply(formatNotFound(normalizedQuery, suggestions), {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🆘 Raise SOS Alert",
                  callback_data: `sos:${normalizedQuery.substring(0, 50)}`,
                },
              ],
              [{ text: "🔄 Search Again", callback_data: "prompt_search" }],
              [{ text: "📍 Nearby Pharmacy", callback_data: "nearby:open" }],
            ],
          },
        });
      } else {
        if (incidentShown) return; // incident message already sent
        await ctx.reply(formatNotFound(normalizedQuery, suggestions), { parse_mode: "HTML" });
      }
      return;
    }

    const historyPayload = {
      telegramId: ctx.from.id,
      originalQuery: contextual.originalQuery || query,
      normalizedQuery,
      intentKey: intent.key,
      topMedicineName: results[0]?.medicineName,
      familyMemberName: mentionedMember?.name,
    };
    emitSearchCompleted(historyPayload);

    if (mentionedMember?.notifyGuardian && mentionedMember.guardianTelegramId) {
      eventBus.emitSafe("guardian.alert.requested", {
        guardianTelegramId: mentionedMember.guardianTelegramId,
        message:
          `👨‍👩‍👧 <b>MediFast Family Alert</b>\n\n` +
          `${mentionedMember.name} searched for <b>${normalizedQuery}</b>.\n` +
          `This is only an informational alert, not a medical recommendation.`,
      });
    }

    // ----- Two-stage send: send an instant placeholder NOW, then edit it
    // ----- with the full card once the orchestrator/Groq finishes. This is
    // ----- what gives the bot a ChatGPT-like "I am thinking..." feel and
    // ----- hides the 1-3s tool/LLM latency from the user.
    // ----- Two-stage send: send an INSTANT useful first line NOW (medicine
    // ----- name + one-line use, built deterministically from the catalog hit
    // ----- we already have), then edit it with the richer AI narrative once
    // ----- the orchestrator/Groq finishes. The user sees something useful in
    // ----- ~200ms instead of a "Looking up…" spinner — the perceived-speed win.
    const topMedicineName =
      results[0]?.medicineName || normalizedQuery || "your medicine";
    let placeholderMessage = null;
    if (TWO_STAGE_SEND_ENABLED()) {
      try {
        const instantText = formatConversationalMedicine(topMedicineName, {
          evMed: results[0] || {},
          aiAnswer: "",
        });
        placeholderMessage = await ctx.reply(instantText, {
          parse_mode: "HTML",
          reply_markup: buildQuickActionKeyboard(normalizedQuery),
        });
      } catch (err) {
        // Telegram send is best-effort here — never block the real reply.
        logger.warn(`Two-stage placeholder send failed: ${err.message}`);
      }
    }

    const needsContext =
      routes.some((route) => route.tool === "rag" || route.tool === "memory") ||
      Boolean(entities.medicine || entities.normalizedMedicineQuery) ||
      Boolean(activeCtxFromContextual);
    const workflow = needsContext
      ? await runMediFastWorkflow({
          query: effectiveQuery,
          profile,
          telegramId: ctx.from.id,
          location: userLocation,
          intent,
          mentionedMember,
        })
      : null;
    const aiContext = needsContext
      ? {
          answer: workflow?.generated?.text || "",
          sources: workflow.knowledge?.sources || [],
          memory: workflow.memory || [],
          context: workflow.knowledge?.context || [],
          confidence: workflow.knowledge?.confidence || 0,
          lowConfidence: workflow.knowledge?.confidence ? workflow.knowledge.confidence < Number(process.env.RETRIEVAL_CONFIDENCE_THRESHOLD || 0.45) : false,
          evidence: workflow.evidence,
          toolSequence: workflow.debug?.toolSequence || [],
          providerLatencyMs: workflow.debug?.providerLatencyMs || 0,
          status: "orchestrated",
        }
      : null;

    const top = results[0] || {};
    const resolution = {
      medicine: {
        _id: top._id || null,
        medicineName: top.medicineName || normalizedQuery,
        genericName: top.genericName || top.medicineName || normalizedQuery,
        aliases: Array.isArray(top.aliases) ? top.aliases : [],
        salts: Array.isArray(top.salts)
          ? top.salts
          : (top.genericName ? [top.genericName] : []),
        brands: Array.isArray(top.brands) ? top.brands : [],
        category: top.category || null,
      },
      type: "medicine",
      normalizedQuery,
      confidence:
        typeof top.medicineConfidence === "number"
          ? top.medicineConfidence
          : (typeof top.confidence === "number" ? top.confidence : 0.95),
      method: top.matchMethod || "search:topResult",
      reason: "search results topResult",
      relationships: Array.isArray(top.relationships) ? top.relationships : [],
    };
    setActiveMedicineContext(ctx.from.id, { resolution });

    // Phase 6 / Task 8.3 — show a typing indicator on slow Groq paths so
    // perceived latency stays acceptable. We prefer an explicit, observable
    // signal here rather than threading a separate sender object — every
    // other replied flow above is unchanged. Two-stage scaffold note: today
    // `runMediFastWorkflow` resolves before we send, so a literal
    // "instant ack + editMessageText" pipeline is a no-op (the LLM result
    // is already in `aiContext.answer`). When we move the LLM call to be
    // issued in parallel with search in a future phase, this is the seam
    // where the deterministic card would land first.
    const usedLLM = Boolean(workflow && !workflow?.generated?.skipped && !workflow?.generated?.fallbackUsed);
    const handlerElapsedMs = Date.now() - handlerStartedAt;
    if (
      TWO_STAGE_SEND_ENABLED() &&
      usedLLM &&
      handlerElapsedMs > TYPING_THRESHOLD_MS()
    ) {
      try {
        await ctx.replyWithChatAction("typing");
      } catch (err) {
        // Telegram chat-action is best-effort; never block the final reply.
        logger.warn(`two-stage typing indicator failed: ${err.message}`);
      }
    }

    // Phase 9 / Task 11.2 — when an active MedicineContext is present and
    // confidence is at/above threshold, render the new SOLID medicine card via
    // `formatMedicineCard`. Non-medicine flows (no active ctx / low confidence)
    // continue to use `formatSearchResults` exactly as today (preservation).
    //
    // We re-read the active context here because `setActiveMedicineContext`
    // above may have just landed the FIRST-turn context (the contextual.context
    // captured earlier was null for a fresh medicine name).
    // Phase 9 / Task 11.2 — when an active MedicineContext is present and
    // confidence is at/above threshold, render the new SOLID medicine card via
    // `formatMedicineCard`. Non-medicine flows (no active ctx / low confidence)
    // continue to use `formatSearchResults` exactly as today (preservation).
    //
    // We re-read the active context here because `setActiveMedicineContext`
    // above may have just landed the FIRST-turn context (the contextual.context
    // captured earlier was null for a fresh medicine name).
    const activeCtx = getActiveContext(ctx.from.id) || activeCtxFromContextual;
    const cardThreshold = Number(
      process.env.MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD || 0.6
    );
    const shouldUseMedicineCard =
      activeCtx &&
      typeof activeCtx === "object" &&
      activeCtx.activeStatus === "active" &&
      typeof activeCtx.confidence === "number" &&
      activeCtx.confidence >= cardThreshold;

    // ---- Conversational mode (UX redesign) --------------------------------
    // Short, WhatsApp-like reply + quick-action buttons. Replaces the verbose
    // card on the default medicine path. Technical detail only surfaces when
    // the user taps Side effects / Alternatives. Safety preserved: the AI
    // sentence is already sanitized; no dosage/stock is shown.
    if (CONVERSATIONAL_MODE() && shouldUseMedicineCard) {
      const convoName = activeCtx.medicineName || normalizedQuery || topMedicineName;
      const convoText = formatConversationalMedicine(convoName, {
        evMed: aiContext?.evidence?.medicineContext?.medicine || top || {},
        aiAnswer: aiContext?.answer || "",
      });
      const convoMarkup = buildQuickActionKeyboard(normalizedQuery);
      if (placeholderMessage) {
        try {
          await ctx.api.editMessageText(
            ctx.chat.id,
            placeholderMessage.message_id,
            convoText,
            { parse_mode: "HTML", reply_markup: convoMarkup }
          );
        } catch (err) {
          logger.warn(`Conversational edit failed, sending fresh: ${err.message}`);
          await ctx.reply(convoText, { parse_mode: "HTML", reply_markup: convoMarkup });
        }
      } else {
        await ctx.reply(convoText, { parse_mode: "HTML", reply_markup: convoMarkup });
      }
      logger.info(`Search (conversational): "${normalizedQuery}" for user ${ctx.from.id}`);
      return;
    }

    const replyText = shouldUseMedicineCard
      ? formatMedicineCard(activeCtx, {
          evidence: aiContext?.evidence,
          safety,
          enrichment: activeCtx.enrichment,
          aiAnswer: aiContext?.answer || "",
          latency: aiContext
            ? { endToEnd: aiContext.providerLatencyMs || 0 }
            : null,
        })
      : formatSearchResults(results, normalizedQuery, {
          intent,
          mentionedMember,
          repeatSearch,
          routes,
          safety,
          alias: aliasExpansion.alias,
          aiContext,
          entities,
          contextual,
        });

    // Defensive: if the medicine card came out empty (e.g. context lacked
    // medicineName / genericName), fall back to the legacy result list so the
    // user is never sent an empty message.
    const finalText =
      shouldUseMedicineCard && !replyText
        ? formatSearchResults(results, normalizedQuery, {
            intent,
            mentionedMember,
            repeatSearch,
            routes,
            safety,
            alias: aliasExpansion.alias,
            aiContext,
            entities,
            contextual,
          })
        : replyText;

    // Send (or edit the placeholder with) the final card. Editing avoids the
    // user seeing two messages — the placeholder becomes the real reply.
    const replyMarkup = buildSearchActionKeyboard(normalizedQuery);
    if (placeholderMessage) {
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          placeholderMessage.message_id,
          finalText,
          { parse_mode: "HTML", reply_markup: replyMarkup }
        );
      } catch (err) {
        // If editing fails (rare; e.g. message-not-modified), fall back to a
        // fresh send so the user always gets the answer.
        logger.warn(`Two-stage edit failed, sending fresh: ${err.message}`);
        await ctx.reply(finalText, { parse_mode: "HTML", reply_markup: replyMarkup });
      }
    } else {
      await ctx.reply(finalText, { parse_mode: "HTML", reply_markup: replyMarkup });
    }

    logger.info(
      `Search: "${normalizedQuery}" → ${results.length} results for user ${ctx.from.id}`
    );
  } catch (error) {
    logger.error(`Search handler error: ${error.message}`);
    await ctx.reply(
      "⚠️ Something went wrong while searching. Please try again in a moment."
    );
  }
};

module.exports = {
  handleSearch,
  // Phase 6 / Task 8.3 — exposed for tests in `tests/unit/cache/responseCache.test.js`
  // and `tests/integration/orchestrator/latency.test.js`. Not part of the
  // production API surface; do not consume from other modules.
  __internals: {
    TWO_STAGE_SEND_ENABLED,
    LLM_EDIT_BUDGET_MS,
    TYPING_THRESHOLD_MS,
  },
};
