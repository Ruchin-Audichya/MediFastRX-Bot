const test = require("node:test"),
  assert = require("node:assert/strict");
const { createApp } = require("../src/server.cjs");
const { openCatalog } = require("../src/medicine/catalog.cjs");
let server, catalog, base;
test.before(async () => {
  catalog = openCatalog(":memory:");
  const { app } = createApp({
    catalog,
    pharmacies: require("../src/pharmacy/service.cjs").createPharmacyService({
      mode: "demo",
    }),
  });
  server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((r) => server.close(r));
  catalog.close();
});
const post = (body, extra = {}) =>
  fetch(base + "/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extra },
    body: JSON.stringify(body),
  });
test("HTTP complete search -> confirm -> generic -> pharmacies journey", async () => {
  const a = await (await post({ query: "Paracetmol" })).json();
  assert.equal(a.status, "candidates");
  const b = await (
    await post({ query: "", confirmId: a.candidates[0].id, state: a.state })
  ).json();
  assert.equal(b.status, "confirmed");
  const c = await (await post({ query: "generic", state: b.state })).json();
  assert.match(c.answer, /Paracetamol/);
  const p = await (await fetch(base + "/api/pharmacies?area=Jaipur")).json();
  assert.equal(p.items.length, 3);
});
test("bad bodies rejected without crashes or internals", async () => {
  for (const body of [
    null,
    {},
    { query: {} },
    { query: "x".repeat(201) },
    { query: "Dolo", state: [] },
  ])
    assert.equal((await post(body)).status, 400);
});
test("unrelated web origins rejected", async () =>
  assert.equal(
    (await post({ query: "Dolo" }, { Origin: "https://example.org" })).status,
    403,
  ));
test("unknown medicine cannot invoke explanation", async () =>
  assert.equal(
    (
      await fetch(base + "/api/medicines/unidentified/explain", {
        method: "POST",
      })
    ).status,
    404,
  ));
test("operational and abandoned endpoints are absent", async () => {
  for (const p of ["/api/careops/summary", "/api/admin", "/api/inventory"])
    assert.equal((await fetch(base + p)).status, 404);
});
test("API facts are not publicly cached and security headers present", async () => {
  const r = await fetch(base + "/api/status");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  const data = await r.json();
  assert.equal(data.catalog.mode, "demo");
  assert.equal("uptime" in data, false);
});
test("invalid pharmacy location gives useful 400", async () => {
  const r = await fetch(base + "/api/pharmacies?lat=99&lng=75");
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /latitude/);
});
test("retired unauthenticated shop management endpoints are absent", async () => {
  assert.equal((await fetch(base + "/api/shops")).status,404);
  assert.equal((await fetch(base + "/api/platform/my-pharmacy")).status,401);
});
