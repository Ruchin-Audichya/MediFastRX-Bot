const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs");
const { openCatalog, validate } = require("../src/medicine/catalog.cjs");
const { createMedicineService } = require("../src/service.cjs");
const { medicines, cases } = require("./fixtures/resolution.json");
const rows = medicines.map((m) => ({
  ...m,
  sources: [
    { label: "Identity-only test fixture", url: "https://example.org" },
  ],
}));
const catalog = openCatalog(":memory:", rows),
  service = createMedicineService(catalog);
test.after(() => catalog.close());
for (const c of cases)
  test(`resolution: ${c.q}`, () => {
    const r = catalog.resolve(c.q);
    assert.equal(r.status, c.status);
    const ids = r.candidates.map((m) => m.id);
    if (c.includes) assert.ok(ids.includes(c.includes));
    else assert.deepEqual(ids.sort(), [...c.ids].sort());
  });
for (const q of [
  "Dolo 650 mcg",
  "Dolo 650 ml",
  "Dolo SR",
  "Augmentin 500",
  "Paracetamol 120 mg/10 ml suspension",
  "Omeprazole 40 capsule",
  "Dolo injection",
  "medicine for fever",
])
  test(`does not weaken identity: ${q}`, () =>
    assert.equal(catalog.resolve(q).status, "not_found"));
test("catalog validates identity/provenance and bounds", () => {
  assert.throws(() => validate([]));
  assert.throws(() => validate([...rows, rows[0]]));
  assert.throws(() => validate([{ ...rows[0], sources: [] }]));
  assert.throws(() =>
    validate([
      { ...rows[0], sources: [{ label: "bad", url: "javascript:alert(1)" }] },
    ]),
  );
});
test("replacement is atomic on validation failure", () => {
  assert.throws(() => catalog.replace([{ id: "bad" }]));
  assert.equal(catalog.get("dolo650").name, "Dolo");
});
test("follow-up sticks to exact ID, switches, then resets", () => {
  const a = service.respond({ query: "Dolo 650" });
  assert.equal(a.state.medicineId, "dolo650");
  const b = service.respond({ query: "side effects", state: a.state });
  assert.equal(b.medicine.id, "dolo650");
  const c = service.respond({ query: "Cetirizine", state: b.state });
  assert.equal(c.medicine.id, "cet10");
  const d = service.respond({ query: "generic", state: c.state });
  assert.match(d.answer, /Cetirizine/);
  assert.doesNotMatch(d.answer, /Paracetamol/);
  const reset = service.respond({ query: "reset", state: d.state });
  assert.equal(reset.state.medicineId, null);
  assert.equal(
    service.respond({ query: "side effects", state: reset.state }).status,
    "needs_medicine",
  );
});
test("explicit follow-up about a new medicine switches before evidence", () => {
  const a = service.respond({ query: "Dolo 650" });
  const b = service.respond({
    query: "side effects of Cetirizine",
    state: a.state,
  });
  assert.equal(b.medicine.id, "cet10");
});
test("failed switch clears context; subsequent follow-up cannot reuse old medicine", () => {
  const a = service.respond({ query: "Dolo 650" });
  const b = service.respond({ query: "zzzzzz", state: a.state });
  assert.equal(b.state.medicineId, null);
  assert.equal(
    service.respond({ query: "side effects", state: b.state }).status,
    "needs_medicine",
  );
});
test("ambiguous follow-up holds intent until user confirms", () => {
  const a = service.respond({ query: "side effects of Omeprazole" });
  assert.equal(a.status, "candidates");
  assert.equal(a.state.medicineId, null);
  const b = service.respond({
    query: "",
    confirmId: "ome-tab",
    state: a.state,
  });
  assert.equal(b.state.intent, "side_effects");
  assert.equal(b.medicine.form, "tablet");
});
test("two users do not share any context", () => {
  const a = service.respond({ query: "Dolo 650" });
  service.respond({ query: "Cetirizine" });
  assert.equal(
    service.respond({ query: "generic", state: a.state }).medicine.id,
    "dolo650",
  );
  assert.equal(service.respond({ query: "generic" }).status, "needs_medicine");
});
for (const q of [
  "Can I take it daily?",
  "Is it safe for me?",
  "How much should I take?",
  "I am pregnant",
  "recommend a substitute",
  "medicine for headache",
])
  test(`personal boundary: ${q}`, () => {
    const r = service.respond({ query: q, state: { medicineId: "dolo650" } });
    assert.equal(r.status, "boundary");
    assert.match(r.answer, /cannot/);
  });
test("unknown confirmed ID never manufactures facts", () => {
  const r = service.respond({ query: "", confirmId: "invented" });
  assert.equal(r.status, "not_found");
  assert.equal(r.medicine, null);
});
test("records missing evidence have an explicit gap", () =>
  assert.match(
    service.respond({ query: "side effects", state: { medicineId: "cet10" } })
      .answer,
    /not supplied/,
  ));
test("save matching after-results for the same focused set", () => {
  const results = cases.map((c) => {
    const r = catalog.resolve(c.q);
    const ids = r.candidates.map((m) => m.id);
    return {
      query: c.q,
      expected: c.status,
      actual: r.status,
      ids,
      pass:
        r.status === c.status &&
        (c.includes
          ? ids.includes(c.includes)
          : JSON.stringify([...ids].sort()) ===
            JSON.stringify([...c.ids].sort())),
    };
  });
  fs.writeFileSync(
    "docs/evidence/matching-after.json",
    JSON.stringify(
      {
        passed: results.filter((x) => x.pass).length,
        total: results.length,
        results,
      },
      null,
      2,
    ) + "\n",
  );
});

test("strength units are never dropped for percentage or microgram queries", () => {
  for (const query of ["Dolo 650%", "Dolo 650 μg", "Dolo 650 µg"])
    assert.equal(catalog.resolve(query).status, "not_found");
  const { parseIdentity } = require("../src/medicine/identity.cjs");
  assert.deepEqual(parseIdentity("Example 25 µg tablet").strengths, ["25mcg"]);
});

for (const query of [
  "What does it do?",
  "What is it used for?",
  "What's the generic?",
  "What’s the generic?",
  "Any side effects?",
])
  test(`natural contextual follow-up: ${query}`, () => {
    const response = service.respond({
      query,
      state: { medicineId: "dolo650" },
    });
    assert.equal(response.status, "confirmed");
    assert.equal(response.medicine.id, "dolo650");
  });
test("combination punctuation remains an exact ingredient identity", () => {
  const result = catalog.resolve("Amoxicillin+Clavulanic acid");
  assert.equal(result.status, "confirmed");
  assert.equal(result.candidates[0].id, "augmentin625");
});
