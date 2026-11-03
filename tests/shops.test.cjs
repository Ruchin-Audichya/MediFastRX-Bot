const test = require("node:test"),
  assert = require("node:assert/strict");
const { readSheet, expiryDate } = require("../src/platform/csv.cjs");
const { createApp } = require("../src/server.cjs");
const { openCatalog } = require("../src/medicine/catalog.cjs");
let c,
  p,
  server,
  base,
  cookie,
  clock = Date.parse("2026-10-22T12:00:00Z");
const api = async (route, body) => {
  const r = await fetch(base + route, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-MediFast": "app",
      Cookie: cookie || "",
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json(), headers: r.headers };
};
const sheet =
  "Item Name,Strength,Form,Closing Stock,Unit,Packing,MRP,Batch,Expiry\nDolo,650 mg,tablet,12,strips,15 tablets,30,A,2028-06\nCetirizine,10 mg,tablet,8,strips,10 tablets,25,B,2028-06";
const preview = (text) => api("/my-pharmacy/import/preview", { text });
const commit = (token) => api("/my-pharmacy/import/commit", { token });
test.before(async () => {
  c = openCatalog(":memory:");
  const app = createApp({ catalog: c, platformOptions: { now: () => clock } });
  p = app.platform;
  server = await new Promise((r) => {
    const s = app.app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}/api/platform`;
  const login = await api("/auth/login", {
    email: "pharmacy@medifast.demo",
    password: "DemoPass!2026",
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
});
test.after(async () => {
  p.dispose();
  await new Promise((r) => server.close(r));
  c.close();
});
test("CSV and TSV parse quoted fields, BOM and Marg headings", () => {
  const r = readSheet(
    "\ufeffItem Name\tClosing Stock\tPacking\nDolo\t4\t10 tablets",
  );
  assert.equal(r.mapping.name, "Item Name");
  assert.equal(r.rows.length, 1);
  assert.equal(readSheet('Product,Qty\n"A, B",2').rows[0][0], "A, B");
  assert.throws(() => readSheet("Item,Item\na,b"));
});
test("only exact brand strength and formulation rows link; variants and generic-only rejected", async () => {
  const r = await preview(
    sheet +
      "\nDolo,500 mg,tablet,3,strips,10 tablets,20,C,2028-06\nDolo,,,1,strips,15 tablets,30,D,2028-06\nParacetamol,650 mg,tablet,3,strips,10 tablets,30,E,2028-06",
  );
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.skipped.length, 3);
  assert.equal(r.body.rows[0].medicineId, "dolo650");
});
test("import replaces pack count, commits once and persists exact identity", async () => {
  let r = await preview(sheet);
  assert.equal((await commit(r.body.token)).status, 200);
  assert.equal((await commit(r.body.token)).status, 409);
  r = await preview(sheet.replace("12,strips", "2,strips"));
  assert.equal((await commit(r.body.token)).status, 200);
  assert.equal(
    p.inventory("demo-green").find((x) => x.medicine_id === "dolo650").quantity,
    2,
  );
});
test("duplicates, negative quantities, invalid expiry and unequal columns skipped", async () => {
  const r = await preview(
    sheet +
      "\nDolo,650 mg,tablet,12,strips,15 tablets,30,A,2028-06\nDolo,650 mg,tablet,-1,strips,15 tablets,30,C,2028-06\nDolo,650 mg,tablet,1,strips,15 tablets,30,D,2028-99\nshort,1",
  );
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.skipped.length, 4);
});
test("expired rows skipped, zero stock explicit, calendar expiry validated", async () => {
  assert.equal(expiryDate("02/2028"), "2028-02-29");
  assert.equal(expiryDate("2028-02-30"), false);
  const r = await preview(
    sheet.replace("2028-06", "2020-06").replace("8,strips", "0,strips"),
  );
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.rows[0].quantity, 0);
  assert.equal(r.body.skipped.length, 1);
  assert.equal((await commit(r.body.token)).status, 200);
  assert.equal(
    p.discover(["cet10"], { lat: 26.91, lng: 75.79 })[0].items[0].status,
    "confirmed_out_of_stock",
  );
});
test("expired previews and concurrent inventory updates cannot overwrite stock", async () => {
  let r = await preview(sheet);
  clock += 600001;
  assert.equal((await commit(r.body.token)).status, 409);
  r = await preview(sheet);
  const old = p
    .inventory("demo-green")
    .find((x) => x.medicine_id === "dolo650");
  p.updateStock(p.user("demo-pharmacy"), "demo-green", {
    medicineId: "dolo650",
    quantity: 7,
    price: 30,
    unit: "strip",
    revision: old.revision,
  });
  assert.equal((await commit(r.body.token)).status, 409);
  assert.equal(
    p.inventory("demo-green").find((x) => x.medicine_id === "dolo650").quantity,
    7,
  );
});
test("unsupported headers require explicit template; empty imports never apply", async () => {
  assert.equal((await preview("Medicine label,Count\nDolo,3")).status, 400);
  const r = await preview(
    sheet.replaceAll("650 mg", "500 mg").replaceAll("10 mg", "20 mg"),
  );
  assert.equal(r.body.rows.length, 0);
  assert.equal((await commit(r.body.token)).status, 400);
});
test("pharmacy coordinates must be explicit and suspension hides inventory", () => {
  const op = p.user("demo-pharmacy");
  const profile = {
    name: "Test",
    address: "Jaipur test",
    license: "DEMO",
    pharmacistName: "Test",
    pharmacistReg: "DEMO",
    lat: "",
    lng: 75.79,
  };
  assert.throws(() => p.registerPartner(op, profile), /map details/);
  p.approve(p.user("demo-admin"), "demo-green", false, false);
  assert.equal(p.discover(["dolo650"], { lat: 26.91, lng: 75.79 }).length, 0);
});
