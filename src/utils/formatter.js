/**
 * Formats search results into a readable Telegram message (HTML parse mode).
 */

const MAX_RESULTS_PER_MESSAGE = 5;

const escapeHtml = (text) => {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
};

const formatPrice = (price, unit) => {
  if (!price) return "Price N/A";
  return `₹${price}/${unit || "strip"}`;
};

const formatVerifiedTime = (date) => {
  if (!date) return "Unknown";
  const diff = Date.now() - new Date(date).getTime();
  const hours = Math.floor(diff / (1000 * 60 * 60));
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

const MEDICAL_DISCLAIMER =
  "This bot helps discover medicines and is not a replacement for a doctor.";
const AI_DEBUG = (context = {}) => context.debug === true;

const formatAvailabilityConfidence = (score) => {
  if (score <= 0.18) return "High";
  if (score <= 0.38) return "Good";
  return "Discovery";
};

const formatConfidencePercent = (value, fallback = 0.72) => {
  const score = Number.isFinite(Number(value)) ? Number(value) : fallback;
  return `${Math.round(Math.max(0, Math.min(1, score)) * 100)}%`;
};

const formatUseCase = (item, intent) => {
  if (intent?.label) return intent.label;
  const categoryMap = {
    painkiller: "pain relief / fever support",
    gastro: "stomach / acidity support",
    respiratory: "cold / cough / allergy support",
    vitamins: "vitamin support",
    antidiabetic: "diabetes care",
    cardiac: "heart health",
    dermatology: "skin care",
    neurological: "neurology",
    antibiotic: "infection care",
  };
  return categoryMap[item.category] || "medicine availability";
};

const uniqueList = (items = []) => [...new Set(items.filter(Boolean).map((item) => String(item).trim()).filter(Boolean))];

const getUseBullets = (item, intent) => {
  const direct = uniqueList([...(item.symptoms || []), ...(item.diseases || [])]).slice(0, 3);
  if (direct.length) return direct;
  return [formatUseCase(item, intent)];
};

const getBrandText = (item) => {
  const brands = uniqueList([...(item.brands || []), item.brand, ...(item.aliases || [])])
    .filter((name) => normalizeDisplay(name) !== normalizeDisplay(item.medicineName))
    .slice(0, 4);
  return brands.length ? brands.join(", ") : "No brand alternatives listed yet";
};

const normalizeDisplay = (value = "") => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Format a list of inventory search results into a Telegram HTML message.
 */
const formatSearchResults = (results, query, context = {}) => {
  const displayed = results.slice(0, MAX_RESULTS_PER_MESSAGE);
  const hasMore = results.length > MAX_RESULTS_PER_MESSAGE;
  const { intent, mentionedMember, repeatSearch } = context;
  const routes = context.routes || [];

  let message = context.contextual?.usedContext
    ? `💬 <i>Continuing from ${escapeHtml(context.contextual.context?.medicineName || query)}</i>\n\n`
    : "";
  if (context.alias) {
    const brands = context.alias.brands?.slice(0, 3).join(", ");
    message += `Matched: <i>${escapeHtml(context.alias.salt)}${brands ? ` (${brands})` : ""}</i>\n`;
  }
  if (mentionedMember) {
    message += `For: <b>${escapeHtml(mentionedMember.name)}</b> (${escapeHtml(mentionedMember.ageGroup)})\n`;
  }
  if (repeatSearch?.topMedicineName) {
    message += `\n🔁 Need to reorder previous medicine: <b>${escapeHtml(repeatSearch.topMedicineName)}</b>?\n`;
  }
  if (context.aiContext?.answer) {
    message += `<i>${escapeHtml(context.aiContext.answer).slice(0, 350)}</i>\n`;
  }
  if (context.aiContext?.lowConfidence) {
    message += `I may need one more detail to answer this confidently.\n`;
  }
  message += `\n`;

  displayed.forEach((item, index) => {
    const rareTag = item.isRare ? " 🔴 <b>[RARE]</b>" : "";
    const rxTag = item.requiresPrescription ? " 📋 <i>Rx required</i>" : "";
    const useBullets = getUseBullets(item, intent);
    message += `${index > 0 ? "\n" : ""}💊 <b>${escapeHtml(item.medicineName)}</b>${rareTag}${rxTag}\n\n`;
    message += `<b>Used for:</b>\n`;
    useBullets.forEach((use) => {
      message += `• ${escapeHtml(use)}\n`;
    });

    if (item.genericName) {
      message += `\n<b>Salt:</b>\n${escapeHtml(item.genericName)}\n`;
    }

    message += `\n<b>Brands:</b>\n${escapeHtml(getBrandText(item))}\n`;

    if (item.knowledgeOnly) {
      message += `\n<b>Availability:</b>\nKnown medicine. Live stock is not confirmed yet.\n`;
    } else {
      message += `\n<b>Availability:</b>\n${item.inStock ? "Available in listed inventory" : "Listed, stock may be unavailable"} · ${formatPrice(item.price, item.unit)}\n`;
    }

    const details = [];
    if (item.alternatives?.length) {
      details.push(`Alternatives: ${item.alternatives.slice(0, 4).map((alt) => alt.medicineName || alt.genericName || alt).filter(Boolean).join(", ")}`);
    }
    if (item.sideEffects?.length) {
      details.push(`Side effects noted: ${item.sideEffects.slice(0, 3).map((side) => side.effect || side).join("; ")}`);
    }
    if (item.precautions?.length) {
      details.push(`Precautions: ${item.precautions.slice(0, 3).join("; ")}`);
    }
    message += `<blockquote expandable>`;
    if (details.length) {
      message += `${escapeHtml(details.join("\n"))}\n\n`;
    }
    message += `🏪 <b>${escapeHtml(item.pharmacy.name)}</b> — ${escapeHtml(item.pharmacy.area)}\n`;
    message += `📍 ${escapeHtml(item.pharmacy.address)}\n`;

    if (item.pharmacy.phone) {
      message += `📞 ${escapeHtml(item.pharmacy.phone)}\n`;
    }
    if (item.pharmacy.whatsapp) {
      message += `💬 WhatsApp: ${escapeHtml(item.pharmacy.whatsapp)}\n`;
    }

    if (!item.knowledgeOnly) {
      message += `🕐 ${escapeHtml(item.pharmacy.hours)}\n`;
      message += `🔄 Verified: ${formatVerifiedTime(item.lastVerified)}\n`;
    }
    message += `</blockquote>\n`;
  });

  if (hasMore) {
    message += `<i>... and ${results.length - MAX_RESULTS_PER_MESSAGE} more result(s). Refine your search for better results.</i>\n`;
  }

  if (intent?.safetyNote) {
    message += `\n⚕️ <i>${escapeHtml(intent.safetyNote)}</i>\n`;
  }
  if (context.safety?.notes?.length) {
    const uniqueSafetyNotes = context.safety.notes.filter((note) => note !== MEDICAL_DISCLAIMER);
    if (uniqueSafetyNotes.length) {
      message += uniqueSafetyNotes.map((note) => `⚠️ <i>${escapeHtml(note)}</i>`).join("\n");
      message += `\n`;
    }
  }

  if (AI_DEBUG(context)) {
    const entities = context.entities || {};
    const docs = context.aiContext?.context || [];
    const memory = context.aiContext?.memory || [];
    const evidence = context.aiContext?.evidence || {};
    const pharmacies = evidence.pharmacyContext?.pharmacies || [];
    const toolSequence = context.aiContext?.toolSequence || [];
    message += `\n<pre>AI DEBUG\n`;
    message += `Entities: ${escapeHtml(JSON.stringify({
      person: entities.person,
      symptom: entities.symptom,
      medicine: entities.medicine,
      duration: entities.duration,
      reorderIntent: entities.reorderIntent,
    }))}\n`;
    message += `Router: ${escapeHtml((routes || []).map((route) => `${route.tool}:${route.confidence}`).join(", "))}\n`;
    message += `Medicine: ${escapeHtml(JSON.stringify({
      name: evidence.medicineContext?.medicine?.genericName || evidence.medicineContext?.medicine?.medicineName,
      confidence: evidence.confidenceScores?.medicine,
    }))}\n`;
    message += `Retrieved docs: ${escapeHtml(docs.map((doc) => doc.metadata?.source || doc.metadata?.category || "unknown").join(", ") || "none")}\n`;
    message += `Memory: ${escapeHtml(memory.map((fact) => `${fact.entity}:${fact.value}`).join(", ") || "none")}\n`;
    message += `Pharmacies: ${escapeHtml(pharmacies.map((item) => item.name).join(", ") || "none")}\n`;
    message += `Confidence: ${escapeHtml(JSON.stringify(evidence.confidenceScores || {}))}\n`;
    message += `Tool sequence: ${escapeHtml(toolSequence.join(" -> ") || "none")}\n`;
    message += `Provider latency: ${escapeHtml(String(context.aiContext?.providerLatencyMs || 0))}ms\n`;
    message += `</pre>\n`;
  }

  message += `\n💡 <i>Stock info may change. Call ahead to confirm.</i>\n`;
  message += `⚠️ <i>${MEDICAL_DISCLAIMER}</i>`;

  return message;
};

// ---------------------------------------------------------------------------
// Phase 9 / Task 11.1 — formatMedicineCard
//
// SOLID-reply Telegram card. Sections render only when their data is present
// (Medicine, Generic, Primary Use, Common Side Effects, Key Safety Notes,
// Alternatives, Nearby Availability, Forecast, Confidence). The card
// explicitly consumes `medicineContext + evidence + enrichment + nearby` so
// every wired layer (context, evidence, enrichment, safety) reaches the user.
//
// Design contract:
//   - HTML parse mode (Telegram).
//   - Existing helpers reused: escapeHtml, formatConfidencePercent,
//     MEDICAL_DISCLAIMER. No new dependencies.
//   - Detail (aliases / salts / category / latency) is folded into a
//     <blockquote expandable> so the card stays mobile-first.
//   - Empty / null `medicineContext` returns an empty string. Caller
//     (search.js) decides between this card and `formatSearchResults`.
// ---------------------------------------------------------------------------
const pickName = (item) => {
  if (!item) return null;
  if (typeof item === "string") return item;
  if (typeof item !== "object") return null;
  return (
    item.name ||
    item.medicineName ||
    item.genericName ||
    item.pharmacyName ||
    null
  );
};

const formatDistanceKm = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return `${value.toFixed(1)}km`;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
};

const formatMedicineCard = (medicineContext, opts = {}) => {
  if (!medicineContext || typeof medicineContext !== "object") return "";

  const ctx = medicineContext;
  const { evidence = null, safety = null, enrichment = null, latency = null, aiAnswer = null } = opts;

  // Resolve enrichment from either the explicit option or from the context's
  // reserved slot (whichever is non-null) — Task 9.4 stamps both the
  // evidence.enrichment and MedicineContext.enrichment via withEnrichment.
  const enr =
    (enrichment && typeof enrichment === "object" && enrichment) ||
    (ctx.enrichment && typeof ctx.enrichment === "object" && ctx.enrichment) ||
    {};

  const evMed =
    (evidence &&
      evidence.medicineContext &&
      evidence.medicineContext.medicine) ||
    {};

  const lines = [];

  // ---- Header: Medicine Name (Generic Name) ---------------------------------
  if (ctx.medicineName) {
    const showGeneric = ctx.genericName && ctx.genericName !== ctx.medicineName;
    lines.push(
      showGeneric
        ? `💊 <b>${escapeHtml(ctx.medicineName)}</b> <i>(${escapeHtml(ctx.genericName)})</i>`
        : `💊 <b>${escapeHtml(ctx.medicineName)}</b>`
    );
  }

  // Confidence pill is intentionally omitted from the user-facing card — it is
  // useful for debugging but reads as noise on Telegram. It still flows
  // through evidence / analytics for observability.

  // ---- LLM narrative (Groq synthesis) — surface BEFORE templated bullets so
  //      the card feels conversational, not robotic. The narrative is already
  //      grounded (Phase 5) and sanitized (groqProvider.sanitizeGeneratedText),
  //      so we trim, escape, and clip to a sensible mobile-card length.
  const trimmedAnswer =
    typeof aiAnswer === "string" ? aiAnswer.trim() : "";
  if (trimmedAnswer) {
    lines.push("");
    lines.push(escapeHtml(trimmedAnswer.slice(0, 700)));
  }

  // ---- Primary Use (symptoms) ----------------------------------------------
  const symptomNames = (Array.isArray(evMed.symptoms) ? evMed.symptoms : [])
    .slice(0, 3)
    .map((s) => (s && typeof s === "object" ? s.name || s.symptom : s))
    .filter(Boolean);
  if (symptomNames.length) {
    lines.push("");
    lines.push("<b>Used for:</b>");
    for (const s of symptomNames) lines.push(`• ${escapeHtml(String(s))}`);
  }

  // ---- Common Side Effects --------------------------------------------------
  const sideEffectNames = (Array.isArray(evMed.sideEffects) ? evMed.sideEffects : [])
    .slice(0, 3)
    .map((s) => (s && typeof s === "object" ? s.effect || s.name : s))
    .filter(Boolean);
  if (sideEffectNames.length) {
    lines.push("");
    lines.push("<b>Common side effects:</b>");
    for (const s of sideEffectNames) lines.push(`• ${escapeHtml(String(s))}`);
  }

  // ---- Key Safety Notes (from safety guard; disclaimer goes in footer) ------
  const safetyNotes = (safety && Array.isArray(safety.notes) ? safety.notes : [])
    .filter((n) => n && n !== MEDICAL_DISCLAIMER)
    .slice(0, 3);
  if (safetyNotes.length) {
    lines.push("");
    lines.push("<b>Key safety notes:</b>");
    for (const note of safetyNotes) lines.push(`• ${escapeHtml(String(note))}`);
  }

  // ---- Alternatives ---------------------------------------------------------
  const alternativeArr =
    evidence && evidence.medicineContext && Array.isArray(evidence.medicineContext.alternatives)
      ? evidence.medicineContext.alternatives
      : [];
  const alternativeNames = alternativeArr
    .map((a) => (a && typeof a === "object" ? a.medicineName || a.genericName : a))
    .filter(Boolean)
    .slice(0, 4);
  if (alternativeNames.length) {
    lines.push("");
    lines.push(
      `<b>Alternatives:</b> ${alternativeNames.map((n) => escapeHtml(String(n))).join(", ")}`
    );
  }

  // ---- Nearby Availability --------------------------------------------------
  // Prefer MediAtlas enrichment when present (Task 9.4); fall back to OSM /
  // Mongo-geo evidence (`evidence.pharmacyContext.pharmacies`). Either path
  // surfaces the same card line so all wired layers reach the user.
  const enrichmentPharmacies =
    enr.pharmacies && Array.isArray(enr.pharmacies.items)
      ? enr.pharmacies.items
      : [];
  const enrichmentInventory =
    enr.inventory && Array.isArray(enr.inventory.items)
      ? enr.inventory.items
      : [];
  const evidencePharmacies =
    evidence && evidence.pharmacyContext && Array.isArray(evidence.pharmacyContext.pharmacies)
      ? evidence.pharmacyContext.pharmacies
      : [];
  const nearbySource = enrichmentPharmacies.length
    ? enrichmentPharmacies
    : enrichmentInventory.length
    ? enrichmentInventory
    : evidencePharmacies;
  const nearbyTop = nearbySource.slice(0, 3);
  if (nearbyTop.length) {
    lines.push("");
    lines.push("<b>Nearby availability:</b>");
    for (const p of nearbyTop) {
      const name = pickName(p) || "Pharmacy";
      const distStr = formatDistanceKm(p && p.distanceKm) || formatDistanceKm(p && p.distance);
      const distPart = distStr ? ` • ${escapeHtml(distStr)}` : "";
      const phonePart = p && p.phone ? ` • 📞 ${escapeHtml(String(p.phone))}` : "";
      let stockPart = "";
      if (p && p.inStock === true) stockPart = " • in stock";
      else if (p && p.inStock === false) stockPart = " • call to confirm";
      lines.push(`• ${escapeHtml(String(name))}${distPart}${phonePart}${stockPart}`);
    }
  }

  // ---- Forecast -------------------------------------------------------------
  if (enr.forecast && enr.forecast.demandLevel) {
    lines.push("");
    lines.push(
      `<b>Forecast:</b> ${escapeHtml(String(enr.forecast.demandLevel))} demand expected.`
    );
  }

  // ---- Expandable detail (aliases, salts, category, latency) — hidden from
  //      the main card to reduce visual noise. Detail is still available via
  //      the inline keyboard buttons (Side Effects / Alternatives / Save) and
  //      is preserved on the workflow's evidence object for analytics. The
  //      user-facing card stays focused on what matters: medicine + AI answer
  //      + nearby + safety.

  // ---- Footer: minimal safety reminder, no full disclaimer block ----------
  if (lines.length) {
    lines.push("");
    lines.push(`<i>Always confirm dosage with a pharmacist or doctor.</i>`);
  }

  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// CONVERSATIONAL MODE (UX redesign) — short, WhatsApp-like, action-oriented.
// One or two friendly lines + quick-action buttons. Technical detail (aliases,
// confidence, evidence) is intentionally omitted; it only appears when the user
// explicitly taps "Side effects" / "Alternatives". Safety floor preserved: the
// AI answer is already sanitized upstream (no dosage/stock invented).
// ---------------------------------------------------------------------------

// A concise primary-use sentence for a medicine. Prefers symptoms/uses; falls
// back to the category map. Never includes dosage.
const conversationalUseLine = (medicineName, evMed = {}, aiAnswer = "") => {
  const name = medicineName || "This medicine";
  // Prefer a short, already-sanitized AI sentence when available.
  const trimmed = String(aiAnswer || "").trim();
  if (trimmed) {
    const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0] || trimmed;
    return escapeHtml(firstSentence.slice(0, 200));
  }
  const uses = uniqueList([...(evMed.symptoms || []), ...(evMed.diseases || [])])
    .map((s) => (s && typeof s === "object" ? s.name || s.symptom : s))
    .filter(Boolean)
    .slice(0, 2);
  if (uses.length) {
    return `${escapeHtml(name)} is commonly used for ${escapeHtml(uses.join(" and "))}.`;
  }
  const cat = evMed.category ? formatUseCase(evMed) : null;
  return cat
    ? `${escapeHtml(name)} is used for ${escapeHtml(cat)}.`
    : `${escapeHtml(name)} — here's what I can help with.`;
};

// Short conversational medicine reply: 1 line + offer of next actions.
const formatConversationalMedicine = (medicineName, { evMed = {}, aiAnswer = "" } = {}) => {
  const lines = [];
  lines.push(`💊 <b>${escapeHtml(medicineName)}</b>`);
  lines.push("");
  lines.push(conversationalUseLine(medicineName, evMed, aiAnswer));
  lines.push("");
  lines.push("What would you like next?");
  return lines.join("\n");
};

// Quick-action keyboard for the conversational medicine reply.
const buildQuickActionKeyboard = (query) => {
  const q = String(query || "").substring(0, 44);
  return {
    inline_keyboard: [
      [{ text: "📍 Nearby pharmacies", callback_data: `nearby_medicine:${q}` }],
      [
        { text: "⚠️ Side effects", callback_data: `details:side:${q}` },
        { text: "🔁 Alternatives", callback_data: `details:alt:${q}` },
      ],
    ],
  };
};

// Conversational nearby card: clean list + per-pharmacy actions are exposed via
// the keyboard. Chains are badged; open status uses traffic-light emojis.
const formatConversationalNearby = (recommendation, medicineQuery = "") => {
  const ranked = recommendation?.ranked || [];
  if (!ranked.length) {
    return `📍 I couldn't find pharmacies near you yet. Try sharing your location again or send your PIN code.`;
  }
  const med = medicineQuery
    ? escapeHtml(recommendation.medicine?.genericName || medicineQuery)
    : null;
  const lines = [];
  lines.push(med ? `📍 Pharmacies that may stock <b>${med}</b>:` : "📍 Pharmacies near you:");
  lines.push("");
  ranked.slice(0, 5).forEach((p) => {
    const badge = p.chainBadge ? `${escapeHtml(p.chainBadge)} ` : "";
    const dist = p.distance ? `📍 ${escapeHtml(p.distance)} away` : "";
    const open =
      p.isOpenNow || /open/i.test(p.openStatus || "")
        ? "🟢 Open now"
        : /clos/i.test(p.openStatus || "")
        ? "🟡 Closing soon"
        : "";
    lines.push(`${badge}<b>${escapeHtml(p.name)}</b>`);
    lines.push(`   ${[dist, open].filter(Boolean).join("  ")}`.trimEnd());
  });
  lines.push("");
  lines.push("Need help obtaining the medicine?");
  return lines.join("\n");
};

// Keyboard for the conversational nearby card: Call + Navigate on the top
// pharmacy, plus a Start Fulfillment CTA.
const buildNearbyConversationalKeyboard = (ranked = [], medicineQuery = "") => {
  const rows = [];
  const top = ranked?.[0];
  if (top) {
    const actionRow = [];
    if (top.phone) {
      actionRow.push({
        text: "📞 Call",
        callback_data: `pharmacy_call:${String(top.phone).replace(/\s+/g, "").substring(0, 42)}`,
      });
    }
    if (top.directionsUrl) {
      actionRow.push({ text: "🗺 Navigate", url: top.directionsUrl });
    }
    if (actionRow.length) rows.push(actionRow);
  }
  rows.push([
    {
      text: "🩺 Start Fulfillment",
      callback_data: `fulfill:${String(medicineQuery || top?.name || "").substring(0, 50)}`,
    },
  ]);
  return { inline_keyboard: rows };
};

// ---------------------------------------------------------------------------
// Apollo Pharmacy results card — real India-market brands/prices/availability
// from the Parse-built apollopharmacy.in API. Rendered when the local catalog
// has no match but Apollo returns live products. Prices/stock are clearly
// attributed to Apollo so the bot reads as a knowledgeable pharmacy assistant.
// ---------------------------------------------------------------------------
const formatApolloResults = (query, results = []) => {
  if (!results.length) return "";
  const lines = [];
  lines.push(`💊 <b>${escapeHtml(query)}</b> — live options at Apollo Pharmacy`);
  lines.push("");
  results.slice(0, 5).forEach((r) => {
    const price =
      r.price != null
        ? `₹${r.price}${r.mrp && r.mrp !== r.price ? ` <s>₹${r.mrp}</s>` : ""}${
            r.discountPercentage ? ` (${r.discountPercentage}% off)` : ""
          }`
        : "Price N/A";
    const stock = r.inStock === true ? "🟢 In stock" : r.inStock === false ? "🔴 Out of stock" : "";
    const rx = r.prescriptionRequired ? " · 📋 Rx" : "";
    lines.push(`• <b>${escapeHtml(r.medicineName)}</b>`);
    const meta = [price, r.packSize ? escapeHtml(String(r.packSize)) : null, stock]
      .filter(Boolean)
      .join(" · ");
    lines.push(`  ${meta}${rx}`);
    if (r.manufacturer) lines.push(`  <i>by ${escapeHtml(r.manufacturer)}</i>`);
  });
  lines.push("");
  lines.push("<i>Live data from Apollo Pharmacy. Confirm with a pharmacist before use.</i>");
  return lines.join("\n");
};

const buildSearchActionKeyboard = (query) => ({
  inline_keyboard: [
    [
      { text: "📍 Nearby", callback_data: `nearby_medicine:${String(query).substring(0, 48)}` },
      { text: "⚠️ Side Effects", callback_data: `details:side:${String(query).substring(0, 45)}` },
    ],
    [
      { text: "🔁 Alternatives", callback_data: `details:alt:${String(query).substring(0, 45)}` },
      { text: "💾 Save", callback_data: `save_search:${String(query).substring(0, 48)}` },
    ],
    [
      { text: "🔄 Search Again", callback_data: "prompt_search" },
      { text: "👨‍👩‍👧 Family", callback_data: "family:open" },
    ],
  ],
});

/**
 * Format a "not found" message with SOS prompt.
 */
const formatNotFound = (query, suggestions = []) => {
  const suggestionList = suggestions
    .slice(0, 3)
    .map((item) => item.medicineName || item.genericName || item.brands?.[0])
    .filter(Boolean);
  return (
    `😔 <b>No results for "${escapeHtml(query)}"</b>\n\n` +
    `This medicine wasn't found in our database.\n\n` +
    (suggestionList.length
      ? `Did you mean: ${suggestionList.map((name) => `<b>${escapeHtml(name)}</b>`).join(", ")}?\n\n`
      : "") +
    `You can:\n` +
    `• Try a different spelling or generic name\n` +
    `• Use /sos to raise an alert — our network will help locate it!\n` +
      `• Use /help to see all commands`
  );
};

const formatSearchFollowUp = (query) => {
  return (
    `🤔 <b>I need one more detail</b>\n\n` +
    `I could not confidently understand "${escapeHtml(query)}".\n` +
    `Try a medicine name like <code>Dolo 650</code>, or a symptom like <code>bukhar ki tablet</code>, <code>sar dard</code>, <code>gas acidity</code>.\n\n` +
    `<i>${MEDICAL_DISCLAIMER}</i>`
  );
};

/**
 * Format the SOS confirmation message.
 */
const formatSosConfirm = (medicineName) => {
  return (
    `🆘 <b>SOS Alert Raised!</b>\n\n` +
    `Medicine: <b>${escapeHtml(medicineName)}</b>\n\n` +
    `Your request has been broadcast to our pharmacy network in Jaipur.\n` +
    `You'll be notified if someone locates this medicine.\n\n` +
    `<i>This typically gets a response within 1–2 hours during business hours.</i>`
  );
};

/**
 * Format the /start welcome message.
 */
const formatWelcome = (firstName) => {
  return (
    `🏥 <b>MediFast AI</b>\n\n` +
    `Namaste ${escapeHtml(firstName || "there")}! 🙏\n\n` +
    `Fast medicine search, family memory, and nearby pharmacy discovery for India.\n\n` +
    `<b>Setup takes 20 seconds:</b>\n` +
    `1. Choose language\n` +
    `2. Share location for nearby pharmacies\n` +
    `3. Add family members if you want refill memory\n\n` +
    `<blockquote expandable><b>Try:</b>\n` +
    `• <code>Dolo 650 near me</code>\n` +
    `• <code>Papa has BP and needs fever medicine</code>\n` +
    `• <code>side effects of Pregabalin</code>\n` +
    `• <code>reorder papa medicine</code></blockquote>\n\n` +
    `<i>${MEDICAL_DISCLAIMER}</i>`
  );
};

/**
 * Format the /help message.
 */
const formatHelp = () => {
  return (
    `<b>📋 MediFast AI — Commands</b>\n\n` +
    `<b>🔍 Search</b>\n` +
    `/search &lt;name or symptom&gt; — Search medicines\n` +
    `<i>Or just type: bukhar ki tablet, sar dard, cough medicine</i>\n\n` +
    `<b>👨‍👩‍👧 Family</b>\n` +
    `/family — Family medicine dashboard\n` +
    `/addmember — Add a family member\n` +
    `/members — View saved members\n` +
    `/removeMember &lt;name&gt; — Remove a member\n\n` +
    `<b>🆘 SOS</b>\n` +
    `/sos &lt;name&gt; — Alert the network for a rare/unavailable medicine\n\n` +
    `<b>🩺 CareOps</b>\n` +
    `/careops — Live healthcare operations: cases, tasks, incidents, workflows\n\n` +
    `<b>📍 Browse</b>\n` +
    `/nearby — Find pharmacies by area\n` +
    `/areas — List all covered areas\n\n` +
    `<b>ℹ️ Info</b>\n` +
    `/about — About this bot\n` +
    `/feedback — Send feedback\n\n` +
    `💡 <i>Tip: Try “mom fever medicine” or “reorder papa medicine”.</i>\n\n` +
    `⚠️ <i>${MEDICAL_DISCLAIMER}</i>`
  );
};

const formatFamilyMenu = (profile) => {
  return (
    `👨‍👩‍👧 <b>Family Medicine Hub</b>\n\n` +
    `Saved members: <b>${profile.familyMembers.length}</b>\n\n` +
    `Search naturally: <code>mom fever medicine</code>, <code>papa BP tablet</code>, or <code>reorder papa medicine</code>.`
  );
};

const formatAddMemberPrompt = () => {
  return (
    `➕ <b>Add Family Member</b>\n\n` +
    `Send details in this format:\n` +
    `<code>Name|relation|age group|notes</code>\n\n` +
    `Age group can be <b>child</b>, <b>adult</b>, or <b>senior</b>.\n\n` +
    `Example:\n<code>Papa|papa|senior|diabetes and BP</code>`
  );
};

const formatMembers = (profile) => {
  if (!profile.familyMembers.length) {
    return "👨‍👩‍👧 <b>No family members yet.</b>\n\nUse /addmember to save one.";
  }

  let message = `👨‍👩‍👧 <b>Your Family Members</b>\n\n`;
  profile.familyMembers.forEach((member, index) => {
    message += `${index + 1}. <b>${escapeHtml(member.name)}</b> — ${escapeHtml(member.relation)}\n`;
    message += `   Age group: ${escapeHtml(member.ageGroup)}\n`;
    if (member.notes) message += `   Notes: ${escapeHtml(member.notes)}\n`;
    message += `\n`;
  });
  message += `<i>Try: reorder papa medicine, mom fever medicine.</i>`;
  return message;
};

const formatReorderPrompt = (member, recent) => {
  if (!recent) {
    return (
      `🔁 <b>Reorder</b>\n\n` +
      `I found ${member ? escapeHtml(member.name) : "that family member"}, but there is no recent medicine history yet.\n` +
      `Try searching first, for example: <code>${member ? escapeHtml(member.relation) : "papa"} fever medicine</code>.`
    );
  }

  return (
    `🔁 <b>Reorder previous medicine?</b>\n\n` +
    `For: <b>${escapeHtml(member.name)}</b>\n` +
    `Previous medicine: <b>${escapeHtml(recent.topMedicineName)}</b>\n` +
    `Last searched: ${new Date(recent.createdAt).toLocaleDateString("en-IN")}\n\n` +
    `Type <code>${escapeHtml(recent.topMedicineName)}</code> to check live availability again.`
  );
};

const formatMemorySaved = ({ member, facts = [], query = "" } = {}) => {
  const factText = facts
    .slice(0, 4)
    .map((fact) => `${fact.entity || "self"}: ${fact.value}`)
    .join("\n");
  return (
    `🧠 <b>Saved to family memory</b>\n\n` +
    (member ? `For: <b>${escapeHtml(member.name)}</b>\n` : "") +
    (factText ? `<blockquote expandable>${escapeHtml(factText)}</blockquote>\n` : "") +
    `Next time you can ask: <code>medicine for ${escapeHtml(member?.relation || "papa")}</code> or <code>reorder ${escapeHtml(member?.relation || "papa")} medicine</code>.\n\n` +
    `<i>${MEDICAL_DISCLAIMER}</i>`
  );
};

const formatProductionHealth = (report = {}) => {
  const status = report.status || {};
  const catalog = report.catalog || {};
  const memory = report.memory || {};
  const rag = report.rag || {};
  const llm = report.llm || {};
  const pharmacy = report.pharmacy || {};
  const deadCode = report.deadCode || {};
  return (
    `🩺 <b>MediFast Production Health</b>\n\n` +
    `Catalog: <b>${escapeHtml(status.catalog || "unknown")}</b> · ${catalog.coveragePercent || 0}% vector coverage\n` +
    `Vectors: <b>${escapeHtml(status.vectors || "unknown")}</b> · ${catalog.vectorizedChunks || rag.vectorCount || 0} chunks\n` +
    `Memory: <b>${escapeHtml(status.memory || "unknown")}</b> · ${memory.storedFacts || 0} facts\n` +
    `RAG: <b>${escapeHtml(status.rag || "unknown")}</b> · ${rag.retrievalHits || 0} sample hits\n` +
    `LLM: <b>${escapeHtml(status.llm || "unknown")}</b> · ${escapeHtml(llm.provider || "deterministic")}\n` +
    `Pharmacy: <b>${escapeHtml(status.pharmacy || "unknown")}</b> · ${pharmacy.pharmacyCount || 0} active\n\n` +
    `<blockquote expandable>Catalog completion: ${catalog.progressCompletionPercent || 0}%\n` +
    `Remaining records: ${catalog.remainingRecords || 0}\n` +
    `Geo-ready pharmacies: ${pharmacy.geoReadyCount || pharmacy.coordinatesCount || 0}\n` +
    `Real data active: ${pharmacy.realDataActive ? "yes" : "no"}\n` +
    `Dead-code candidates: ${deadCode.candidateCount || 0}</blockquote>`
  );
};

module.exports = {
  buildSearchActionKeyboard,
  formatSearchResults,
  formatMedicineCard,
  formatApolloResults,
  formatConversationalMedicine,
  formatConversationalNearby,
  buildQuickActionKeyboard,
  buildNearbyConversationalKeyboard,
  formatNotFound,
  formatSosConfirm,
  formatWelcome,
  formatHelp,
  formatSearchFollowUp,
  formatFamilyMenu,
  formatAddMemberPrompt,
  formatMembers,
  formatMemorySaved,
  formatProductionHealth,
  formatReorderPrompt,
  formatConfidencePercent,
  escapeHtml,
};
