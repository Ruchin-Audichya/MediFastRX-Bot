const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const Inventory = require("./models/Inventory");
const Pharmacy = require("./models/Pharmacy");
const { searchMedicine } = require("./services/searchService");
const { createCareOpsRouter } = require("./careops/dashboard/router");
const { createWhatsAppRouter } = require("./integrations/whatsapp/router");
const logger = require("./utils/logger");

const createServer = (bot) => {
  const app = express();

  // ── Security Middleware ───────────────────────────────────────────────────
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  // API Rate Limiter
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." },
  });
  app.use("/api", apiLimiter);

  // ── Health Check ──────────────────────────────────────────────────────────
  app.get("/", (req, res) => {
    res.json({
      status: "ok",
      service: "Jaipur Pharmacy Bot",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/health", async (req, res) => {
    try {
      const pharmacyCount = await Pharmacy.countDocuments({ isActive: true });
      const medicineCount = await Inventory.countDocuments({ inStock: true });
      res.json({
        status: "healthy",
        db: "connected",
        pharmacies: pharmacyCount,
        medicinesInStock: medicineCount,
        uptime: process.uptime(),
      });
    } catch {
      res.status(503).json({ status: "degraded", db: "disconnected" });
    }
  });

  // ── Telegram Webhook Endpoint ──────────────────────────────────────────────
  // grammy handles the webhook — mount it at /webhook
  if (process.env.NODE_ENV === "production" && process.env.WEBHOOK_DOMAIN) {
    app.use(bot.webhook("/webhook"));
    logger.info("Bot running in WEBHOOK mode");
  }

  // ── Public Search API (Optional — for a web frontend) ─────────────────────
  app.get("/api/search", async (req, res) => {
    const query = req.query.q?.trim();

    if (!query || query.length < 2) {
      return res.status(400).json({ error: "Query must be at least 2 characters." });
    }

    try {
      const data = await searchMedicine(query);
      res.json(data);
    } catch (error) {
      logger.error(`API search error: ${error.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── List Pharmacies API ───────────────────────────────────────────────────
  app.get("/api/pharmacies", async (req, res) => {
    try {
      const { area } = req.query;
      const filter = { isActive: true };
      if (area) filter.area = { $regex: area, $options: "i" };

      const pharmacies = await Pharmacy.find(filter)
        .select("-__v -createdAt -updatedAt")
        .lean();

      res.json({ count: pharmacies.length, data: pharmacies });
    } catch (error) {
      logger.error(`API pharmacies error: ${error.message}`);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // ── CareOps Dashboard + API ────────────────────────────────────────────────
  // Judge-facing operations board at GET /careops and JSON at /api/careops/*.
  app.use(createCareOpsRouter());

  // ── WhatsApp Cloud API webhook ──────────────────────────────────────────────
  // GET  /webhook/whatsapp → Meta verification handshake
  // POST /webhook/whatsapp → inbound messages (reuses the medicine pipeline)
  app.use(createWhatsAppRouter());

  // ── 404 ───────────────────────────────────────────────────────────────────
  app.use((req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return app;
};

module.exports = { createServer };
