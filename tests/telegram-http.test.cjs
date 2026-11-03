const test = require("node:test"),
  assert = require("node:assert/strict");
const { createApp } = require("../src/server.cjs"),
  { openCatalog } = require("../src/medicine/catalog.cjs"),
  { createPharmacyService } = require("../src/pharmacy/service.cjs");
const secret = "fixture-webhook-secret-32-characters-long";
let server,
  base,
  made,
  calls = [];
test.before(async () => {
  made = createApp({
    catalog: openCatalog(":memory:"),
    pharmacies: createPharmacyService({ mode: "demo" }),
    telegramOptions: {
      token: "123456:offline-test-token-never-used",
      secret,
      botInfo: {
        id: 123456,
        is_bot: true,
        first_name: "MediFast",
        username: "MediFastFixtureBot",
      },
      logger: { warn() {} },
    },
  });
  made.telegram.bot.api.config.use(async (_, method, payload) => {
    calls.push({ method, ...payload });
    return {
      ok: true,
      result:
        method === "sendMessage"
          ? {
              message_id: calls.length,
              date: 1,
              chat: { id: 10, type: "private" },
              text: payload.text,
            }
          : true,
    };
  });
  server = await new Promise((r) => {
    const s = made.app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  made.platform.dispose();
  await new Promise((r) => server.close(r));
  made.catalog.close();
});
const post = (body, provided = secret) =>
  fetch(base + "/api/telegram/webhook", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": provided,
    },
    body: JSON.stringify(body),
  });
test("webhook rejects forged secret and malformed updates without processing", async () => {
  assert.equal((await post({ update_id: 1 }, "forged")).status, 401);
  assert.equal((await post({ message: { text: "Dolo 650" } })).status, 400);
  assert.equal(calls.length, 0);
});
test("grammY Express webhook processes exact lookup, acknowledges and deduplicates retry", async () => {
  const update = {
    update_id: 4,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: 10, type: "private" },
      from: { id: 10, is_bot: false, first_name: "Fixture" },
      text: "Dolo 650",
    },
  };
  assert.equal((await post(update)).status, 200);
  assert.match(calls[0].text, /Dolo · 650 mg/);
  assert.equal((await post(update)).status, 200);
  assert.equal(calls.length, 1);
});
test("webhook bounds JSON input; ordinary catalog endpoint stays functional", async () => {
  assert.equal(
    (await post({ update_id: 5, padding: "x".repeat(70000) })).status,
    413,
  );
  const r = await fetch(base + "/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "Mujhe Dolo 650 chahiye" }),
  });
  assert.equal((await r.json()).medicine.id, "dolo650");
});
