import { Bot, InlineKeyboard, Keyboard, type Context, type Api } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { DomainError, type MediFast, type Plan, type Transport, type User } from "../domain/medifast.ts";
import type { Area } from "../domain/seed.ts";
import { distanceM } from "../domain/geo.ts";
import * as V from "./views.ts";

export type BotDeps = {
  mf: MediFast;
  transport: Exclude<Transport, "sim">;
  token: string;
  botInfo?: UserFromGetMe;
  areas: Area[];
  links: V.Links;
  adminIds: Set<string>; // Telegram user ids that are admins on this transport
  extract: (image: Buffer, mime: string) => Promise<string>;
  download: (api: Api, fileId: string) => Promise<{ data: Buffer; mime: string }>;
};

type Ctx = Context & { user: User };
type Flow =
  | { await: "price"; rid: number }
  | { await: "partner"; step: "name" | "location" | "phone" | "license"; data: Record<string, any> }
  | { batch: { productId: string; qty: number }[] };

const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
const GREETING = /^(hi|hii+|hello|hey|namaste|start|menu|help me)\b/i;

export function createBot(deps: BotDeps) {
  const { mf } = deps;
  const bot = new Bot<Ctx>(deps.token, deps.botInfo ? { botInfo: deps.botInfo } : undefined);

  // ── Identity: every update maps to one persisted user on this transport.
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return;
    if (ctx.chat && ctx.chat.type !== "private") return; // private chats only
    const user = mf.users.upsert({
      ref: `${deps.transport}:${ctx.from.id}`,
      transport: deps.transport,
      chatId: String(ctx.chat?.id ?? ctx.from.id),
      name: [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(" ") || "Friend",
      username: ctx.from.username ?? null,
    });
    if (deps.adminIds.has(String(ctx.from.id)) && !user.is_admin) mf.users.setAdmin(user.id, true);
    ctx.user = mf.users.get(user.id)!;
    await next();
  });

  const reply = (ctx: Ctx, v: V.View, extra: object = {}) => ctx.reply(v.text, { ...HTML, reply_markup: v.keyboard, ...extra });
  const edit = async (ctx: Ctx, v: V.View) => {
    try {
      await ctx.editMessageText(v.text, { ...HTML, reply_markup: v.keyboard });
    } catch (e: any) {
      if (!/not modified/.test(String(e?.description ?? e))) await reply(ctx, v);
    }
  };
  const state = (ctx: Ctx) => mf.users.getState(ctx.user.id) as Flow | null;
  const setState = (ctx: Ctx, s: Flow | null) => mf.users.setState(ctx.user.id, s);
  const pharmacy = (ctx: Ctx) => mf.pharmacies.byOwner(ctx.user.id);
  const removeKeyboard = { reply_markup: { remove_keyboard: true as const } };

  // ───────────── Commands ─────────────
  bot.command("start", async (ctx) => {
    setState(ctx, null);
    if (ctx.match === "partner") return startPartner(ctx);
    const ph = pharmacy(ctx);
    if (ph) return reply(ctx, V.deskCard(mf, ph, deps.links));
    await reply(ctx, V.welcome(ctx.user.name));
  });
  bot.command("help", (ctx) => reply(ctx, V.help));
  bot.command("privacy", (ctx) => reply(ctx, V.privacy));
  bot.command("list", (ctx) => reply(ctx, V.listCard(mf, mf.drafts.get(ctx.user.id))));
  bot.command("meds", (ctx) => reply(ctx, V.savedCard(mf.saved.list(ctx.user.id))));
  bot.command("asks", (ctx) => reply(ctx, V.asksCard(mf, mf.history.asksOf(ctx.user.id, 6))));
  bot.command("scan", (ctx) => ctx.reply("📷 Send a clear photo of a <b>printed</b> prescription (flat, well lit, the whole page). I'll read the medicine names and you'll confirm each one.\n\nHandwriting is hard for me. Typing the names is safer.", HTML));
  bot.command("forget", async (ctx) => {
    mf.users.forget(ctx.user.id);
    await ctx.reply("Done. Your list, location and saved medicines are erased.", removeKeyboard);
  });
  bot.command(["cancel", "skip"], async (ctx) => {
    const s = state(ctx);
    setState(ctx, null);
    await ctx.reply(s ? "Okay, cancelled." : "Nothing to cancel.", removeKeyboard);
  });
  bot.command("partner", (ctx) => startPartner(ctx));
  bot.command("desk", async (ctx) => {
    const ph = pharmacy(ctx);
    if (!ph) return ctx.reply("This account isn't a pharmacy yet. Send /partner to list your shop.");
    await reply(ctx, V.deskCard(mf, ph, deps.links));
    for (const o of mf.history.inbox(ph.id).open) await reply(ctx, V.requestCard(o.ask, o.recipient, deps.links));
  });
  bot.command(["open", "close"], async (ctx) => {
    try {
      const ph = mf.pharmacies.setAccepting(ctx.user.id, ctx.message?.text?.startsWith("/open") ?? true);
      await reply(ctx, V.deskCard(mf, ph, deps.links));
    } catch (e) { await fail(ctx, e); }
  });
  bot.command("admin", async (ctx) => {
    if (!ctx.user.is_admin) return ctx.reply("Admins only.");
    const m = mf.history.metrics();
    await ctx.reply(`<b>MediFast admin</b>\nPharmacies live: ${m.pharmacies} · pending: ${m.pending}\nRequests: ${m.asks} · reserved: ${m.reserved} · collected: ${m.collected}\nAnswers given: ${m.answers}`, HTML);
    for (const p of mf.pharmacies.list("pending")) await reply(ctx, V.pendingPharmacyCard(p));
  });

  // ───────────── Customer: building the list ─────────────
  async function handleMedicineText(ctx: Ctx, text: string, source: "typed" | "scan" = "typed") {
    const lines = mf.catalog.resolveMany(text);
    if (!lines.length) return reply(ctx, V.notFound(text.slice(0, 40)));
    if (lines.length === 1 && source === "typed") {
      const { result, qty, line } = lines[0];
      const name = line.replace(/\s*(x|×)\s*\d+$/i, "");
      if (result.kind === "exact") return reply(ctx, V.productCard(result.product, qty));
      if (result.kind === "choose") return reply(ctx, V.chooser(result.reason, name, result.options, qty));
      return reply(ctx, V.notFound(name));
    }
    const exact = lines.flatMap((l) => (l.result.kind === "exact" ? [{ productId: l.result.product.id, qty: l.qty, product: l.result.product }] : []));
    const unknown = lines.filter((l) => l.result.kind === "none").map((l) => l.line);
    const head = source === "scan" ? "📷 <b>From your prescription I could read:</b>" : "<b>Here's what I matched:</b>";
    if (exact.length) {
      setState(ctx, { batch: exact.map(({ productId, qty }) => ({ productId, qty })) });
      const body = exact.map((e) => `• ${V.esc(mf.catalog.get(e.productId)!.brand)} × ${e.qty}  <i>${V.esc(e.product.composition)}</i>`).join("\n");
      await reply(ctx, {
        text: `${head}\n\n${body}\n\nCheck each against your strip or prescription.`,
        keyboard: new InlineKeyboard().text(`✚ Add ${exact.length === 1 ? "it" : `these ${exact.length}`} to my list`, "addbatch").text("Not right", "nope"),
      });
    } else if (source === "scan") await ctx.reply(`${head}`, HTML);
    for (const l of lines) if (l.result.kind === "choose") await reply(ctx, V.chooser(l.result.reason, l.line, l.result.options, l.qty));
    if (unknown.length) await ctx.reply(`Couldn't match: ${unknown.map((u) => `<code>${V.esc(u.slice(0, 40))}</code>`).join(", ")}. Type them as printed on the strip.`, HTML);
  }

  async function showList(ctx: Ctx, note = "", inPlace = true) {
    const v = V.listCard(mf, mf.drafts.get(ctx.user.id), note);
    return inPlace && ctx.callbackQuery ? edit(ctx, v) : reply(ctx, v);
  }

  async function goAsk(ctx: Ctx) {
    const items = mf.drafts.get(ctx.user.id);
    if (!items.length) return showList(ctx);
    const u = mf.users.get(ctx.user.id)!;
    if (u.lat == null || u.lng == null) return askWhere(ctx);
    return edit(ctx, confirmView(u));
  }

  function confirmView(u: User) {
    const near = mf.pharmacies.nearby({ lat: u.lat!, lng: u.lng! }, u.radius_km).filter((n) => n.pharmacy.owner_id !== u.id);
    const all = mf.pharmacies.list("approved").filter((p) => p.accepting && p.owner_id !== u.id);
    const nearest = all.length ? Math.min(...all.map((p) => distanceM({ lat: u.lat!, lng: u.lng! }, p))) : null;
    return V.confirmAsk(u.place ?? "you", u.radius_km, Math.min(near.length, 12), nearest, mf.drafts.get(u.id).length);
  }

  async function askWhere(ctx: Ctx, partner = false) {
    await ctx.reply(partner ? "📍 Share the shop's location using the button below (send it while you're at the shop):" : "Share your location for accurate distances:", {
      reply_markup: new Keyboard().requestLocation("📍 Share location").resized().oneTime(),
    });
    const v = V.whereCard(deps.areas);
    if (partner) v.keyboard = rewire(v.keyboard!, "area:", "parea:");
    await reply(ctx, v);
  }
  const rewire = (kb: any, from: string, to: string) => {
    kb.inline_keyboard.forEach((row: any[]) => row.forEach((b) => b.callback_data && (b.callback_data = b.callback_data.replace(from, to))));
    return kb;
  };

  // ───────────── Callback router ─────────────
  const routes: [RegExp, (ctx: Ctx, m: RegExpMatchArray) => Promise<unknown> | unknown][] = [
    // customer
    [/^add:([\w-]+):(\d+)$/, async (ctx, m) => {
      const p = mf.catalog.get(m[1]);
      mf.drafts.add(ctx.user.id, m[1], Number(m[2]));
      await ctx.answerCallbackQuery(`Added ${p?.brand}`);
      await showList(ctx, `✓ Added <b>${V.esc(p?.brand)}</b>.`);
    }],
    [/^addbatch$/, async (ctx) => {
      const s = state(ctx);
      if (!s || !("batch" in s)) return ctx.answerCallbackQuery("That list has expired. Send it again.");
      for (const b of s.batch) mf.drafts.add(ctx.user.id, b.productId, b.qty);
      setState(ctx, null);
      await showList(ctx, `✓ Added ${s.batch.length} medicine${s.batch.length > 1 ? "s" : ""}.`);
    }],
    [/^nope$/, (ctx) => edit(ctx, { text: "No problem. Type the name exactly as printed on the strip, or the salt name (for example <code>pantoprazole 40</code>)." })],
    [/^q:([\w-]+):(-?\d)$/, async (ctx, m) => { if (m[2] !== "0") mf.drafts.change(ctx.user.id, m[1], Number(m[2])); await showList(ctx); }],
    [/^rm:([\w-]+)$/, async (ctx, m) => { mf.drafts.remove(ctx.user.id, m[1]); await showList(ctx); }],
    [/^clr$/, async (ctx) => { mf.drafts.clear(ctx.user.id); await showList(ctx); }],
    [/^list$/, (ctx) => showList(ctx, "", false)],
    [/^meds$/, (ctx) => reply(ctx, V.savedCard(mf.saved.list(ctx.user.id)))],
    [/^help$/, (ctx) => reply(ctx, V.help)],
    [/^scan$/, (ctx) => ctx.reply("📷 Send a photo of a printed prescription. I'll read the names and you confirm each one.")],
    [/^savelist$/, async (ctx) => { mf.saved.save(ctx.user.id, mf.drafts.get(ctx.user.id)); await ctx.answerCallbackQuery({ text: "Saved to My medicines 💊", show_alert: false }); }],
    [/^refill(-list)?$/, async (ctx, m) => {
      const items = mf.saved.list(ctx.user.id).map((s) => ({ productId: s.product.id, qty: s.qty }));
      mf.drafts.set(ctx.user.id, items);
      return m[1] ? showList(ctx, "Loaded your medicines.", false) : goAsk(ctx);
    }],
    [/^go$/, (ctx) => goAsk(ctx)],
    [/^where$/, (ctx) => askWhere(ctx)],
    [/^area:(\w+)$/, async (ctx, m) => {
      const a = deps.areas.find((x) => x.id === m[1]);
      if (!a) return;
      mf.users.setLocation(ctx.user.id, { lat: a.lat, lng: a.lng, place: a.name });
      await edit(ctx, { text: `📍 Area: <b>${a.name}</b>` });
      // A message is the only way to dismiss the "Share location" reply keyboard.
      if (!mf.drafts.get(ctx.user.id).length) return ctx.reply("Got it. Now tell me which medicines you need.", removeKeyboard);
      await ctx.reply(`Looking around ${a.name}.`, removeKeyboard);
      await reply(ctx, confirmView(mf.users.get(ctx.user.id)!));
    }],
    [/^rad:(\d)$/, async (ctx, m) => { mf.users.setRadius(ctx.user.id, Number(m[1])); await edit(ctx, confirmView(mf.users.get(ctx.user.id)!)); }],
    [/^send$/, async (ctx) => {
      const u = mf.users.get(ctx.user.id)!;
      const ask = mf.asks.create(u.id, { items: mf.drafts.get(u.id), lat: u.lat!, lng: u.lng!, place: u.place ?? "you", radiusKm: u.radius_km });
      mf.drafts.clear(u.id);
      await ctx.answerCallbackQuery("Sent! Answers will appear live.");
      const v = V.boardView(mf.asks.board(ask.id), deps.links, mf.now());
      await ctx.editMessageText(v.text, { ...HTML, reply_markup: v.keyboard });
      mf.setRef.board(ask.id, { chat: ctx.chat!.id, message: ctx.callbackQuery!.message!.message_id });
    }],
    [/^brd:(\w+)$/, async (ctx, m) => {
      const ask = mf.asks.get(m[1]);
      if (!ask || ask.customer_id !== ctx.user.id) return;
      const sent = await reply(ctx, V.boardView(mf.asks.board(ask.id), deps.links, mf.now()));
      if (ask.status === "open") mf.setRef.board(ask.id, { chat: sent.chat.id, message: sent.message_id });
    }],
    [/^res:(\w+):(\d+)$/, async (ctx, m) => {
      mf.asks.reserve(m[1], ctx.user.id, mf.asks.planFor(m[1], Number(m[2])));
      await ctx.answerCallbackQuery("Reserved 🎟");
    }],
    [/^split:(\w+)$/, async (ctx, m) => {
      const split = mf.asks.board(m[1]).split;
      if (!split) return ctx.answerCallbackQuery({ text: "That split is no longer available.", show_alert: true });
      mf.asks.reserve(m[1], ctx.user.id, split.parts as Plan);
      await ctx.answerCallbackQuery("Reserved at both shops 🎟🎟");
    }],
    [/^cx:(\w+)$/, async (ctx, m) => { mf.asks.cancel(m[1], ctx.user.id); await ctx.answerCallbackQuery("Request cancelled"); }],
    [/^again:(\w+)$/, async (ctx, m) => {
      const ask = mf.asks.get(m[1]);
      if (!ask || ask.customer_id !== ctx.user.id) return;
      mf.drafts.set(ctx.user.id, ask.items.filter((i) => mf.catalog.get(i.productId)).map((i) => ({ productId: i.productId, qty: i.qty })));
      await showList(ctx, "Loaded your earlier list.", false);
    }],
    [/^rc:(\w+)$/, async (ctx, m) => { mf.reservations.update(m[1], ctx.user.id, "cancelled"); await ctx.answerCallbackQuery("Reservation cancelled"); }],
    [/^save:(\w+)$/, async (ctx, m) => {
      const ask = mf.asks.get(m[1]);
      if (!ask || ask.customer_id !== ctx.user.id) return;
      mf.saved.save(ctx.user.id, ask.items.map((i) => ({ productId: i.productId, qty: i.qty })));
      await ctx.answerCallbackQuery({ text: "Saved. Next time: /meds → Refill 💊", show_alert: true });
    }],
    // pharmacist
    [/^m:(\d+):(\d+):([htan])$/, async (ctx, m) => {
      const a = V.answerFromCode(m[3]);
      mf.answers.mark(Number(m[1]), ctx.user.id, Number(m[2]), a);
      await ctx.answerCallbackQuery(`${V.ICON[a]} item ${Number(m[2]) + 1}`);
    }],
    [/^all:(\d+):([hn])$/, async (ctx, m) => {
      mf.answers.submit(Number(m[1]), ctx.user.id, { all: V.answerFromCode(m[2]) });
      await ctx.answerCallbackQuery("Answer sent 📤");
    }],
    [/^sub:(\d+)$/, async (ctx, m) => { mf.answers.submit(Number(m[1]), ctx.user.id, { fill: "no" }); await ctx.answerCallbackQuery("Answer sent 📤"); }],
    [/^ed:(\d+)$/, async (ctx, m) => { mf.answers.edit(Number(m[1]), ctx.user.id); await ctx.answerCallbackQuery("Change your marks, then send again."); }],
    [/^pr:(\d+)$/, async (ctx, m) => {
      setState(ctx, { await: "price", rid: Number(m[1]) });
      await ctx.reply("💰 Reply with the <b>total in ₹</b> for the items you have (numbers only, e.g. <code>245</code>). /skip to leave it out.", HTML);
    }],
    [/^rs:(\w+):(ready|collected|declined)$/, async (ctx, m) => {
      mf.reservations.update(m[1], ctx.user.id, m[2] as "ready");
      await ctx.answerCallbackQuery({ ready: "Customer notified 📦", collected: "Marked collected ✅", declined: "Customer notified" }[m[2]]!);
    }],
    [/^acc:([01])$/, async (ctx, m) => { const ph = mf.pharmacies.setAccepting(ctx.user.id, m[1] === "1"); await edit(ctx, V.deskCard(mf, ph, deps.links)); }],
    [/^parea:(\w+)$/, async (ctx, m) => {
      const s = state(ctx);
      const a = deps.areas.find((x) => x.id === m[1]);
      if (!s || !("await" in s) || s.await !== "partner" || !a) return;
      await partnerStep(ctx, s, { lat: a.lat, lng: a.lng, area: a.name });
    }],
    // admin
    [/^adm:(\d+):(approved|rejected)$/, async (ctx, m) => {
      const ph = mf.pharmacies.review(Number(m[1]), ctx.user.id, m[2] as "approved");
      await edit(ctx, { text: `${m[2] === "approved" ? "✅ Approved" : "Rejected"}: <b>${V.esc(ph.name)}</b>` });
    }],
  ];

  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    const route = routes.find(([re]) => re.test(data));
    try {
      if (!route) return await ctx.answerCallbackQuery("That button has expired.");
      await route[1](ctx, data.match(route[0])!);
      await ctx.answerCallbackQuery().catch(() => {});
    } catch (e) {
      await fail(ctx, e);
    }
  });

  async function fail(ctx: Ctx, e: unknown) {
    if (!(e instanceof DomainError)) {
      console.error("[bot]", e);
      e = new DomainError("internal", "Something went wrong on our side. Please try again.");
    }
    const msg = (e as DomainError).message;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: msg, show_alert: true }).catch(() => {});
    else await ctx.reply(msg);
  }

  // ───────────── Pharmacy onboarding ─────────────
  async function startPartner(ctx: Ctx) {
    const ph = pharmacy(ctx);
    if (ph) return reply(ctx, V.deskCard(mf, ph, deps.links));
    setState(ctx, { await: "partner", step: "name", data: {} });
    await ctx.reply(
      "🏪 <b>List your pharmacy on MediFast</b>\n\nCustomers nearby send their medicine list; you tap ✅/❌ per item. No stock uploads, no app, no fees in this pilot.\n\nFirst, the <b>shop name</b> as written on your board? (/cancel any time)",
      HTML,
    );
  }

  async function partnerStep(ctx: Ctx, s: Extract<Flow, { await: "partner" }>, input: any) {
    const data = { ...s.data };
    try {
      if (s.step === "name") {
        const name = String(input).trim();
        if (name.length < 3 || name.length > 80) return ctx.reply("Shop name should be 3–80 characters.");
        data.name = name;
        setState(ctx, { await: "partner", step: "location", data });
        return askWhere(ctx, true);
      }
      if (s.step === "location") {
        Object.assign(data, input);
        setState(ctx, { await: "partner", step: "phone", data });
        return ctx.reply("📞 Counter phone number customers can call?", removeKeyboard);
      }
      if (s.step === "phone") {
        const phone = String(input).replace(/[^\d+]/g, "");
        if (!/^\+?\d{10,13}$/.test(phone)) return ctx.reply("That doesn't look like a phone number. 10–13 digits, please.");
        data.phone = phone;
        setState(ctx, { await: "partner", step: "license", data });
        return ctx.reply("📄 Your <b>drug licence number</b> (Form 20/21)? An admin verifies it before you go live.", HTML);
      }
      const ph = mf.pharmacies.register(ctx.user.id, { name: data.name, area: data.area ?? "Jaipur", address: data.address ?? data.area ?? "", lat: data.lat, lng: data.lng, phone: data.phone, license: String(input).trim() });
      setState(ctx, null);
      await ctx.reply(`✅ <b>Submitted.</b> ${V.esc(ph.name)} is waiting for verification. You'll get a message here when you're live. Then requests from customers nearby will arrive in this chat.`, HTML);
    } catch (e) { await fail(ctx, e); }
  }

  // ───────────── Messages ─────────────
  bot.on("message:location", async (ctx) => {
    const { latitude: lat, longitude: lng } = ctx.message.location;
    const s = state(ctx);
    if (s && "await" in s && s.await === "partner" && s.step === "location") {
      const near = deps.areas.reduce((a, b) => (distanceM({ lat, lng }, a) < distanceM({ lat, lng }, b) ? a : b));
      return partnerStep(ctx, s, { lat, lng, area: near.name });
    }
    mf.users.setLocation(ctx.user.id, { lat, lng, place: "your location" });
    await ctx.reply("📍 Got it.", removeKeyboard);
    if (mf.drafts.get(ctx.user.id).length) await reply(ctx, confirmView(mf.users.get(ctx.user.id)!));
    else await ctx.reply("Now tell me which medicines you need.");
  });

  bot.on(["message:photo", "message:document"], async (ctx) => {
    const doc = ctx.message.document;
    if (doc && !/^image\/(jpeg|png|webp)$/.test(doc.mime_type ?? "")) return ctx.reply("Please send a JPG or PNG photo of the prescription.");
    const fileId = doc?.file_id ?? ctx.message.photo!.at(-1)!.file_id;
    if ((doc?.file_size ?? ctx.message.photo?.at(-1)?.file_size ?? 0) > 8_000_000) return ctx.reply("That file is too large. Under 8 MB, please.");
    await ctx.reply("📷 Reading your prescription… (the photo is discarded after reading)");
    try {
      const { data, mime } = await deps.download(ctx.api, fileId);
      const text = await deps.extract(data, mime);
      if (!text.trim()) return ctx.reply("I couldn't read any medicine names. Try a sharper, flatter photo of a printed prescription, or just type the names.");
      await handleMedicineText(ctx as Ctx, text, "scan");
    } catch (e) {
      console.error("[scan]", e);
      await ctx.reply("Reading that photo failed. Please type the medicine names instead.");
    }
  });

  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return ctx.reply("I don't know that command. /help");
    const s = state(ctx);
    if (s && "await" in s && s.await === "price") {
      const n = Number(text.replace(/[₹,\s]|rs\.?/gi, ""));
      try {
        mf.answers.setPrice(s.rid, ctx.user.id, Number.isFinite(n) ? n : NaN);
        setState(ctx, null);
        return ctx.reply(`💰 Price set: ₹${n}. Now send your answer on the request card.`);
      } catch (e) { return fail(ctx, e); }
    }
    if (s && "await" in s && s.await === "partner") return partnerStep(ctx, s, text);
    if (GREETING.test(text) && text.length < 20) return reply(ctx, V.welcome(ctx.user.name));
    if (text.length > 600) return ctx.reply("That's long. Send up to about 10 medicine names.");
    await handleMedicineText(ctx, text);
  });

  bot.catch((err) => console.error("[bot] unhandled", err.error));
  return bot;
}
