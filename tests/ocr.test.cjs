const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path");
const sharp = require("sharp");
const { openCatalog } = require("../src/medicine/catalog.cjs"),
  { createPlatform } = require("../src/platform/core.cjs"),
  { createOcr } = require("../src/platform/ocr.cjs");
async function setup(
  recognize = async () => ({ data: { text: "", confidence: 0 } }),
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "medifast-ocr-test-"));
  const c = openCatalog(":memory:");
  let now = Date.now();
  const p = createPlatform(c, { now: () => now });
  const u = await p.register({
    name: "Private tester",
    email: "ocr@test.example",
    password: "PrivatePassword123!",
    role: "customer",
  });
  const ocr = createOcr(p, c, { directory: dir, recognize });
  const file = { buffer: await fs.readFile("public/demo-prescription.png") };
  return {
    dir,
    c,
    p,
    u,
    ocr,
    file,
    advance: (n) => (now += n),
    close: async () => {
      c.close();
      for (const f of await fs.readdir(dir)) await fs.unlink(path.join(dir, f));
      await fs.rmdir(dir);
    },
  };
}
test("unreadable OCR stays editable with no fabricated medicine candidates", async () => {
  const s = await setup();
  try {
    const r = await s.ocr.upload(s.u, s.file);
    assert.equal(r.unreadable, true);
    assert.equal(r.text, "");
    assert.deepEqual(r.candidates, []);
  } finally {
    await s.close();
  }
});
test("upload bytes reject SVG, corrupt images and pixel bombs", async () => {
  const s = await setup();
  try {
    await assert.rejects(
      s.ocr.upload(s.u, {
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
        ),
      }),
      /SVG/,
    );
    await assert.rejects(
      s.ocr.upload(s.u, { buffer: Buffer.from("invalid") }),
      /readable image/,
    );
    const big = await sharp({
      create: { width: 4100, height: 4100, channels: 3, background: "white" },
    })
      .png()
      .toBuffer();
    await assert.rejects(s.ocr.upload(s.u, { buffer: big }), /readable image/);
  } finally {
    await s.close();
  }
});
test("uploads expire, stored files disappear and owner cannot recover deleted data", async () => {
  const s = await setup();
  try {
    const r = await s.ocr.upload(s.u, s.file);
    const file = s.ocr.access(s.u, r.id).path;
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    s.advance(7 * 86400000 + 1);
    assert.throws(() => s.ocr.access(s.u, r.id), /expired/);
    await s.ocr.cleanup();
    assert.equal(
      s.p.db.prepare("SELECT count(*) n FROM prescriptions").get().n,
      0,
    );
    await assert.rejects(fs.stat(file), { code: "ENOENT" });
  } finally {
    await s.close();
  }
});
test("shared demo rejects personal documents and per-user upload limit is bounded", async () => {
  const s = await setup();
  try {
    await assert.rejects(
      s.ocr.upload(s.p.user("demo-customer"), {
        buffer: Buffer.from("private document"),
      }),
      /shared demo/,
    );
    const stmt = s.p.db.prepare(
      "INSERT INTO prescriptions VALUES (?,?,?,?,?,?)",
    );
    for (let i = 0; i < 50; i++)
      stmt.run("limit-" + i, s.u.id, "unused", "image/png", "", Date.now());
    await assert.rejects(s.ocr.upload(s.u, s.file), /50-document limit/);
  } finally {
    await s.close();
  }
});
test("only one OCR job runs at a time and failure releases the processor", async () => {
  let release;
  const s = await setup(() => new Promise((r) => (release = r)));
  try {
    const active = s.ocr.upload(s.u, s.file);
    while (!release) await new Promise((r) => setTimeout(r, 5));
    await assert.rejects(s.ocr.upload(s.u, s.file), /Another scan/);
    release({ data: { text: "Dolo 650 mg tablet", confidence: 90 } });
    const result = await active;
    assert.equal(result.candidates[0].candidates[0].id, "dolo650");
  } finally {
    await s.close();
  }
});
