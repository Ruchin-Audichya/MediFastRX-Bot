require("dotenv").config();
const connectDB = require("../config/database");
const { createBot } = require("./bot");
const { createServer } = require("./server");
const logger = require("./utils/logger");
const { rebuildMedicineKnowledgeIndex } = require("./medicine/medicineNormalizer");

const PORT = parseInt(process.env.PORT || "3001", 10);
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;

const start = async () => {
  // 1. Connect to MongoDB
  await connectDB();

  // 2. Pre-warm the medicine knowledge index so the first user query does
  // not pay the cold-start cost (was responsible for ~30s on the very first
  // medicine lookup after boot).
  //
  // IMPORTANT: cap the pre-warm to a sensible subset — loading the entire
  // 250k+ catalog into a single in-memory Fuse index hits Node's default
  // 4GB heap and crashes. The Mongo `$text` candidate search and the direct
  // exact-match path already cover the long tail; the warm index is a fast
  // path for typo / fuzzy lookups on the most-used medicines.
  const PREWARM_LIMIT = Number(process.env.MEDICINE_KNOWLEDGE_PREWARM_LIMIT || 5000);
  const MedicineKnowledge = require("./models/MedicineKnowledge");
  MedicineKnowledge.find()
    .sort({ confidence: -1, updatedAt: -1 })
    .limit(PREWARM_LIMIT)
    .lean()
    .then((records) => rebuildMedicineKnowledgeIndex(records))
    .then(({ count, rebuiltAt }) => {
      logger.info(
        `Medicine knowledge index pre-warmed: ${count} records (built at ${rebuiltAt?.toISOString?.() || rebuiltAt})`
      );
    })
    .catch((error) => {
      logger.warn(`Medicine knowledge index pre-warm skipped: ${error.message}`);
    });

  // 3. Create the Telegram bot
  const bot = createBot();

  // Renumber the remaining steps (was 2-6, now 4-8).
  // 4. Create the Express server
  const app = createServer(bot);

  // 5. Start the server
  app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
  });

  // 6. Start the bot in the right mode
  if (IS_PRODUCTION && WEBHOOK_DOMAIN) {
    // Webhook mode — Telegram pushes updates to our server
    const webhookUrl = `${WEBHOOK_DOMAIN}/webhook`;
    await bot.api.setWebhook(webhookUrl);
    logger.info(`Webhook set to: ${webhookUrl}`);
  } else {
    // Long-polling mode — bot pulls updates (great for local dev)
    bot.start({
      onStart: (botInfo) => {
        logger.info(`Bot @${botInfo.username} is running in POLLING mode`);
      },
    });
  }

  // 6. Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    await bot.stop();
    process.exit(0);
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
};

start().catch((error) => {
  logger.error(`Failed to start application: ${error.message}`);
  process.exit(1);
});
