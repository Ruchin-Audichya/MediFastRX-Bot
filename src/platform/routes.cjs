const express = require("express"),
  multer = require("multer");
const { rateLimit } = require("express-rate-limit");
const { createPlatform } = require("./core.cjs");
const { createOcr } = require("./ocr.cjs");
const { location } = require("../pharmacy/service.cjs");
function mountPlatform(app, catalog, options = {}) {
  const p = createPlatform(catalog, options),
    ocr = createOcr(p, catalog, options.ocrOptions),
    router = express.Router();
  const token = (req) =>
    (req.get("cookie") || "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith("mf_session="))
      ?.slice(11);
  const cookie = (res, value) =>
    res.cookie("mf_session", value, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production" && p.mode === "live",
      maxAge: value ? 8 * 3600000 : 0,
      path: "/",
    });
  router.use((req, res, next) => {
    req.user = p.authenticate(token(req));
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.get("X-MediFast") !== "app"
    )
      return res
        .status(403)
        .json({ error: "Use the MediFast application to submit this action." });
    next();
  });
  const auth = (req, res, next) =>
    req.user ? next() : res.status(401).json({ error: "Sign in to continue." });
  const role = (want) => (req, res, next) =>
    req.user?.role === want
      ? next()
      : res.status(403).json({ error: `${want} access required.` });
  const wrap = (fn) => async (req, res, next) => {
    try {
      await fn(req, res);
    } catch (e) {
      next(e);
    }
  };
  const loginLimit = rateLimit({
    windowMs: 900000,
    limit: 40,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again later." },
  });
  router.get("/session", (req, res) =>
    res.json({ user: req.user, mode: p.mode }),
  );
  router.post(
    "/auth/register",
    loginLimit,
    wrap(async (req, res) => {
      const u = await p.register(req.body);
      cookie(res, p.session(u));
      res.json({ user: u });
    }),
  );
  router.post(
    "/auth/login",
    loginLimit,
    wrap(async (req, res) => {
      const u = await p.login(req.body?.email, req.body?.password);
      p.logout(token(req));
      cookie(res, p.session(u));
      res.json({ user: u });
    }),
  );
  router.post("/auth/logout", (req, res) => {
    p.logout(token(req));
    cookie(res, "");
    res.json({ ok: true });
  });
  router.get("/partners", (req, res) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .filter(Boolean);
    res.json({ items: p.discover(ids, location(req.query)), mode: p.mode });
  });
  router.get("/my-pharmacy", auth, role("pharmacy"), (req, res) => {
    const id = p.ownPartner(req.user);
    res.json({
      pharmacy: id ? p.partner(id) : null,
      inventory: id ? p.inventory(id) : [],
    });
  });
  router.post("/my-pharmacy", auth, role("pharmacy"), (req, res) =>
    res.json(p.registerPartner(req.user, req.body)),
  );
  router.put("/my-pharmacy/inventory", auth, role("pharmacy"), (req, res) =>
    res.json({
      items: p.updateStock(req.user, p.ownPartner(req.user), req.body),
    }),
  );
  const imports = new Map();
  router.post(
    "/my-pharmacy/import/preview",
    auth,
    role("pharmacy"),
    (req, res) => {
      const id = p.ownPartner(req.user);
      if (!id) p.fail("Register a pharmacy first.");
      const { readSheet, expiryDate } = require("./csv.cjs"),
        { parseIdentity } = require("../medicine/identity.cjs"),
        sheet = readSheet(req.body?.text),
        map = sheet.mapping;
      if (!map.name || !map.quantity || !map.mrp)
        p.fail(
          "Use Item Name, Closing Stock and MRP headers. Optional: Strength, Form, Unit, Packing and Expiry.",
        );
      const rows = [],
        skipped = [],
        seen = new Set(),
        current = p.inventory(id);
      sheet.rows.forEach((r, i) => {
        const get = (k) =>
          String(r[sheet.headers.indexOf(map[k])] || "").trim();
        const text = [get("name"), get("strength"), get("form")]
            .filter(Boolean)
            .join(" "),
          q = parseIdentity(text),
          match = catalog.resolve(text),
          m = match.status === "confirmed" ? match.candidates[0] : null,
          quantity = Number(get("quantity")),
          price = Number(get("mrp")),
          expiry = expiryDate(get("expiry"));
        let reason = "";
        if (r.length !== sheet.headers.length)
          reason = "Row column count does not match the header.";
        else if (
          !m ||
          !q.strengths.length ||
          !q.forms.length ||
          parseIdentity(m.name).name !== q.name
        )
          reason = "Needs an exact brand, strength and formulation.";
        else if (
          !get("quantity") ||
          !get("mrp") ||
          !Number.isInteger(quantity) ||
          quantity < 0 ||
          quantity > 100000 ||
          !Number.isFinite(price) ||
          price < 0 ||
          price > 100000
        )
          reason = "Invalid quantity or price.";
        else if (
          expiry === false ||
          (expiry && expiry < new Date(p.now()).toISOString().slice(0, 10))
        )
          reason = "Invalid or expired stock.";
        else if (seen.has(m.id))
          reason =
            "Multiple rows for the same product: consolidate available packs before importing.";
        if (reason) {
          skipped.push({ row: i + 2, reason });
          return;
        }
        seen.add(m.id);
        rows.push({
          medicineId: m.id,
          expiry,
          name: [m.name, m.strength, m.form].join(" "),
          quantity,
          price,
          unit:
            [get("unit"), get("pack")]
              .filter(Boolean)
              .join(" · ")
              .slice(0, 100) || "unit not supplied — confirm pack",
          revision:
            current.find((x) => x.medicine_id === m.id)?.revision ?? null,
          identity: JSON.stringify([m.name, m.generic, m.strength, m.form]),
        });
      });
      for (const [key, v] of imports)
        if (p.now() - v.at > 600000) imports.delete(key);
      if (imports.size >= 20) imports.delete(imports.keys().next().value);
      const token = require("node:crypto").randomUUID();
      imports.set(token, {
        userId: req.user.id,
        pharmacyId: id,
        rows,
        at: p.now(),
      });
      res.json({ token, rows, skipped });
    },
  );
  router.post(
    "/my-pharmacy/import/commit",
    auth,
    role("pharmacy"),
    (req, res) => {
      const draft = imports.get(req.body?.token);
      if (!draft || draft.userId !== req.user.id || p.now() - draft.at > 600000)
        p.fail("Preview expired. Preview again.", 409);
      if (!draft.rows.length) p.fail("No exact products to import.");
      const items = p.importStock(req.user, draft.pharmacyId, draft.rows);
      imports.delete(req.body.token);
      res.json({ items });
    },
  );
  router.get("/requests", auth, (req, res) =>
    res.json({ items: p.requests(req.user) }),
  );
  router.post("/requests", auth, (req, res) =>
    res
      .status(201)
      .json(p.createRequest(req.user, req.body, req.get("Idempotency-Key"))),
  );
  router.get("/requests/:id", auth, (req, res) =>
    res.json(p.request(req.user, req.params.id)),
  );
  router.patch("/requests/:id", auth, (req, res) =>
    res.json(p.transition(req.user, req.params.id, req.body)),
  );
  const streams = new Map();
  router.get("/events", auth, (req, res) => {
    const id = req.user.id;
    if ((streams.get(id) || 0) >= 5)
      return res.status(429).json({ error: "Too many open live sessions." });
    streams.set(id, (streams.get(id) || 0) + 1);
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = () =>
      res.write(
        `event: update\ndata: ${JSON.stringify({ at: Date.now() })}\n\n`,
      );
    send();
    p.events.on(id, send);
    p.events.on("inventory", send);
    const timer = setInterval(() => {
      if (!p.authenticate(token(req))) res.end();
      else res.write(": keepalive\n\n");
    }, 15000);
    req.on("close", () => {
      clearInterval(timer);
      p.events.off(id, send);
      p.events.off("inventory", send);
      streams.set(id, Math.max(0, (streams.get(id) || 1) - 1));
    });
  });
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0 },
  });
  router.post(
    "/prescriptions",
    auth,
    role("customer"),
    rateLimit({
      windowMs: 60000,
      limit: 6,
      legacyHeaders: false,
      message: { error: "Please wait before scanning another prescription." },
    }),
    upload.single("file"),
    wrap(async (req, res) => res.json(await ocr.upload(req.user, req.file))),
  );
  router.get("/prescriptions", auth, (req, res) =>
    res.json({
      items: p.db
        .prepare(
          "SELECT id,created_at FROM prescriptions WHERE user_id=? AND created_at>? ORDER BY created_at DESC LIMIT 50",
        )
        .all(req.user.id, p.now() - 7 * 86400000),
    }),
  );
  router.get("/prescriptions/:id/file", auth, (req, res) => {
    const r = ocr.access(req.user, req.params.id);
    res.set({
      "Content-Type": r.mime,
      "Content-Disposition": `inline; filename="prescription.${r.mime === "application/pdf" ? "pdf" : "png"}"`,
      "Cache-Control": "no-store",
    });
    res.sendFile(r.path);
  });
  router.delete(
    "/prescriptions/:id",
    auth,
    wrap(async (req, res) => {
      await ocr.remove(req.user, req.params.id);
      res.json({ ok: true });
    }),
  );
  router.post("/reports", auth, (req, res) => {
    if (!["ocr_error", "catalog"].includes(req.body?.kind))
      p.fail("Choose an OCR or catalog report.");
    p.report(req.user, req.body.kind, req.body.entity, req.body.note);
    res.json({ ok: true });
  });
  router.get("/admin", auth, role("admin"), (req, res) =>
    res.json(p.admin(req.user)),
  );
  router.patch("/admin/partners/:id", auth, role("admin"), (req, res) =>
    res.json(
      p.approve(req.user, req.params.id, req.body.approved, req.body.checked),
    ),
  );
  router.patch("/admin/users/:id", auth, role("admin"), (req, res) => {
    if (req.params.id === req.user.id)
      p.fail("You cannot disable your own admin account.");
    if (typeof req.body.disabled !== "boolean")
      p.fail("Provide disabled true or false.");
    p.db
      .prepare("UPDATE users SET disabled=? WHERE id=?")
      .run(req.body.disabled ? 1 : 0, req.params.id);
    p.db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.params.id);
    p.audit(req.user.id, "account.access_changed", req.params.id);
    res.json({ ok: true });
  });
  router.post("/admin/catalog/:id/review", auth, role("admin"), (req, res) => {
    if (!catalog.get(req.params.id)) p.fail("Medicine not found.", 404);
    p.db
      .prepare("INSERT OR REPLACE INTO catalog_reviews VALUES (?,?,?)")
      .run(req.params.id, req.user.id, p.stamp());
    p.audit(req.user.id, "catalog.source_review", req.params.id);
    res.json({ ok: true });
  });
  router.post("/admin/reports/:id/resolve", auth, role("admin"), (req, res) => {
    p.db
      .prepare("UPDATE review_reports SET resolved=1 WHERE id=?")
      .run(req.params.id);
    p.audit(req.user.id, "report.resolved", req.params.id);
    res.json({ ok: true });
  });
  router.delete(
    "/account",
    auth,
    wrap(async (req, res) => {
      if (req.user.role !== "customer")
        p.fail(
          "Operators must be disabled by an administrator to preserve request responsibility.",
        );
      for (const r of p.requests(req.user))
        if (
          ![
            "completed",
            "cancelled",
            "rejected",
            "expired",
            "unavailable",
          ].includes(r.status)
        )
          p.transition(req.user, r.id, {
            status: "cancelled",
            revision: r.revision,
          });
      for (const r of p.db
        .prepare("SELECT id FROM prescriptions WHERE user_id=?")
        .all(req.user.id))
        await ocr.remove(req.user, r.id);
      p.db
        .prepare(
          "UPDATE users SET name=?,email=?,disabled=1,password=? WHERE id=?",
        )
        .run(
          "Deleted customer",
          `deleted-${req.user.id}@invalid.local`,
          "",
          req.user.id,
        );
      p.db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.id);
      p.audit(req.user.id, "account.deleted", req.user.id);
      cookie(res, "");
      res.json({ ok: true });
    }),
  );
  app.use("/api/platform", router);
  const maintenance = setInterval(() => {
    p.expire();
    ocr.cleanup().catch(() => {});
  }, 30000);
  maintenance.unref();
  return { ...p, ocr, dispose: () => clearInterval(maintenance) };
}
module.exports = { mountPlatform };
