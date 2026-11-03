const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os");
const { createApp } = require("../src/server.cjs"),
  { openCatalog } = require("../src/medicine/catalog.cjs");
let server, base, catalog, platform, dir;
test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "medifast-uploads-"));
  catalog = openCatalog(":memory:");
  const made = createApp({
    catalog,
    platformOptions: {
      ocrOptions: {
        directory: dir,
        recognize: async () => ({
          data: { text: "Dolo 650 mg tablet", confidence: 88 },
        }),
      },
    },
  });
  platform = made.platform;
  server = await new Promise((r) => {
    const s = made.app.listen(0, "127.0.0.1", () => r(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  platform.dispose();
  await new Promise((r) => server.close(r));
  catalog.close();
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  fs.rmdirSync(dir);
});
const api = (route, method = "GET", body, cookie, extra = {}) =>
  fetch(base + "/api/platform" + route, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-MediFast": "app",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
async function login(role) {
  const r = await api("/auth/login", "POST", {
    email: `${role}@medifast.demo`,
    password: "DemoPass!2026",
  });
  assert.equal(r.status, 200);
  const raw = r.headers.get("set-cookie");
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  return raw.split(";")[0];
}
test("roles enforced on backend; missing action header and unrelated origins denied", async () => {
  assert.equal((await api("/requests")).status, 401);
  const cookie = await login("customer");
  assert.equal((await api("/admin", "GET", null, cookie)).status, 403);
  assert.equal((await api("/my-pharmacy", "GET", null, cookie)).status, 403);
  assert.equal(
    (
      await fetch(base + "/api/platform/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await api("/requests", "GET", null, cookie, {
        Origin: "https://evil.test",
      })
    ).status,
    403,
  );
});
test("secure upload validates bytes, denies other customers/admin and deletes access", async () => {
  const customer = await login("customer"),
    admin = await login("admin");
  const bad = new FormData();
  bad.append(
    "file",
    new Blob(["not an image"], { type: "image/png" }),
    "fake.png",
  );
  let r = await fetch(base + "/api/platform/prescriptions", {
    method: "POST",
    headers: { Cookie: customer, "X-MediFast": "app" },
    body: bad,
  });
  assert.equal(r.status, 400);
  const form = new FormData();
  form.append(
    "file",
    new Blob([fs.readFileSync("public/demo-prescription.png")], {
      type: "image/png",
    }),
    "sample.png",
  );
  r = await fetch(base + "/api/platform/prescriptions", {
    method: "POST",
    headers: { Cookie: customer, "X-MediFast": "app" },
    body: form,
  });
  assert.equal(r.status, 200);
  const rx = await r.json();
  assert.equal(rx.candidates[0].candidates[0].id, "dolo650");
  assert.equal(
    (await api(`/prescriptions/${rx.id}/file`, "GET", null, admin)).status,
    404,
  );
  const other = await api("/auth/register", "POST", {
    name: "Other customer",
    email: "other@http.test",
    password: "LongPassword123!",
    role: "customer",
  });
  const otherCookie = other.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (await api(`/prescriptions/${rx.id}/file`, "GET", null, otherCookie))
      .status,
    404,
  );
  const ownerFile = await api(
    `/prescriptions/${rx.id}/file`,
    "GET",
    null,
    customer,
  );
  assert.equal(ownerFile.status, 200);
  assert.equal(ownerFile.headers.get("cache-control"), "no-store");
  const pharmacy = await login("pharmacy");
  assert.equal(
    (await api(`/prescriptions/${rx.id}/file`, "GET", null, pharmacy)).status,
    404,
  );
  const request = await api(
    "/requests",
    "POST",
    {
      pharmacyId: "demo-green",
      items: [{ medicineId: "dolo650", quantity: 1 }],
      prescriptionId: rx.id,
    },
    customer,
    { "Idempotency-Key": "http-private-rx" },
  );
  assert.equal(request.status, 201);
  assert.equal(
    (await api(`/prescriptions/${rx.id}/file`, "GET", null, pharmacy)).status,
    200,
  );
  assert.equal(
    (await api(`/prescriptions/${rx.id}`, "DELETE", null, customer)).status,
    200,
  );
  assert.equal(
    (await api(`/prescriptions/${rx.id}/file`, "GET", null, pharmacy)).status,
    404,
  );
});
test("import preview tokens belong to the operator and commit validates revisions atomically", async () => {
  const op = await login("pharmacy"),
    customer = await login("customer");
  const text =
    "Item Name,Strength,Form,Closing Stock,Unit,MRP\nDolo,650 mg,tablet,8,strips,30";
  const preview = await (
    await api("/my-pharmacy/import/preview", "POST", { text }, op)
  ).json();
  assert.equal(preview.rows.length, 1);
  assert.equal(
    (
      await api(
        "/my-pharmacy/import/commit",
        "POST",
        { token: preview.token },
        customer,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await api(
        "/my-pharmacy/import/commit",
        "POST",
        { token: preview.token },
        op,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(
        "/my-pharmacy/import/commit",
        "POST",
        { token: preview.token },
        op,
      )
    ).status,
    409,
  );
});
