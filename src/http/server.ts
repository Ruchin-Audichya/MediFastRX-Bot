import express, { type Request, type Response, type NextFunction } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { webhookCallback } from "grammy";
import { DomainError, ANSWERS, type Answer, type User } from "../domain/medifast.ts";
import { AREAS, DEMO_PHARMACIES } from "../domain/seed.ts";
import { label } from "../catalog/catalog.ts";
import { PERSONAS, type App, type PersonaKey } from "../app.ts";
import { verifyInitData } from "./auth.ts";

type Req = Request & { user?: User };
const WEB_DIST = fileURLToPath(new URL("../../web/dist", import.meta.url));
const SAMPLE_RX = fileURLToPath(new URL("../../data/demo-prescription.png", import.meta.url));

export function createServer(app: App) {
  const { mf, config } = app;
  const http = express();
  http.disable("x-powered-by");
  http.set("trust proxy", 1);
  http.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "https://telegram.org"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "blob:", "https://*.basemaps.cartocdn.com", "https://*.tile.openstreetmap.org"],
          connectSrc: ["'self'"],
          frameAncestors: ["'self'", "https://web.telegram.org", "https://*.telegram.org"],
        },
      },
      frameguard: false, // Mini Apps render inside Telegram's web client
      crossOriginEmbedderPolicy: false,
    }),
  );

  // ── Telegram webhook (live bot, webhook mode)
  if (app.live && config.telegram.webhookSecret)
    http.post("/telegram/webhook", express.json({ limit: "1mb" }), webhookCallback(app.live, "express", { secretToken: config.telegram.webhookSecret }));

  http.get("/healthz", (_req, res) => res.json({ ok: true, demo: config.demo.enabled, live: !!app.live }));

  const api = express.Router();
  api.use(express.json({ limit: "64kb" }));
  api.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: "draft-8", legacyHeaders: false }));

  // ── Identity: Telegram Mini App initData, or a demo persona in demo mode.
  api.use((req: Req, _res, next) => {
    const auth = String(req.headers.authorization ?? "");
    if (auth.startsWith("tma ") && config.telegram.token) {
      const tg = verifyInitData(auth.slice(4), config.telegram.token);
      if (tg) req.user = mf.users.upsert({ ref: `live:${tg.id}`, transport: "live", chatId: String(tg.id), name: [tg.first_name, tg.last_name].filter(Boolean).join(" "), username: tg.username });
    } else if (auth.startsWith("studio ") && config.demo.enabled) {
      const p = PERSONAS[auth.slice(7) as PersonaKey];
      if (p) req.user = mf.users.byRef(p.ref);
    }
    next();
  });
  const need = (req: Req) => req.user ?? fail(401, "auth", "Open this page from Telegram.");
  const fail = (status: number, code: string, message: string): never => { throw Object.assign(new DomainError(code, message), { status }); };
  const wrap = (fn: (req: Req, res: Response) => unknown) => (req: Req, res: Response, next: NextFunction) => {
    try {
      const out = fn(req, res);
      if (out instanceof Promise) out.then((v) => v !== undefined && !res.headersSent && res.json(v), next);
      else if (out !== undefined && !res.headersSent) res.json(out);
    } catch (e) { next(e); }
  };

  // ── Public
  api.get("/public/overview", wrap(() => ({
    demo: config.demo.enabled,
    bot: { live: !!app.live, username: app.live?.botInfo?.username ?? null },
    catalogSize: mf.catalog.size,
    areas: AREAS,
    pharmacies: mf.pharmacies.list("approved").map((p) => ({ name: p.name, area: p.area, lat: p.lat, lng: p.lng, demo: !!p.demo })),
    metrics: mf.history.metrics(),
  })));
  api.get("/public/resolve", wrap((req) => {
    const r = mf.catalog.resolve(String(req.query.q ?? "").slice(0, 80));
    const view = (p: any) => ({ id: p.id, label: label(p), composition: p.composition, schedule: p.schedule });
    return r.kind === "exact" ? { kind: r.kind, product: view(r.product) } : r.kind === "choose" ? { kind: r.kind, reason: r.reason, options: r.options.map(view) } : r;
  }));

  // ── Me
  api.get("/me", wrap((req) => {
    const u = need(req);
    const ph = mf.pharmacies.byOwner(u.id);
    return { user: { id: u.id, name: u.name, admin: !!u.is_admin, transport: u.transport }, pharmacy: ph ? { id: ph.id, name: ph.name, status: ph.status, accepting: !!ph.accepting, demo: !!ph.demo } : null };
  }));

  // ── Customer
  const ownAsk = (req: Req) => {
    const u = need(req);
    const ask = mf.asks.get(String(req.params.id)) ?? fail(404, "not-found", "Request not found.");
    if (ask.customer_id !== u.id && !u.is_admin) fail(403, "forbidden", "That isn't your request.");
    return { u, ask };
  };
  api.get("/asks/:id", wrap((req) => {
    const { ask } = ownAsk(req);
    const b = mf.asks.board(ask.id);
    return { ...b, now: mf.now(), reservations: b.reservations.map((r) => ({ ...r, customer_ref: undefined, pharmacy_ref: undefined })) };
  }));
  api.post("/asks/:id/reserve", wrap((req) => {
    const { u, ask } = ownAsk(req);
    const plan = req.body?.split ? mf.asks.board(ask.id).split?.parts ?? fail(400, "no-split", "That split is no longer available.") : mf.asks.planFor(ask.id, Number(req.body?.recipientId));
    return { reservations: mf.asks.reserve(ask.id, u.id, plan).map((r) => r.id) };
  }));
  api.post("/asks/:id/cancel", wrap((req) => { const { u, ask } = ownAsk(req); mf.asks.cancel(ask.id, u.id); return { ok: true }; }));
  api.post("/reservations/:id/cancel", wrap((req) => { mf.reservations.update(String(req.params.id), need(req).id, "cancelled"); return { ok: true }; }));
  api.get("/my", wrap((req) => {
    const u = need(req);
    return {
      asks: mf.history.asksOf(u.id, 10).map((a) => {
        const b = mf.asks.board(a.id);
        return { id: a.id, status: a.status, place: a.place, created_at: a.created_at, items: a.items.map((i) => i.label), answered: b.counts.answered, asked: b.counts.asked };
      }),
      saved: mf.saved.list(u.id).map((s) => ({ id: s.product.id, label: label(s.product), qty: s.qty })),
    };
  }));

  // ── Pharmacy desk
  const myPharmacy = (req: Req) => {
    const u = need(req);
    return { u, ph: mf.pharmacies.byOwner(u.id) ?? fail(403, "not-pharmacist", "This account has no pharmacy. Send /partner to the bot.") };
  };
  api.get("/desk", wrap((req) => {
    const { ph } = myPharmacy(req);
    const inbox = mf.history.inbox(ph.id);
    return {
      pharmacy: { ...ph, sim: undefined },
      stats: mf.pharmacies.stats(ph.id),
      now: mf.now(),
      open: inbox.open.map(({ recipient: r, ask }) => ({
        recipientId: r.id, state: r.state, distanceM: r.distance_m, draft: r.draft, answers: r.answers, price: r.price, notifiedAt: r.notified_at,
        ask: { id: ask.id, place: ask.place, items: ask.items, expiresAt: ask.expires_at },
      })),
      holds: inbox.holds.map(({ reservation: h, ask }) => ({
        id: h.id, code: h.code, status: h.status, holdUntil: h.hold_until, createdAt: h.created_at,
        customer: mf.users.get(h.customer_id)!.name.split(" ")[0],
        items: h.items.map((i) => ({ ...ask.items[i.index], when: i.when })),
      })),
      recent: inbox.recent.map((h) => ({ id: h.id, code: h.code, status: h.status, updatedAt: h.updated_at })),
    };
  }));
  const rid = (req: Req) => Number(req.params.id);
  api.post("/desk/recipients/:id/mark", wrap((req) => {
    const answer = String(req.body?.answer) as Answer;
    if (!ANSWERS.includes(answer)) fail(400, "bad-answer", "Unknown answer.");
    mf.answers.mark(rid(req), need(req).id, Number(req.body?.index), answer);
    return { ok: true };
  }));
  api.post("/desk/recipients/:id/submit", wrap((req) => {
    const b = req.body ?? {};
    const opt = (v: unknown) => (ANSWERS.includes(v as Answer) ? (v as Answer) : undefined);
    mf.answers.submit(rid(req), need(req).id, { all: opt(b.all), fill: opt(b.fill), price: b.price === undefined ? undefined : b.price === null ? null : Number(b.price) });
    return { ok: true };
  }));
  api.post("/desk/recipients/:id/edit", wrap((req) => { mf.answers.edit(rid(req), need(req).id); return { ok: true }; }));
  api.post("/desk/recipients/:id/price", wrap((req) => { mf.answers.setPrice(rid(req), need(req).id, req.body?.price == null ? null : Number(req.body.price)); return { ok: true }; }));
  api.post("/desk/reservations/:id", wrap((req) => {
    const to = String(req.body?.status);
    if (!["ready", "collected", "declined"].includes(to)) fail(400, "bad-status", "Unknown status.");
    mf.reservations.update(String(req.params.id), need(req).id, to as "ready");
    return { ok: true };
  }));
  api.post("/desk/accepting", wrap((req) => ({ accepting: !!mf.pharmacies.setAccepting(need(req).id, !!req.body?.on).accepting })));

  // ── Admin
  const admin = (req: Req) => { const u = need(req); if (!u.is_admin) fail(403, "forbidden", "Admins only."); return u; };
  api.get("/admin", wrap((req) => {
    admin(req);
    return { metrics: mf.history.metrics(), pharmacies: mf.pharmacies.list().map((p) => ({ ...p, sim: undefined, stats: mf.pharmacies.stats(p.id) })) };
  }));
  api.post("/admin/pharmacies/:id", wrap((req) => {
    const d = String(req.body?.decision);
    if (!["approved", "rejected", "suspended"].includes(d)) fail(400, "bad-decision", "Unknown decision.");
    return mf.pharmacies.review(Number(req.params.id), admin(req).id, d as "approved");
  }));

  // ── Live updates (SSE). Events carry ids only; clients refetch what they're allowed to see.
  api.get("/events", (req: Req, res) => {
    const u = req.user;
    if (!u) return res.status(401).end();
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 2000\n\n");
    const ph = mf.pharmacies.byOwner(u.id);
    const send = (type: string, data: object) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    const mineAsk = (askId: string) => {
      const a = mf.asks.get(askId);
      return a && (a.customer_id === u.id || u.is_admin || (ph && mf.asks.recipients(askId).some((r) => r.pharmacy_id === ph.id)));
    };
    const offs: (() => void)[] = [];
    const sub = (k: any, fn: (e: any) => void) => { mf.on(k, fn); offs.push(() => mf.off(k, fn)); };
    for (const k of ["ask.created", "ask.updated", "ask.closed"]) sub(k, (e) => mineAsk(e.askId) && send("ask", e));
    sub("recipient.changed", (e) => { const r = mf.answers.get(e.recipientId); r && mineAsk(r.ask_id) && send("ask", { askId: r.ask_id }); });
    sub("reservation.changed", (e) => { const r = mf.reservations.get(e.reservationId); r && (r.customer_id === u.id || r.pharmacy_id === ph?.id || u.is_admin) && send("reservation", e); });
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => { clearInterval(ping); offs.forEach((f) => f()); });
  });

  // ── Demo Studio: drives the real bot over the in-process transport.
  if (app.studio) {
    const studio = app.studio;
    const studioLimit = rateLimit({ windowMs: 60_000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false });
    const persona = (req: Req) => PERSONAS[String(req.params.persona) as PersonaKey] ?? fail(404, "persona", "Unknown persona.");
    const keyOf = (chatId: number) => (Object.keys(PERSONAS) as PersonaKey[]).find((k) => PERSONAS[k].id === chatId);
    api.get("/studio/state", wrap(() => ({
      personas: Object.fromEntries((Object.keys(PERSONAS) as PersonaKey[]).map((k) => [k, { name: PERSONAS[k].first_name, chat: studio.fake.snapshot(PERSONAS[k].id) }])),
      bot: { username: "MediFastDemoBot" },
      pharmacies: mf.pharmacies.list("approved").map((p) => ({ id: p.id, name: p.name, area: p.area, lat: p.lat, lng: p.lng, demo: !!p.demo, studio: DEMO_PHARMACIES.find((d) => d.name === p.name)?.studio ?? false })),
      areas: AREAS,
      asks: mf.history.asksOf(mf.users.byRef(PERSONAS.customer.ref)!.id, 3).map((a) => a.id),
    })));
    const act = (fn: (req: Req) => Promise<unknown>) => wrap(async (req) => { await fn(req); return { ok: true }; });
    api.post("/studio/:persona/text", studioLimit, act((req) => studio.input.text(persona(req), String(req.body?.text ?? "").slice(0, 600))));
    api.post("/studio/:persona/press", studioLimit, act((req) => studio.input.press(persona(req), Number(req.body?.messageId), String(req.body?.data ?? "").slice(0, 64))));
    api.post("/studio/:persona/location", studioLimit, act((req) => studio.input.location(persona(req), Number(req.body?.lat), Number(req.body?.lng))));
    api.post("/studio/:persona/sample-photo", studioLimit, act((req) => studio.input.photo(persona(req), readFileSync(SAMPLE_RX), "image/png")));
    api.post("/studio/:persona/photo", studioLimit, express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "8mb" }), act((req) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length) fail(400, "no-image", "Send a JPG or PNG.");
      return studio.input.photo(persona(req), req.body, String(req.headers["content-type"]));
    }));
    api.get("/studio/stream", (req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
      res.write("retry: 1500\n\n");
      const onChange = (chatId: number) => {
        const k = keyOf(chatId);
        if (k) res.write(`event: chat\ndata: ${JSON.stringify({ persona: k, chat: studio.fake.snapshot(chatId) })}\n\n`);
      };
      const onAsk = (e: { askId: string }) => res.write(`event: ask\ndata: ${JSON.stringify(e)}\n\n`);
      studio.fake.events.on("change", onChange);
      mf.on("ask.updated", onAsk); mf.on("ask.created", onAsk); mf.on("ask.closed", onAsk);
      const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
      req.on("close", () => {
        clearInterval(ping);
        studio.fake.events.off("change", onChange);
        mf.off("ask.updated", onAsk); mf.off("ask.created", onAsk); mf.off("ask.closed", onAsk);
      });
    });
    api.post("/studio/reset", studioLimit, wrap(() => { app.resetStudio(); return { ok: true }; }));
  }
  api.get("/sample-prescription.png", (_req, res) => res.sendFile(SAMPLE_RX));

  api.use((_req, res) => res.status(404).json({ error: { code: "not-found", message: "No such endpoint." } }));
  api.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DomainError) {
      const status = (err as any).status ?? (err.code === "forbidden" ? 403 : err.code === "not-found" ? 404 : 400);
      return res.status(status).json({ error: { code: err.code, message: err.message } });
    }
    if (err?.type === "entity.parse.failed") return res.status(400).json({ error: { code: "bad-json", message: "Malformed JSON." } });
    console.error("[http]", err);
    res.status(500).json({ error: { code: "internal", message: "Something went wrong." } });
  });
  http.use("/api", api);

  // ── Web app (built by Vite). SPA fallback for client routes.
  if (existsSync(WEB_DIST)) {
    http.use(express.static(WEB_DIST, { index: false, maxAge: "1h", setHeaders: (res, path) => /\/assets\//.test(path) && res.setHeader("cache-control", "public, max-age=31536000, immutable") }));
    http.get(/^\/(?!api|telegram).*/, (_req, res) => res.sendFile(`${WEB_DIST}/index.html`));
  }
  return http;
}
