// Offline terminal mirror of the real Telegram middleware; no network or token.
const { createInterface } = require("node:readline/promises");
const { openCatalog } = require("../src/medicine/catalog.cjs");
const { createPharmacyService } = require("../src/pharmacy/service.cjs");
const { createTelegramBot } = require("../src/telegram/adapter.cjs");
async function main() {
  const catalog = openCatalog(":memory:"),
    { bot } = createTelegramBot({
      token: "123456:offline-demo-token-never-used",
      botInfo: {
        id: 123456,
        is_bot: true,
        first_name: "MediFast",
        username: "MediFastOfflineDemoBot",
      },
      catalog,
      pharmacies: createPharmacyService({ mode: "demo" }),
      explainOptions: { key: "" },
      webUrl: "",
    });
  let updateId = 1,
    messageId = 1,
    buttons = [];
  bot.api.config.use(async (_, method, payload) => {
    if (method === "sendMessage") {
      console.log(
        "\nMediFast: " +
          payload.text
            .replace(/<[^>]*>/g, "")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">"),
      );
      buttons = (payload.reply_markup?.inline_keyboard || [])
        .flat()
        .filter((b) => b.callback_data);
      if (buttons.length)
        console.log(buttons.map((b, i) => `#${i + 1} ${b.text}`).join(" · "));
      return {
        ok: true,
        result: {
          message_id: messageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 1, type: "private" },
          text: payload.text,
        },
      };
    }
    return { ok: true, result: true };
  });
  const from = { id: 1, is_bot: false, first_name: "Offline visitor" },
    chat = { id: 1, type: "private" };
  async function input(text) {
    if (/^#\d+$/.test(text)) {
      const b = buttons[Number(text.slice(1)) - 1];
      if (!b) {
        console.log("Choose one of the current numbered buttons.");
        return;
      }
      return bot.handleUpdate({
        update_id: updateId++,
        callback_query: {
          id: String(messageId++),
          from,
          chat_instance: "demo",
          data: b.callback_data,
          message: { message_id: messageId++, date: 1, chat, text: "Demo" },
        },
      });
    }
    const entity = text.match(/^\/\w+/);
    return bot.handleUpdate({
      update_id: updateId++,
      message: {
        message_id: messageId++,
        date: 1,
        chat,
        from,
        text,
        ...(entity
          ? {
              entities: [
                { type: "bot_command", offset: 0, length: entity[0].length },
              ],
            }
          : {}),
      },
    });
  }
  console.log(
    "OFFLINE TELEGRAM SIMULATION · real middleware, included demo catalog, fictional pharmacies. No Telegram connection or live AI.",
  );
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await input("/start");
    if (process.argv.includes("--smoke")) {
      for (const q of [
        "Mujhe Dolo 650 chahiye",
        "side effects",
        "/ai",
        "/nearby Jaipur",
        "/reset",
      ])
        await input(q);
      return;
    }
    while (true) {
      const q = (await rl.question("\nYou (or /quit): ")).trim();
      if (q === "/quit") break;
      if (q) await input(q);
    }
  } finally {
    rl.close();
    catalog.close();
  }
}
main().catch(() => {
  console.error("Demo stopped. Use Node 24 and npm ci.");
  process.exitCode = 1;
});
