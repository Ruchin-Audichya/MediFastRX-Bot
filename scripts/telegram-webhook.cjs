require("dotenv").config({ quiet: true });
const { Bot } = require("grammy");
const { telegramConfig } = require("../src/telegram/config.cjs");
async function main() {
  const config = telegramConfig();
  if (config.mode !== "webhook")
    throw Error("Set TELEGRAM_MODE=webhook before managing a webhook.");
  const bot = new Bot(config.token, { client: { timeoutSeconds: 12 } });
  if (process.argv.includes("--delete")) {
    await bot.api.deleteWebhook({ drop_pending_updates: false });
    console.log(
      "Webhook removed; pending updates preserved. Set TELEGRAM_MODE=polling to run locally.",
    );
    return;
  }
  if (!process.argv.includes("--set"))
    throw Error(
      "Use npm run bot:webhook -- --set or --delete. No remote changes made.",
    );
  const u = new URL(process.env.TELEGRAM_WEBHOOK_URL || "");
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/api/telegram/webhook" ||
    /^(localhost|127\.|\[::1\])/.test(u.hostname)
  )
    throw Error(
      "Use a public HTTPS TELEGRAM_WEBHOOK_URL ending in /api/telegram/webhook.",
    );
  await bot.api.setMyCommands(require("../src/telegram/adapter.cjs").commands);
  await bot.api.setWebhook(u.href, {
    secret_token: config.secret,
    allowed_updates: ["message", "callback_query"],
    max_connections: 1,
    drop_pending_updates: false,
  });
  console.log(
    "Telegram webhook registered. Pending updates preserved. Verify the API is reachable through HTTPS.",
  );
}
main().catch(() => {
  console.error(
    "Webhook was not configured. Check docs/TELEGRAM.md, token, mode, public HTTPS URL, secret and connectivity. Credential-bearing errors are omitted.",
  );
  process.exitCode = 1;
});
