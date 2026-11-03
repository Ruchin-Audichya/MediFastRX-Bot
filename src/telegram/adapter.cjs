const { Bot, InlineKeyboard, Keyboard } = require("grammy");
const { randomBytes } = require("node:crypto");
const { createMedicineService } = require("../service.cjs");
const { explain } = require("../explain.cjs");
const { location } = require("../pharmacy/service.cjs");

const escape = (s) =>
  String(s ?? "").replace(
    /[&<>\"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const clip = (s, n = 550) => String(s || "").slice(0, n);
const signature = (m) =>
  clip([m.name, m.strength, m.form].filter(Boolean).join(" · "), 220);
const https = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
};
function appLink(base, medicineId, screen) {
  const safe = https(base);
  if (!safe) return null;
  const u = new URL(safe);
  if (medicineId) u.searchParams.set("medicine", medicineId);
  if (screen) u.searchParams.set("screen", screen);
  return u.href;
}
function createSessionStore({
  now = Date.now,
  ttl = 30 * 60_000,
  max = 1000,
} = {}) {
  const sessions = new Map();
  function get(key) {
    for (const [id, s] of sessions) if (s.expires <= now()) sessions.delete(id);
    let s = sessions.get(key);
    if (!s) {
      if (sessions.size >= max) sessions.delete(sessions.keys().next().value);
      s = {
        state: { medicineId: null, intent: null },
        nonce: "",
        pending: [],
        places: [],
        seen: new Set(),
        window: now(),
        count: 0,
        ai: 0,
        nearby: 0,
      };
      sessions.set(key, s);
    }
    s.expires = now() + ttl;
    if (now() - s.window >= 60_000) {
      s.window = now();
      s.count = s.ai = s.nearby = 0;
    }
    return s;
  }
  return {
    get,
    delete: (key) => sessions.delete(key),
    size: () => sessions.size,
  };
}
function createTelegramBot({
  token,
  botInfo,
  catalog,
  pharmacies,
  webUrl = process.env.TELEGRAM_APP_URL,
  explainOptions = {},
  store = createSessionStore(),
  logger = console,
} = {}) {
  if (!catalog || !pharmacies)
    throw Error(
      "Telegram requires the shared medicine catalog and pharmacy service.",
    );
  const bot = new Bot(token, { botInfo, client: { timeoutSeconds: 6 } });
  const medicineService = createMedicineService(catalog);
  const queues = new Map();
  const home = () => {
    const k = new InlineKeyboard()
      .text("Try Dolo 650", "example:dolo")
      .text("Try Cetirizine", "example:cetirizine")
      .row()
      .text("Find nearby pharmacies", "nearby");
    const url = appLink(webUrl);
    if (url) k.row().url("Open MediFast", url);
    return k;
  };
  const send = (ctx, text, keyboard) =>
    ctx.reply(text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });
  const rotate = (s) => {
    s.nonce = randomBytes(5).toString("hex");
    s.pending = [];
    s.places = [];
    s.awaitingArea = false;
  };
  function actions(s, m) {
    const k = new InlineKeyboard()
      .text("Explain simply", `act:${s.nonce}:simple`)
      .text("Side effects", `act:${s.nonce}:effects`)
      .row()
      .text("Active ingredient", `act:${s.nonce}:generic`)
      .text("Nearby pharmacies", `act:${s.nonce}:nearby`)
      .row()
      .text("AI evidence summary", `act:${s.nonce}:ai`);
    const url = appLink(webUrl, m.id);
    if (url) k.row().url("View / request this exact product", url);
    return k;
  }
  async function nearbyPrompt(ctx, s) {
    s.awaitingArea = true;
    const active = catalog.get(s.state.medicineId || "");
    await send(
      ctx,
      `${active ? `<b>Looking near you for ${escape(signature(active))}</b>\n\n` : ""}Share a location once, or type an area and city (for example <code>Jaipur</code> or <code>Mansarovar, Jaipur</code>).\n\nShared coordinates are sent to Photon/OpenStreetMap for this search. I don’t retain them in your chat context. A nearby shop is not proof of stock.\n\nUse /reset to clear this conversation.`,
      new Keyboard()
        .requestLocation("Share location for this search")
        .resized()
        .oneTime(),
    );
  }
  async function showMedicine(ctx, s, query, confirmId) {
    const r = medicineService.respond({ query, confirmId, state: s.state });
    s.state = r.state;
    rotate(s);
    if (r.status === "candidates") {
      s.pending = r.candidates.map((m) => m.id);
      const k = new InlineKeyboard();
      for (const [i, m] of r.candidates.entries())
        k.text(clip(signature(m), 58), `pick:${s.nonce}:${i}`).row();
      return send(
        ctx,
        `<b>Found a possible match.</b>\n${escape(r.answer)}\n\n${r.candidates.map((m, i) => `${i + 1}. <b>${escape(signature(m))}</b>\n${escape(m.generic)}`).join("\n\n")}\n\nChoose the exact product on the pack. Similar ingredients do not mean interchangeable medicines.`,
        k,
      );
    }
    if (r.status === "confirmed") {
      const m = r.medicine;
      if (s.state.intent === "pharmacies") return nearbyPrompt(ctx, s);
      const source = m.sources?.[0];
      const sourceUrl = https(source?.url);
      return send(
        ctx,
        `<b>${escape(signature(m))}</b>\nMatched ${m.demo ? "demo" : "catalog"} record · ${escape(m.generic)}\n\n${escape(clip(r.answer, 1250))}\n\n${sourceUrl ? `<a href="${escape(sourceUrl)}">${escape(source.label)}</a>` : "Source details not supplied"}\nReview date: ${escape(m.reviewedAt || "not supplied")}\n\nFor understanding, not prescribing. Ask a pharmacist about personal suitability.`,
        actions(s, m),
      );
    }
    return send(ctx, escape(r.answer), home());
  }
  async function showPharmacies(ctx, s, input) {
    if (++s.nearby > 6)
      return send(ctx, "Please wait a minute before another nearby search.");
    // Coordinates remain local to this call and are never put in the session.
    const r = await pharmacies.search(input);
    s.awaitingArea = false;
    await ctx.reply(
      `${r.mode === "demo" ? "DEMO — fictional shop locations. No real contacts or stock." : "Public pharmacy listings — inventory unknown."}\n${clip(r.notice, 450)}\nDistances are straight-line estimates. Call before you head out.`,
      { reply_markup: { remove_keyboard: true } },
    );
    if (!r.items.length)
      return send(
        ctx,
        "No listings found within 5 km. Try /nearby with another area. If the live provider is unavailable, you can retry shortly.",
      );
    const active = catalog.get(s.state.medicineId || "");
    for (const p of r.items.slice(0, 5)) {
      const k = new InlineKeyboard();
      if (!p.demo)
        k.url(
          "Directions",
          `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${p.lat},${p.lng}`)}`,
        );
      const sourceUrl = https(p.sourceUrl);
      if (sourceUrl) k.url("Listing source", sourceUrl);
      const contactSource = https(p.contactSourceUrl);
      if (contactSource && contactSource !== sourceUrl)
        k.row().url("Phone number source", contactSource);
      await send(
        ctx,
        `<b>${escape(clip(p.name, 150))}</b>${p.demo ? " · DEMO" : ""}\n${Number(p.distanceKm).toFixed(1)} km away · ${escape(clip(p.address, 280))}\n\nPhone: ${escape(p.demo ? "not provided for sample stores" : p.phone || "not published in this source")}\n${p.hours ? `Listed hours (unverified): ${escape(clip(p.hours, 180))}\n` : ""}Source: ${escape(clip(p.source, 150))}\n${p.checkedAt ? `Source checked: ${escape(p.checkedAt.slice(0, 10))}\n` : ""}\n${active ? `${escape(signature(active))}: ` : ""}<b>Stock unknown. Call to confirm.</b>`,
        k.inline_keyboard.length ? k : undefined,
      );
    }
    const url = appLink(webUrl, active?.id, "partners");
    if (url)
      await send(
        ctx,
        "Want a participating shop to respond? Submit an authenticated availability request in MediFast. Public listings and partner stock have separate labels.",
        new InlineKeyboard().url("Ask a participating pharmacy", url),
      );
  }
  async function searchArea(ctx, s, area) {
    try {
      return await showPharmacies(ctx, s, { ...location({ area }), radius: 5 });
    } catch (e) {
      if (!/Choose a location/.test(e.message)) throw e;
    }
    const r = await pharmacies.places(area);
    if (!r.items.length)
      return send(
        ctx,
        "I couldn’t find that area. Try its name followed by the city, or /nearby Jaipur.",
      );
    rotate(s);
    s.places = r.items.slice(0, 5);
    const k = new InlineKeyboard();
    s.places.forEach((p, i) =>
      k.text(clip(p.label, 60), `place:${s.nonce}:${i}`).row(),
    );
    await send(
      ctx,
      "<b>Which place do you mean?</b>\nChoose your area before I search nearby. I won’t assume the first result.",
      k,
    );
  }
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== "private" || !ctx.from) {
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery({
          text: "Please use a private chat with MediFast.",
        });
      else if (ctx.message?.text?.startsWith("/"))
        await ctx.reply(
          "Please message MediFast privately for medicine questions.",
        );
      return;
    }
    const key = String(ctx.from.id);
    const queued = queues.get(key);
    if (!queued && queues.size >= 1000) {
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery({
          text: "MediFast is busy. Please retry shortly.",
        });
      return;
    }
    if ((queued?.count || 0) >= 10) {
      if (ctx.callbackQuery)
        await ctx.answerCallbackQuery({
          text: "Please wait for your last request.",
        });
      return;
    }
    const before = queued?.promise || Promise.resolve();
    let release;
    const done = new Promise((r) => {
      release = r;
    });
    const entry = {
      promise: before.then(() => done),
      count: (queued?.count || 0) + 1,
    };
    queues.set(key, entry);
    await before;
    try {
      const s = store.get(key);
      if (s.seen.has(ctx.update.update_id)) return;
      s.seen.add(ctx.update.update_id);
      if (s.seen.size > 64) s.seen.delete(s.seen.values().next().value);
      if (++s.count > 30) {
        if (ctx.callbackQuery)
          await ctx.answerCallbackQuery({ text: "Please wait a minute." });
        else
          await send(
            ctx,
            "A lot of questions! Please wait a minute, then try again.",
          );
        return;
      }
      ctx.medifast = s;
      try {
        await next();
      } catch {
        logger.warn(
          "Telegram operation unavailable; chat contents and credentials omitted.",
        );
        await send(
          ctx,
          "That service didn’t respond. Please retry, or use /reset for a fresh start.",
        ).catch(() => {});
      }
    } finally {
      release();
      if (queues.get(key) === entry) queues.delete(key);
    }
  });
  bot.command("start", async (ctx) => {
    store.delete(String(ctx.from.id));
    await send(
      ctx,
      `<b>MediFast · Medicine confusion, sorted.</b>\n\nSend the name on your medicine pack. I’ll help identify it, show sourced information, and find pharmacies to contact.\n\nTry <code>Dolo 650</code>, <code>Mujhe Dolo 650 chahiye</code>, or <code>Cetirizine</code>. Check every strength and formulation.\n\n${catalog.status().mode === "demo" ? "This bot currently uses a small sourced demo catalog.\n\n" : ""}Use /help for actions and /privacy for data details.`,
      home(),
    );
  });
  bot.command("help", (ctx) =>
    send(
      ctx,
      "<b>Your medicine, one clear conversation.</b>\n\nSend a medicine name, then ask ‘side effects’, ‘what’s the generic?’ or ‘mere aas paas kaha milegi?’.\n\n/search name — start a lookup\n/nearby area — pharmacies within 5 km\n/explain — supplied plain-language evidence\n/ai — optional AI selection of catalog evidence\n/reset — clear medicine and pending choices\n/web — requests, prescription scanner and medicine shelf\n/privacy — what is retained\n\nI don’t diagnose, choose doses, prescribe substitutes, or claim stock from proximity. Photos and voice notes are not processed in this chat; use the signed-in web scanner or send editable text.",
      home(),
    ),
  );
  bot.command("privacy", (ctx) =>
    send(
      ctx,
      "<b>Your chat context</b>\nOnly your last medicine, pending choices and short-lived abuse/retry counters are kept in memory for up to 30 minutes, bounded to 1,000 sessions. A restart clears them. /reset clears your session. No chat text or coordinates are logged or written to the catalog.\n\nTelegram retains messages under its own policy. Shared coordinates reach the map provider only when you request nearby search. Optional AI receives catalog evidence, not your message or location. Availability requests and prescription images belong in the signed-in web app.",
    ),
  );
  bot.command("reset", async (ctx) => {
    store.delete(String(ctx.from.id));
    await ctx.reply(
      "Fresh start. Your medicine and pending choices are cleared. Send another name.",
      { reply_markup: { remove_keyboard: true } },
    );
  });
  bot.command("web", (ctx) => {
    const url = appLink(webUrl, ctx.medifast.state.medicineId);
    return send(
      ctx,
      url
        ? "Open MediFast for your reference shelf, prescription scanner, partner requests, and live pickup updates. Sign in there to keep requests private."
        : "The web app runs on the computer hosting MediFast at http://127.0.0.1:3000. A public HTTPS app address hasn’t been configured for phone access yet.",
      url ? new InlineKeyboard().url("Continue in MediFast", url) : undefined,
    );
  });
  bot.command("search", (ctx) =>
    ctx.match?.trim()
      ? showMedicine(ctx, ctx.medifast, ctx.match.trim())
      : send(
          ctx,
          "Send the full medicine name and strength, for example <code>/search Dolo 650</code>.",
        ),
  );
  bot.command("nearby", (ctx) =>
    ctx.match?.trim()
      ? searchArea(ctx, ctx.medifast, ctx.match.trim())
      : nearbyPrompt(ctx, ctx.medifast),
  );
  bot.command("explain", (ctx) =>
    showMedicine(ctx, ctx.medifast, "explain simply"),
  );
  async function ai(ctx) {
    const s = ctx.medifast,
      m = catalog.get(s.state.medicineId || "");
    if (!m)
      return send(
        ctx,
        "Search and confirm a medicine first. AI won’t invent an unidentified medicine profile.",
      );
    if (++s.ai > 4)
      return send(
        ctx,
        "Please wait a minute before another AI summary. The catalog details and /explain remain available.",
      );
    const r = await explain(m, explainOptions);
    return send(
      ctx,
      `<b>${r.kind === "ai_selection" ? "AI-selected catalog evidence" : "Catalog explanation · AI unavailable or off"}</b>\nAbout ${escape(signature(m))}\n\n${escape(clip(r.text, 2200))}\n\nOnly supplied evidence is used. This doesn’t determine personal suitability.`,
      actions(s, m),
    );
  }
  bot.command("ai", ai);
  bot.on("callback_query:data", async (ctx) => {
    const s = ctx.medifast,
      data = ctx.callbackQuery.data;
    await ctx.answerCallbackQuery();
    if (data === "nearby") return nearbyPrompt(ctx, s);
    if (data === "example:dolo") return showMedicine(ctx, s, "Dolo 650");
    if (data === "example:cetirizine")
      return showMedicine(ctx, s, "Cetirizine");
    const [kind, nonce, value] = data.split(":");
    if (!s.nonce || nonce !== s.nonce)
      return send(
        ctx,
        "That choice belongs to an older search. Use the latest buttons or send the medicine name again.",
      );
    if (kind === "pick" && /^\d$/.test(value) && s.pending[Number(value)])
      return showMedicine(ctx, s, "", s.pending[Number(value)]);
    if (kind === "place" && /^\d$/.test(value) && s.places[Number(value)]) {
      const place = s.places[Number(value)];
      s.places = [];
      return showPharmacies(ctx, s, { ...place, radius: 5 });
    }
    if (kind === "act") {
      if (value === "nearby") return nearbyPrompt(ctx, s);
      if (value === "ai") return ai(ctx);
      const query = {
        simple: "explain simply",
        effects: "side effects",
        generic: "generic",
      }[value];
      if (query) return showMedicine(ctx, s, query);
    }
    return send(ctx, "That action has expired. Search again or use /help.");
  });
  bot.on("message:location", async (ctx) => {
    if (!ctx.medifast.awaitingArea)
      return send(
        ctx,
        "Use /nearby first to choose a one-time location search. I haven’t sent these coordinates to a map provider.",
      );
    if (ctx.message.location.live_period)
      return send(
        ctx,
        "Please send a single location pin rather than live tracking. You can also type /nearby Jaipur.",
      );
    return showPharmacies(ctx, ctx.medifast, {
      lat: ctx.message.location.latitude,
      lng: ctx.message.location.longitude,
      radius: 5,
    });
  });
  bot.on("message:text", (ctx) => {
    const text = ctx.message.text.trim();
    if (text.length > 200)
      return send(
        ctx,
        "Please use a medicine name or short follow-up, up to 200 characters.",
      );
    if (text.startsWith("/"))
      return send(
        ctx,
        "I don’t recognize that command. Use /help for the available actions.",
      );
    return ctx.medifast.awaitingArea
      ? searchArea(ctx, ctx.medifast, text)
      : showMedicine(ctx, ctx.medifast, text);
  });
  bot.on("message", (ctx) =>
    send(
      ctx,
      "For photos and PDFs, use the signed-in MediFast prescription scanner. This chat accepts medicine names as text and one-time location pins. Voice input in the web app produces editable text before search.",
      appLink(webUrl, null, "scanner")
        ? new InlineKeyboard().url(
            "Open prescription scanner",
            appLink(webUrl, null, "scanner"),
          )
        : undefined,
    ),
  );
  bot.catch((err) =>
    logger.warn(
      `Telegram update failed (${err.error?.error_code || "transport"}); private payload omitted.`,
    ),
  );
  return { bot, store };
}
const commands = [
  ["start", "Meet MediFast"],
  ["search", "Find an exact medicine"],
  ["nearby", "Find pharmacies by area or location"],
  ["explain", "Explain the confirmed medicine"],
  ["ai", "Optional catalog evidence summary"],
  ["reset", "Clear this chat context"],
  ["web", "Open requests, shelf and scanner"],
  ["help", "Help and supported actions"],
  ["privacy", "How chat data is handled"],
].map(([command, description]) => ({ command, description }));
module.exports = {
  createTelegramBot,
  createSessionStore,
  commands,
  appLink,
  escape,
};
