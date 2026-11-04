import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, PERSONAS } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/http/server.ts";
import { signInitData, verifyInitData } from "../src/http/auth.ts";

async function boot() {
  const app = createApp(loadConfig({ DATABASE_PATH: ":memory:", DEMO_SPEED: "0", TELEGRAM_BOT_TOKEN: "", PUBLIC_URL: "" }), { extract: async () => "" });
  const server = createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (path: string, opts: { as?: string; body?: unknown; method?: string } = {}) => {
    const res = await fetch(base + path, {
      method: opts.method ?? (opts.body ? "POST" : "GET"),
      headers: { "content-type": "application/json", ...(opts.as ? { authorization: `studio ${opts.as}` } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, json: (await res.json().catch(() => null)) as any };
  };
  return { app, call, close: () => { server.close(); app.stop(); } };
}
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 2)); };

test("public overview and matcher work without auth", async () => {
  const t = await boot();
  const o = await t.call("/public/overview");
  assert.equal(o.status, 200);
  assert.ok(o.json.pharmacies.length >= 10 && o.json.pharmacies.every((p: any) => p.demo));
  assert.equal((await t.call("/public/resolve?q=Dolo%20650")).json.product.id, "dolo-650");
  assert.equal((await t.call("/me")).status, 401);
  t.close();
});

test("studio drives the bot over HTTP; board and desk respect who's asking", async () => {
  const t = await boot();
  const studio = (p: string, path: string, body: unknown) => t.call(`/studio/${p}/${path}`, { body });
  const state = async () => (await t.call("/studio/state")).json;
  const pressText = async (p: string, re: RegExp) => {
    const chat = (await state()).personas[p].chat;
    for (const m of [...chat.messages].reverse()) for (const row of m.inline ?? []) for (const b of row)
      if (re.test(b.text)) return studio(p, "press", { messageId: m.id, data: b.callback_data });
    throw new Error(`no ${re}`);
  };
  await studio("customer", "text", { text: "Pan 40, Dolo 650" });
  await pressText("customer", /Add these 2/);
  await pressText("customer", /Ask pharmacies/);
  await pressText("customer", /^Vaishali Nagar$/);
  await pressText("customer", /Send to/);
  await settle();
  const askId = (await state()).asks[0];
  const board = await t.call(`/asks/${askId}`, { as: "customer" });
  assert.equal(board.status, 200);
  assert.ok(board.json.counts.answered >= 1);
  assert.equal((await t.call(`/asks/${askId}`, { as: "pharmacist" })).status, 403, "pharmacists never see competitors' answers");

  const desk = await t.call("/desk", { as: "pharmacist" });
  assert.equal(desk.json.open.length, 1);
  const rid = desk.json.open[0].recipientId;
  assert.equal((await t.call(`/desk/recipients/${rid}/mark`, { as: "customer", body: { index: 0, answer: "have" } })).status, 403);
  assert.equal((await t.call(`/desk/recipients/${rid}/submit`, { as: "pharmacist", body: { all: "have", price: 180 } })).status, 200);
  await settle();
  const r = await t.call(`/asks/${askId}/reserve`, { as: "customer", body: { recipientId: rid } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  await settle();
  const holds = (await t.call("/desk", { as: "pharmacist" })).json.holds;
  assert.equal(holds.length, 1);
  assert.equal((await t.call(`/desk/reservations/${holds[0].id}`, { as: "pharmacist", body: { status: "ready" } })).status, 200);
  assert.equal((await t.call("/admin", { as: "customer" })).status, 403);
  assert.ok((await t.call("/admin", { as: "admin" })).json.metrics.asks >= 1);

  assert.equal((await t.call("/studio/reset", { body: {} })).status, 200);
  assert.equal((await state()).asks.length, 0);
  t.close();
});

test("Mini App initData is verified with the bot token and expires", () => {
  const token = "123456:TEST-token";
  const now = Date.now();
  const data = signInitData({ auth_date: String(Math.floor(now / 1000)), user: JSON.stringify({ id: 42, first_name: "Asha" }), query_id: "q" }, token);
  assert.equal(verifyInitData(data, token, 3600, now)?.id, 42);
  assert.equal(verifyInitData(data, "999:other", 3600, now), null, "wrong bot token");
  assert.equal(verifyInitData(data.replace("Asha", "Eve"), token, 3600, now), null, "tampered");
  assert.equal(verifyInitData(data, token, 3600, now + 2 * 3600_000), null, "expired");
});
