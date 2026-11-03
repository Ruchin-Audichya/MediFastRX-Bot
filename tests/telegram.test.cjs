const test = require("node:test"),
  assert = require("node:assert/strict");
const { openCatalog } = require("../src/medicine/catalog.cjs");
const { createPharmacyService } = require("../src/pharmacy/service.cjs");
const { createMedicineService } = require("../src/service.cjs");
const {
  createTelegramBot,
  createSessionStore,
  appLink,
} = require("../src/telegram/adapter.cjs");
const { telegramConfig } = require("../src/telegram/config.cjs");
const TOKEN = "123456:offline-test-token-not-a-real-token";
function harness(options = {}) {
  const catalog = openCatalog(":memory:");
  const calls = [],
    { bot, store } = createTelegramBot({
      token: TOKEN,
      botInfo: {
        id: 123456,
        is_bot: true,
        first_name: "MediFast",
        username: "MediFastFixtureBot",
      },
      catalog,
      pharmacies: createPharmacyService({ mode: "demo" }),
      explainOptions: { key: "" },
      webUrl: "https://medifast.example/",
      logger: { warn() {} },
      ...options,
    });
  bot.api.config.use(async (_, method, payload) => {
    calls.push({ method, ...payload });
    return {
      ok: true,
      result:
        method === "sendMessage"
          ? {
              message_id: calls.length,
              date: 1,
              chat: { id: payload.chat_id, type: "private" },
              text: payload.text,
            }
          : true,
    };
  });
  let id = 1;
  const message = (text, user = 7, extra = {}) => {
    const match = text.match(/^\/\w+/);
    return {
      update_id: id++,
      message: {
        message_id: id,
        date: 1,
        chat: { id: user, type: "private" },
        from: { id: user, is_bot: false, first_name: "Test" },
        text,
        ...(match
          ? {
              entities: [
                { type: "bot_command", offset: 0, length: match[0].length },
              ],
            }
          : {}),
        ...extra,
      },
    };
  };
  const callback = (data, user = 7) => ({
    update_id: id++,
    callback_query: {
      id: String(id),
      from: { id: user, is_bot: false, first_name: "Test" },
      chat_instance: "fixture",
      data,
      message: {
        message_id: 1,
        date: 1,
        chat: { id: user, type: "private" },
        text: "Previous",
      },
    },
  });
  const text = () =>
    calls
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.text)
      .join("\n");
  const buttons = () =>
    calls
      .filter((c) => c.method === "sendMessage")
      .at(-1)
      ?.reply_markup?.inline_keyboard?.flat() || [];
  return {
    bot,
    store,
    catalog,
    calls,
    message,
    callback,
    text,
    buttons,
    close: () => catalog.close(),
  };
}
async function withBot(fn, options) {
  const h = harness(options);
  try {
    await fn(h);
  } finally {
    h.close();
  }
}
test("Telegram welcome, exact Hinglish match, follow-up context and switching", () =>
  withBot(async (h) => {
    await h.bot.handleUpdate(h.message("/start"));
    assert.match(h.text(), /small sourced demo catalog/);
    await h.bot.handleUpdate(h.message("Mujhe Dolo 650 chahiye"));
    assert.match(h.text(), /Dolo · 650 mg · tablet/);
    await h.bot.handleUpdate(h.message("iska generic"));
    assert.match(h.calls.at(-1).text, /Paracetamol/);
    await h.bot.handleUpdate(h.message("Cetirizine"));
    assert.equal(h.store.get("7").state.medicineId, "cet10");
    await h.bot.handleUpdate(h.message("side effects"));
    assert.match(h.calls.at(-1).text, /Cetirizine/);
    assert.doesNotMatch(h.calls.at(-1).text, /About Dolo/);
  }));
test("Telegram typo candidate must be explicitly chosen; obsolete buttons cannot switch medicine", () =>
  withBot(async (h) => {
    await h.bot.handleUpdate(h.message("Paracetmol"));
    assert.match(h.text(), /possible match/);
    const old = h.buttons()[0].callback_data;
    assert.equal(h.store.get("7").state.medicineId, null);
    await h.bot.handleUpdate(h.callback(old));
    assert.ok(h.store.get("7").state.medicineId);
    await h.bot.handleUpdate(h.message("Dolo 650"));
    await h.bot.handleUpdate(h.callback(old));
    assert.match(h.calls.at(-1).text, /older search/);
    assert.equal(h.store.get("7").state.medicineId, "dolo650");
  }));
test("Telegram wrong strength and unknown query never publish a guessed profile", () =>
  withBot(async (h) => {
    await h.bot.handleUpdate(h.message("Dolo 500"));
    assert.match(h.calls.at(-1).text, /No match/);
    assert.equal(h.store.get("7").state.medicineId, null);
    await h.bot.handleUpdate(h.message("xqzzasbf"));
    assert.match(h.calls.at(-1).text, /won’t guess/);
    await h.bot.handleUpdate(h.message("/ai"));
    assert.match(h.calls.at(-1).text, /confirm a medicine first/);
  }));
test("Telegram isolation: another user's buttons cannot choose a private candidate", () =>
  withBot(async (h) => {
    await h.bot.handleUpdate(h.message("Paracetmol", 7));
    const pick = h.buttons()[0].callback_data;
    await h.bot.handleUpdate(h.callback(pick, 8));
    assert.match(h.calls.at(-1).text, /older search/);
    assert.equal(h.store.get("8").state.medicineId, null);
    await h.bot.handleUpdate(h.message("/reset", 7));
    assert.equal(h.store.size(), 1);
    await h.bot.handleUpdate(h.message("generic", 7));
    assert.match(h.calls.at(-1).text, /Search for a medicine first/);
  }));
test("Telegram private-only guard and personal suitability boundary", () =>
  withBot(async (h) => {
    await h.bot.handleUpdate(
      h.message("/search Dolo 650", 9, { chat: { id: -1, type: "group" } }),
    );
    assert.match(h.calls.at(-1).text, /privately/);
    assert.equal(h.store.size(), 0);
    await h.bot.handleUpdate(h.message("Can I take Dolo 650 while pregnant?"));
    assert.match(h.calls.at(-1).text, /cannot decide/);
  }));
test("Telegram AI unavailable and timed-out AI retain catalog evidence", () =>
  withBot(
    async (h) => {
      await h.bot.handleUpdate(h.message("Dolo 650"));
      await h.bot.handleUpdate(h.message("/ai"));
      assert.match(h.calls.at(-1).text, /Catalog explanation/);
      assert.doesNotMatch(h.calls.at(-1).text, /invented treatment/);
    },
    {
      explainOptions: {
        key: "fixture",
        timeout: 10,
        fetchImpl: async () => new Promise(() => {}),
      },
    },
  ));
test("Telegram AI-selected explanation labels supplied evidence", () =>
  withBot(
    async (h) => {
      await h.bot.handleUpdate(h.message("Dolo 650"));
      await h.bot.handleUpdate(h.message("/ai"));
      assert.match(h.calls.at(-1).text, /AI-selected catalog evidence/);
      assert.doesNotMatch(h.calls.at(-1).text, /invented treatment/);
    },
    {
      explainOptions: {
        key: "fixture",
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    indices: [0],
                    text: "invented treatment",
                  }),
                },
              },
            ],
          }),
        }),
      },
    },
  ));
test("Telegram manual nearby shows sample labels with no invented phone or stock", () =>
  withBot(async (h) => {
    await h.bot.handleUpdate(h.message("/nearby Jaipur"));
    assert.match(h.text(), /DEMO — fictional/);
    assert.match(h.text(), /Stock unknown/);
    assert.match(h.text(), /not provided for sample stores/);
    assert.ok(
      h.calls.every(
        (c) =>
          !c.reply_markup?.inline_keyboard
            ?.flat()
            .some((b) => b.url?.startsWith("tel:")),
      ),
    );
  }));
test("Telegram real listing has phone source and directions; raw HTML is escaped", () =>
  withBot(
    async (h) => {
      await h.bot.handleUpdate(h.message("/nearby Jaipur"));
      assert.match(h.text(), /\+91 141 1234567/);
      assert.match(h.text(), /&lt;shop&gt;/);
      assert.doesNotMatch(h.text(), /<shop>/);
      const listing = h.calls.find((c) => c.text?.includes("&lt;shop&gt;"));
      assert.ok(
        listing.reply_markup.inline_keyboard
          .flat()
          .some((b) => b.text === "Phone number source"),
      );
      assert.match(listing.text, /Stock unknown/);
    },
    {
      pharmacies: {
        search: async () => ({
          mode: "live",
          notice: "Fixture listing, not a real live check",
          items: [
            {
              id: "f",
              name: "<shop>",
              lat: 26,
              lng: 75,
              distanceKm: 1,
              address: "Fixture",
              phone: "+91 141 1234567",
              source: "OSM fixture",
              sourceUrl: "https://www.openstreetmap.org/node/1",
              contactSourceUrl: "https://example.com/phone",
            },
          ],
        }),
      },
    },
  ));
test("Telegram one-time location requires nearby intent and is not retained", () =>
  withBot(async (h) => {
    const loc = () =>
      h.message("", 7, {
        text: undefined,
        location: { latitude: 26.91, longitude: 75.79 },
      });
    await h.bot.handleUpdate(loc());
    assert.match(h.calls.at(-1).text, /haven’t sent these coordinates/);
    await h.bot.handleUpdate(h.message("/nearby"));
    assert.equal(
      h.calls.at(-1).reply_markup.keyboard[0][0].request_location,
      true,
    );
    await h.bot.handleUpdate(loc());
    assert.match(h.text(), /fictional/);
    assert.equal(h.store.get("7").awaitingArea, false);
    assert.doesNotMatch(JSON.stringify(h.store.get("7")), /26\.91/);
  }));
test("Telegram area candidates require a choice and provider outages are recoverable", () =>
  withBot(
    async (h) => {
      await h.bot.handleUpdate(h.message("/nearby New Town"));
      assert.match(h.calls.at(-1).text, /Which place/);
      const button = h.buttons()[0].callback_data;
      await h.bot.handleUpdate(h.callback(button));
      assert.match(h.calls.at(-1).text, /didn’t respond/);
    },
    {
      pharmacies: {
        places: async () => ({
          items: [
            { lat: 10, lng: 20, label: "New Town A" },
            { lat: 30, lng: 40, label: "New Town B" },
          ],
        }),
        search: async () => {
          throw Error("network");
        },
      },
    },
  ));
test("Telegram duplicated deliveries are idempotent and concurrent medicine switches are ordered", () =>
  withBot(async (h) => {
    const update = h.message("Dolo 650");
    await Promise.all([h.bot.handleUpdate(update), h.bot.handleUpdate(update)]);
    assert.equal(h.calls.filter((c) => c.method === "sendMessage").length, 1);
    await Promise.all([
      h.bot.handleUpdate(h.message("Cetirizine")),
      h.bot.handleUpdate(h.message("generic")),
    ]);
    assert.match(h.calls.at(-1).text, /Cetirizine/);
  }));
test("Telegram abuse limit and unsupported messages have meaningful recovery", () =>
  withBot(async (h) => {
    for (let i = 0; i < 31; i++)
      await h.bot.handleUpdate(h.message("Dolo 650"));
    assert.match(h.calls.at(-1).text, /wait a minute/);
    await h.bot.handleUpdate(
      h.message("", 8, {
        text: undefined,
        photo: [
          {
            file_id: "fixture",
            file_unique_id: "fixture",
            width: 100,
            height: 100,
          },
        ],
      }),
    );
    assert.match(h.calls.at(-1).text, /scanner/);
  }));
test("Telegram state expires, bounded memory evicts older visitors; app links preserve identity", () => {
  let time = 0;
  const s = createSessionStore({ now: () => time, ttl: 10, max: 2 });
  s.get("1");
  s.get("2");
  s.get("3");
  assert.equal(s.size(), 2);
  time = 11;
  assert.equal(s.get("2").state.medicineId, null);
  assert.equal(s.size(), 1);
  assert.equal(appLink("javascript:alert(1)"), null);
  assert.equal(
    appLink("https://medifast.example/", "dolo650", "partners"),
    "https://medifast.example/?medicine=dolo650&screen=partners",
  );
  assert.throws(() => telegramConfig({}), /TELEGRAM_BOT_TOKEN/);
  assert.throws(
    () =>
      telegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_MODE: "webhook" }),
    /SECRET/,
  );
});
test("Shared conversational parser preserves explicit identity and recognizes natural follow-ups", () => {
  const c = openCatalog(":memory:"),
    s = createMedicineService(c),
    state = { medicineId: "dolo650" };
  try {
    for (const q of ["can you explain Dolo 650", "Dolo 650 kya hai"])
      assert.equal(s.respond({ query: q }).medicine?.id, "dolo650", q);
    for (const q of [
      "Dolo 650 ke side effects",
      "what are side effects of Dolo 650",
      "iske side effects",
    ])
      assert.equal(
        s.respond({ query: q, state }).state.intent,
        "side_effects",
        q,
      );
    assert.equal(
      s.respond({ query: "where can I find Dolo 650?" }).state.intent,
      "pharmacies",
    );
    assert.equal(
      s.respond({ query: "can I take this?", state }).status,
      "boundary",
    );
    assert.equal(
      s.respond({ query: "can you explain Dolo 500" }).status,
      "not_found",
    );
  } finally {
    c.close();
  }
});
