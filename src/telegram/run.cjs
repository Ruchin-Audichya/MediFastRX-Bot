require("dotenv").config({ quiet: true });
const { openCatalog } = require("../medicine/catalog.cjs");
const { createPharmacyService } = require("../pharmacy/service.cjs");
const { createTelegramBot, commands } = require("./adapter.cjs");
const { telegramConfig, TelegramConfigError } = require("./config.cjs");
async function main() {
  const config = telegramConfig();
  if (config.mode !== "polling")
    throw new TelegramConfigError(
      "Webhook mode runs inside the API. Use npm run dev or npm start, then configure the webhook separately.",
    );
  const catalog = openCatalog();
  const { bot } = createTelegramBot({
    ...config,
    catalog,
    pharmacies: createPharmacyService(),
  });
  let stopped = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      stopped = true;
      if (bot.isRunning()) bot.stop();
    });
  try {
    await bot.init();
    if (process.argv.includes("--check")) {
      console.log(
        `Telegram connection verified: @${bot.botInfo.username}. No test messages sent.`,
      );
      return;
    }
    if (stopped) return;
    await bot.api.setMyCommands(commands);
    console.log(
      `MediFast Telegram starting · ${catalog.status().mode} catalog · ${process.env.GROQ_API_KEY ? "optional AI configured" : "catalog fallback ready"}`,
    );
    await bot.start({
      allowed_updates: ["message", "callback_query"],
      onStart: (info) =>
        console.log(
          `Telegram ready: @${info.username} · private chats · long polling`,
        ),
    });
  } finally {
    catalog.close();
  }
}
if (require.main === module)
  main().catch((e) => {
    // Transport errors can contain the bot-token URL. Never print the raw error.
    console.error(
      e instanceof TelegramConfigError
        ? e.message
        : "Telegram could not start. Check TELEGRAM_BOT_TOKEN, internet access, TELEGRAM_MODE and whether another polling process is running. Run npm run bot:check to verify connectivity. See docs/TELEGRAM.md.",
    );
    process.exitCode = 1;
  });
module.exports = { main };
