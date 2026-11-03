require("dotenv").config({ quiet: true });
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("node:path");
const { openCatalog } = require("./medicine/catalog.cjs");
const { createMedicineService } = require("./service.cjs");
const { createPharmacyService } = require("./pharmacy/service.cjs");
const { mountPlatform } = require("./platform/routes.cjs");
const { explain } = require("./explain.cjs");
const { telegramConfig } = require("./telegram/config.cjs");
function createApp({
  catalog = openCatalog(),
  pharmacies = createPharmacyService(),
  explainOptions = {},
  platformOptions = {},
  telegramOptions = process.env.TELEGRAM_MODE === "webhook"
    ? telegramConfig()
    : null,
} = {}) {
  const app = express(),
    service = createMedicineService(catalog);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "script-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "connect-src": ["'self'"],
          "upgrade-insecure-requests": null,
        },
      },
    }),
  );
  app.use("/api/platform", express.json({ limit: "350kb" }));
  if (telegramOptions)
    app.use("/api/telegram/webhook", express.json({ limit: "64kb" }));
  app.use(express.json({ limit: "8kb" }));
  app.use(
    "/api",
    rateLimit({
      windowMs: 60000,
      limit: Number(process.env.API_RATE_LIMIT || 120),
      standardHeaders: "draft-8",
      legacyHeaders: false,
      message: { error: "A lot of searches! Please wait a minute." },
    }),
  );
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    const origin = req.get("origin");
    if (origin) {
      try {
        const u = new URL(origin);
        if (
          origin !== process.env.APP_ORIGIN &&
          !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
        )
          return res
            .status(403)
            .json({ error: "Only local app requests are accepted." });
      } catch {
        return res.status(403).json({ error: "Invalid origin." });
      }
    }
    next();
  });
  app.get("/api/status", (req, res) =>
    res.json({
      catalog: catalog.status(),
      pharmacies: pharmacies.mode,
      ai: process.env.GROQ_API_KEY ? "configured" : "off",
    }),
  );
  app.post("/api/message", (req, res) => {
    const b = req.body;
    if (
      !b ||
      typeof b.query !== "string" ||
      b.query.length > 200 ||
      (b.confirmId != null &&
        (typeof b.confirmId !== "string" || b.confirmId.length > 64)) ||
      (b.state != null &&
        (typeof b.state !== "object" || Array.isArray(b.state)))
    )
      return res.status(400).json({
        error:
          "Enter a medicine name or a short follow-up (up to 200 characters).",
      });
    res.json(service.respond(b));
  });
  app.get("/api/medicines/:id", (req, res) => {
    const m = catalog.get(req.params.id);
    res
      .status(m ? 200 : 404)
      .json(m || { error: "This medicine is no longer in the catalog." });
  });
  app.post(
    "/api/medicines/:id/explain",
    rateLimit({
      windowMs: 60000,
      limit: 12,
      legacyHeaders: false,
      message: { error: "Please wait before requesting another explanation." },
    }),
    async (req, res) => {
      const m = catalog.get(req.params.id);
      if (!m)
        return res
          .status(404)
          .json({ error: "Search and confirm a catalog medicine first." });
      const answer = await explain(m, explainOptions);
      platform.report(
        null,
        "ai_selection",
        m.id,
        `${answer.kind}: ${answer.reason || "available"}`,
      );
      res.json(answer);
    },
  );
  app.get("/api/pharmacies", async (req, res) => {
    try {
      const result = await pharmacies.search(req.query);
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.get("/api/places", async (req, res) => {
    try {
      res.json(await pharmacies.places(req.query.q));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  const platform = mountPlatform(app, catalog, platformOptions);
  let telegram = null;
  if (telegramOptions) {
    const { createTelegramBot } = require("./telegram/adapter.cjs");
    const { mountTelegramWebhook } = require("./telegram/webhook.cjs");
    telegram = createTelegramBot({ ...telegramOptions, catalog, pharmacies });
    mountTelegramWebhook(app, telegram.bot, telegramOptions.secret);
  }
  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
  app.get("/", (req, res) =>
    res.json({ app: "MediFast API", frontend: "http://127.0.0.1:3000" }),
  );
  app.use((err, req, res, next) => {
    res
      .status(
        err.code === "LIMIT_FILE_SIZE"
          ? 413
          : err.status || (err instanceof SyntaxError ? 400 : 500),
      )
      .json({
        error:
          err.code === "LIMIT_FILE_SIZE" || err.status === 413
            ? "Request is too large. Upload limit is 5 MB."
            : err instanceof SyntaxError
              ? "Invalid JSON request."
              : err.status && err.status < 500
                ? err.message
                : "Something went wrong. Please try again.",
      });
  });
  return { app, catalog, platform, telegram };
}
if (require.main === module) {
  try {
    const start = performance.now();
    const { app, catalog, platform } = createApp();
    const port = Number(process.env.API_PORT || process.env.PORT || 3101);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw Error("PORT must be between 1 and 65535.");
    const server = app.listen(port, process.env.HOST || "127.0.0.1", () =>
      console.log(
        `MediFast API ready at http://127.0.0.1:${port} · ${catalog.status().mode} catalog · ${(performance.now() - start).toFixed(1)} ms initialization`,
      ),
    );
    server.on("error", (e) => {
      console.error(
        e.code === "EADDRINUSE"
          ? `Port ${port} is in use. Stop the other server or set PORT.`
          : "Could not start the local server.",
      );
      process.exit(1);
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => {
        platform.dispose();
        server.close(() => {
          catalog.close();
          process.exit(0);
        });
        server.closeIdleConnections();
      });
  } catch (e) {
    console.error(
      `MediFast could not start: ${e.message}. Use Node 24 and run npm install.`,
    );
    process.exit(1);
  }
}
module.exports = { createApp };
