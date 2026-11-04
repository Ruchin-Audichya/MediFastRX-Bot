import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createApp, PERSONAS } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createServer } from "../src/http/server.ts";
import type { Fetcher } from "../src/net/http.ts";

// A fake internet: Nominatim and Overpass answers we control. Counts calls to prove caching.
function fakeNet(overrides: { nominatim?: unknown; overpass?: unknown; fail?: RegExp } = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (url) => {
    calls.push(url);
    if (overrides.fail?.test(url)) throw new Error("network down");
    if (url.includes("nominatim")) return new Response(JSON.stringify(overrides.nominatim ?? []), { status: 200 });
    if (url.includes("overpass")) return new Response(JSON.stringify(overrides.overpass ?? { elements: [] }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  return { fetcher, calls };
}
const boot = (env: Record<string, string> = {}, net = fakeNet()) =>
  ({ app: createApp(loadConfig({ DATABASE_PATH: ":memory:", DEMO_SPEED: "0", TELEGRAM_BOT_TOKEN: "", PUBLIC_URL: "", STUDIO_PASSWORD: "", EXTERNAL_LOOKUPS: "true", ...env }), { extract: async () => "", fetcher: net.fetcher }), net });

const OVERPASS = { elements: [
  { type: "node", id: 2, lat: 26.9130, lon: 75.7430, tags: { amenity: "pharmacy", name: "Far Chemist", phone: "+91 141 000 0000" } },
  { type: "way", id: 3, center: { lat: 26.9117, lon: 75.7426 }, tags: { amenity: "pharmacy", name: "Near Medicals", opening_hours: "Mo-Su 09:00-22:00", "addr:street": "Gandhi Path" } },
  { type: "node", id: 4, lat: 26.9200, lon: 75.7500, tags: { amenity: "pharmacy" } },
] };

test("pincodes: invalid input, demo seed, geocoder fallback with caching, and outages", async () => {
  const { app, net } = boot({}, fakeNet({ nominatim: [{ lat: "28.6328", lon: "77.2197", display_name: "Connaught Place, New Delhi", address: { suburb: "Connaught Place", state: "Delhi" } }] }));
  assert.deepEqual(await app.pincodes.lookup("12345"), { ok: false, reason: "invalid" });
  const demo = await app.pincodes.lookup("302021");
  assert.ok(demo.ok && demo.place.place === "Vaishali Nagar");
  const cp = await app.pincodes.lookup("110001");
  assert.ok(cp.ok && cp.place.place === "Connaught Place" && cp.place.source.includes("Nominatim"));
  await app.pincodes.lookup("110001");
  assert.equal(net.calls.filter((c) => c.includes("110001")).length, 1, "second lookup comes from the database");
  app.stop();

  const down = boot({}, fakeNet({ fail: /nominatim/ }));
  assert.deepEqual(await down.app.pincodes.lookup("560001"), { ok: false, reason: "unavailable" });
  down.app.stop();
  const off = boot({ EXTERNAL_LOOKUPS: "false" });
  assert.deepEqual(await off.app.pincodes.lookup("560001"), { ok: false, reason: "not-found" });
  off.app.stop();
});

test("find walks through medicine confirmation, location, then results", async () => {
  const { app } = boot({}, fakeNet({ overpass: OVERPASS }));
  assert.equal((await app.finder({})).stage, "need-medicine");
  assert.equal((await app.finder({ q: "qwzxv" })).stage, "not-found");
  const choose = await app.finder({ q: "thyronorm", pin: "302021" });
  assert.equal(choose.stage, "choose", "strength is never guessed, even with a pincode");
  assert.equal((await app.finder({ q: "Dolo 650" })).stage, "need-location");
  const bad = await app.finder({ q: "Dolo 650", pin: "99999" });
  assert.ok(bad.stage === "need-location" && bad.error === "invalid");

  const r = await app.finder({ productId: "thyronorm-50", pin: "302021" });
  assert.equal(r.stage, "results");
  if (r.stage !== "results") return;
  const by = Object.fromEntries(r.providers.map((p) => [p.id, p]));
  assert.ok(by.network.status === "ok" && by.network.verification === "pharmacist-confirms" && by.network.data.partners >= 5);
  assert.ok(by.directory.status === "ok" && by.directory.verification === "location-only");
  assert.deepEqual(by.directory.data.places.map((p: any) => p.name), ["Near Medicals", "Far Chemist", "Pharmacy (name not listed)"], "sorted by distance; unnamed shops labelled");
  assert.equal(by.directory.data.places[0].hours, "Mo-Su 09:00-22:00");
  assert.ok(by.online.status === "ok" && by.online.verification === "not-checked");
  const links = by.online.data.links;
  assert.deepEqual(links.map((l: any) => l.id), ["1mg", "pharmeasy", "apollo", "netmeds", "blinkit"], "Blinkit is the last fallback");
  assert.match(links[0].note, /Upload your prescription/);
  assert.equal(links[4].url, "https://blinkit.com/s/?q=Thyronorm%2050");
  app.stop();
});

test("a failing source never breaks the page, and restricted medicines get no broadcast or online links", async () => {
  const { app } = boot({}, fakeNet({ fail: /overpass/ }));
  const r = await app.finder({ productId: "dolo-650", pin: "302021" });
  assert.ok(r.stage === "results");
  if (r.stage !== "results") return;
  const by = Object.fromEntries(r.providers.map((p) => [p.id, p]));
  assert.equal(by.directory.status, "unavailable");
  assert.equal(by.network.status, "ok");
  assert.equal(by.online.status, "ok");
  const alp = await app.finder({ productId: "gen-alprazolam-025", pin: "302021" });
  assert.ok(alp.stage === "results" && alp.providers.find((p) => p.id === "network")!.status === "skipped" && alp.providers.find((p) => p.id === "online")!.status === "skipped");
  app.stop();
});

test("areas without partner pharmacies say so; affiliate parameters are applied and flagged", async () => {
  const { app } = boot({ AFFILIATE_1MG: "utm_source=medifast" }, fakeNet({ nominatim: [{ lat: "12.9716", lon: "77.5946", display_name: "Bengaluru", address: { city: "Bengaluru", state: "Karnataka" } }] }));
  const r = await app.finder({ productId: "dolo-650", pin: "560001" });
  assert.ok(r.stage === "results");
  if (r.stage !== "results") return;
  const net = r.providers.find((p) => p.id === "network")!;
  assert.ok(net.status === "empty" && /No participating pharmacy/.test(net.message));
  const online = r.providers.find((p) => p.id === "online")! as any;
  assert.equal(online.data.links[0].url, "https://www.1mg.com/search/all?name=Dolo%20650&utm_source=medifast");
  assert.equal(online.data.links[0].affiliate, true);
  assert.equal(online.data.links[1].affiliate, false);
  app.stop();
});

test("website visitors can ask pharmacies without Telegram, and only they can see their request", async () => {
  const { app } = boot();
  const server = createServer(app).listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const call = async (path: string, init: { body?: unknown; token?: string } = {}) => {
    const res = await fetch(base + path, { method: init.body ? "POST" : "GET", headers: { "content-type": "application/json", ...(init.token ? { authorization: `web ${init.token}` } : {}) }, body: init.body ? JSON.stringify(init.body) : undefined });
    return { status: res.status, json: (await res.json()) as any };
  };
  const find = await call("/find?q=Pan%2040&pin=302021");
  assert.equal(find.json.stage, "results");
  assert.equal((await call("/web/asks", { body: { items: [{ productId: "pan-40" }], pin: "302021" } })).status, 401, "needs a session");
  const { json: { token } } = await call("/web/session", { body: {} });
  assert.match(token, /^[a-f0-9]{48}$/);
  const ask = await call("/web/asks", { body: { items: [{ productId: "pan-40", qty: 2 }], pin: "302021", radiusKm: 2 }, token });
  assert.equal(ask.status, 200, JSON.stringify(ask.json));
  const board = await call(`/asks/${ask.json.askId}`, { token });
  assert.equal(board.status, 200);
  assert.equal(board.json.ask.place, "Vaishali Nagar (302021)");
  assert.ok(board.json.counts.asked >= 5);
  const other = (await call("/web/session", { body: {} })).json.token;
  assert.equal((await call(`/asks/${ask.json.askId}`, { token: other })).status, 403);
  assert.equal((await call("/web/asks", { body: { items: [{ productId: "pan-40" }], pin: "12" }, token })).json.error.code, "bad-pincode");
  server.close();
  app.stop();
});

test("Telegram users can type a pincode instead of sharing their location", async () => {
  const { app } = boot();
  const s = app.studio!;
  const C = PERSONAS.customer;
  await s.input.text(C, "Dolo 650");
  const card = s.fake.snapshot(C.id).messages.at(-1)!;
  await s.input.press(C, card.id, card.inline!.flat().find((b) => /Add to list/.test(b.text))!.callback_data!);
  await s.input.text(C, "302021");
  const msgs = s.fake.snapshot(C.id).messages;
  assert.match(msgs.at(-2)!.text, /Looking around <b>Vaishali Nagar<\/b>, 302021/);
  assert.match(msgs.at(-1)!.text, /Ready to ask[\s\S]*Vaishali Nagar \(302021\)/);
  app.stop();
});
