const Pharmacy = require("../../models/Pharmacy");
const Inventory = require("../../models/Inventory");
const { getNearbyPharmacyReadiness } = require("../../services/nearbyPharmacyService");
const { recommendNearbyPharmacies } = require("../../pharmacy/pharmacyRecommendationService");
const { saveSessionLocation, shareLocationKeyboard } = require("../../pharmacy/pharmacyLocationService");
const eventBus = require("../../events/eventBus");
const { escapeHtml } = require("../../utils/formatter");
const logger = require("../../utils/logger");

const realPharmacyDataExists = async () =>
  Pharmacy.exists({ isActive: true, source: { $ne: "manual" }, "location.coordinates.0": { $exists: true } });

// Jaipur areas we cover
const JAIPUR_AREAS = [
  "Mansarovar",
  "Vaishali Nagar",
  "Malviya Nagar",
  "C-Scheme",
  "Tonk Road",
  "Ajmer Road",
  "Raja Park",
  "Sodala",
  "Pratap Nagar",
  "Jagatpura",
  "Sanganer",
  "Sitapura",
  "Jhotwara",
  "Shyam Nagar",
  "Nirman Nagar",
];

const buildNearbyActionKeyboard = (ranked = []) => {
  const top = ranked?.[0];
  const buttons = [[{ text: "🔄 Search Again", callback_data: "prompt_search" }]];
  if (!top) return { inline_keyboard: buttons };

  const actionRow = [];
  if (top.phone) {
    actionRow.push({ text: "📞 Call", callback_data: `pharmacy_call:${String(top.phone).replace(/\s+/g, "").substring(0, 42)}` });
  }
  if (top.directionsUrl) {
    actionRow.push({ text: "🧭 Directions", url: top.directionsUrl });
  }
  if (actionRow.length) buttons.unshift(actionRow);
  return { inline_keyboard: buttons };
};

/**
 * Show list of areas as inline keyboard.
 */
const handleNearby = async (ctx) => {
  const buttons = JAIPUR_AREAS.map((area) => [
    {
      text: `📍 ${area}`,
      callback_data: `area:${area}`,
    },
  ]);

  await ctx.reply(
    "📍 <b>Nearby Pharmacies</b>\n\nShare location for live nearby matching, or browse by Jaipur area:",
    {
      parse_mode: "HTML",
      reply_markup: shareLocationKeyboard(),
    }
  );

  await ctx.reply("Or select your locality:", {
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons },
  });
};

const handleLocation = async (ctx) => {
  const location = ctx.message.location;
  if (!location) return;

  try {
    await saveSessionLocation({
      telegramId: ctx.from?.id,
      latitude: location.latitude,
      longitude: location.longitude,
      persistHome: true,
    });
    eventBus.emitSafe("location.permission.accepted", {
      telegramId: ctx.from?.id,
    });
    const recommendation = await recommendNearbyPharmacies({
      telegramId: ctx.from?.id,
      latitude: location.latitude,
      longitude: location.longitude,
    });
    const readiness = await getNearbyPharmacyReadiness({
      latitude: location.latitude,
      longitude: location.longitude,
    });
    eventBus.emitSafe("nearby.completed", {
      telegramId: ctx.from?.id,
      resultCount: recommendation.ranked?.length || 0,
      radiusKm: recommendation.radiusKm,
    });

    const nearbyList = recommendation.ranked?.length
      ? recommendation.ranked
          .slice(0, 5)
          .map((pharmacy, index) => {
            const distance = pharmacy.distance ? `📍 ${escapeHtml(pharmacy.distance)}` : "📍";
            const open = pharmacy.openStatus
              ? (/open/i.test(pharmacy.openStatus) ? "🟢 Open" : `⏰ ${escapeHtml(pharmacy.openStatus)}`)
              : "";
            const phone = pharmacy.phone ? `📞 ${escapeHtml(pharmacy.phone)}` : "";
            const meta = [distance, open, phone].filter(Boolean).join(" · ");
            return `${index + 1}. <b>${escapeHtml(pharmacy.name)}</b>\n   ${meta}`;
          })
          .join("\n\n")
      : "No nearby pharmacies found for this location.";

    await ctx.reply(
      (recommendation.ranked?.length
        ? `📍 <b>${recommendation.ranked.length} pharmacies near you</b>  <i>within ${recommendation.radiusKm}km${recommendation.osmHydrated ? " · live" : ""}</i>\n\n`
        : `📍 <b>${escapeHtml(readiness.message)}</b>\n\n`) +
        `${nearbyList}\n\n` +
        `<i>Type a medicine name to check availability, or tap below to call/navigate.</i>`,
      {
        parse_mode: "HTML",
        reply_markup: buildNearbyActionKeyboard(recommendation.ranked),
      }
    );
  } catch (error) {
    logger.error(`Location nearby error: ${error.message}`);
    await ctx.reply("Could not process your location right now. Please try /nearby by area.");
  }
};

const formatNearbyRecommendations = (recommendation, medicineQuery = "") => {
  // Zomato/Uber-style nearby card: short, scannable, action-first.
  // Each pharmacy gets one row with the essentials (name, distance, open),
  // and the user picks an action via the inline keyboard (Call / Directions).
  // No internal scores, no source labels, no debug counters — those live in
  // analytics, not the user-facing card.
  if (!recommendation.ranked?.length) {
    return (
      `📍 <b>No pharmacies nearby yet</b>\n\n` +
      `We checked within <b>${recommendation.radiusKm} km</b>. Try sharing your live location again or pick an area with /nearby.`
    );
  }

  const headerMedicine = medicineQuery
    ? `<b>${escapeHtml(recommendation.medicine?.genericName || medicineQuery)}</b>`
    : "<b>Pharmacies near you</b>";
  const radiusBadge = `<i>within ${recommendation.radiusKm}km${
    recommendation.expandedRadius ? " (expanded)" : ""
  }${recommendation.osmHydrated ? " · live" : ""}</i>`;

  const top = recommendation.ranked.slice(0, 5);
  const rows = top.map((item, index) => {
    const name = `<b>${escapeHtml(item.name)}</b>`;
    const distance = item.distance
      ? `📍 ${escapeHtml(item.distance)}`
      : "📍";
    const open = item.openStatus
      ? (/open/i.test(item.openStatus) ? "🟢 Open" : `⏰ ${escapeHtml(item.openStatus)}`)
      : "";
    const phone = item.phone ? `📞 ${escapeHtml(item.phone)}` : "";
    const meta = [distance, open, phone].filter(Boolean).join(" · ");
    return `${index + 1}. ${name}\n   ${meta}`;
  });

  return (
    `📍 ${headerMedicine}  ${radiusBadge}\n\n` +
    `${rows.join("\n\n")}\n\n` +
    `<i>Tap a button below to call or get directions.</i>`
  );
};

const handleNearbyMedicineSearch = async (ctx, { latitude, longitude, medicineQuery }) => {
  const recommendation = await recommendNearbyPharmacies({
    telegramId: ctx.from?.id,
    latitude,
    longitude,
    medicineQuery,
  });
  await ctx.reply(formatNearbyRecommendations(recommendation, medicineQuery), {
    parse_mode: "HTML",
    reply_markup: buildNearbyActionKeyboard(recommendation.ranked),
  });
  return recommendation;
};

/**
 * Show pharmacies in a selected area.
 */
const handleAreaSelection = async (ctx, area) => {
  await ctx.replyWithChatAction("typing");

  try {
    const useRealDataOnly = await realPharmacyDataExists();
    const pharmacies = await Pharmacy.find({
      area: { $regex: area, $options: "i" },
      isActive: true,
      ...(useRealDataOnly ? { source: { $ne: "manual" } } : {}),
    }).lean();

    if (pharmacies.length === 0) {
      return ctx.editMessageText(
        `😔 No pharmacies found in <b>${escapeHtml(area)}</b> yet.\n\n` +
          `We're expanding! Use /feedback to suggest pharmacies to add.`,
        { parse_mode: "HTML" }
      );
    }

    let message = `🏪 <b>Pharmacies in ${escapeHtml(area)}</b>\n\n`;

    for (const pharmacy of pharmacies) {
      // Count medicines in stock at this pharmacy
      const stockCount = await Inventory.countDocuments({
        pharmacy: pharmacy._id,
        inStock: true,
      });

      message += `<b>${escapeHtml(pharmacy.name)}</b>\n`;
      message += `📍 ${escapeHtml(pharmacy.address)}\n`;
      if (pharmacy.contact?.phone) {
        message += `📞 ${escapeHtml(pharmacy.contact.phone)}\n`;
      }
      message += `🕐 ${pharmacy.is24x7 ? "Open 24×7" : escapeHtml(pharmacy.openingHours)}\n`;
      message += `💊 ${stockCount} medicines tracked\n\n`;
    }

    message += `<i>Type a medicine name to check availability at these pharmacies.</i>`;

    await ctx.editMessageText(message, { parse_mode: "HTML" });
  } catch (error) {
    logger.error(`Area selection error: ${error.message}`);
    await ctx.reply("⚠️ Could not load pharmacies. Please try again.");
  }
};

/**
 * Handle /areas command — list all covered areas.
 */
const handleAreas = async (ctx) => {
  const areaList = JAIPUR_AREAS.map((a) => `• ${a}`).join("\n");
  await ctx.reply(
    `📍 <b>Areas covered in Jaipur:</b>\n\n${areaList}\n\n` +
      `Use /nearby to browse pharmacies by area.`,
    { parse_mode: "HTML" }
  );
};

module.exports = {
  buildNearbyActionKeyboard,
  formatNearbyRecommendations,
  handleNearby,
  handleNearbyMedicineSearch,
  handleAreaSelection,
  handleAreas,
  handleLocation,
  JAIPUR_AREAS,
};
