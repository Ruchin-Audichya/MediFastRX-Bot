import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { createServer } from "./http/server.ts";

process.removeAllListeners("warning"); // node:sqlite's experimental notice is expected

const config = loadConfig();
const app = createApp(config);
const server = createServer(app).listen(config.port, () => {
  console.log(`MediFast on ${config.baseUrl}`);
  if (config.demo.enabled) console.log(`  Demo Studio: ${config.baseUrl}/studio`);
});

async function startLiveBot() {
  const bot = app.live;
  if (!bot) return console.log("  Telegram: no TELEGRAM_BOT_TOKEN, so live bot is off (Demo Studio still works)");
  await bot.init();
  await bot.api.setMyCommands([
    { command: "start", description: "Start / main menu" },
    { command: "list", description: "My medicine list" },
    { command: "asks", description: "My requests" },
    { command: "meds", description: "My medicines (refills)" },
    { command: "scan", description: "Read a prescription photo" },
    { command: "desk", description: "Pharmacy desk (pharmacists)" },
    { command: "partner", description: "List your pharmacy" },
    { command: "help", description: "How it works" },
    { command: "privacy", description: "What we store" },
  ]);
  const https = config.publicUrl.startsWith("https://");
  if (https) await bot.api.setChatMenuButton({ menu_button: { type: "web_app", text: "MediFast", web_app: { url: `${config.publicUrl}/app` } } });
  const webhook = config.telegram.mode === "webhook" || (config.telegram.mode === "auto" && https && !!config.telegram.webhookSecret);
  if (webhook) {
    await bot.api.setWebhook(`${config.publicUrl}/telegram/webhook`, { secret_token: config.telegram.webhookSecret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
    console.log(`  Telegram: @${bot.botInfo.username} via webhook`);
  } else {
    await bot.api.deleteWebhook();
    bot.start({ allowed_updates: ["message", "callback_query"], onStart: (me) => console.log(`  Telegram: @${me.username} via long polling`) });
  }
}
startLiveBot().catch((e) => console.error("[telegram] failed to start:", e?.description ?? e));

const shutdown = async () => {
  console.log("Shutting down…");
  server.close();
  await app.live?.stop().catch(() => {});
  app.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
