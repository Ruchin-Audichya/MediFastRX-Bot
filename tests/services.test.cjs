const test = require("node:test"),
  assert = require("node:assert/strict");
const { explain } = require("../src/explain.cjs");
const {
  createPharmacyService,
  location,
  distanceKm,
} = require("../src/pharmacy/service.cjs");
const med = require("../data/demo-medicines.json")[0];
test("AI absent returns only supplied evidence", async () => {
  const r = await explain(med, { key: "" });
  assert.equal(r.kind, "catalog");
  assert.equal(r.text, med.simple);
});
test("AI cannot add an invented explanation", async () => {
  const r = await explain(med, {
    key: "fake-test-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({
                indices: [400],
                text: "Take anything",
              }),
            },
          },
        ],
      }),
    }),
  });
  assert.equal(r.text, med.simple);
  assert.equal(r.reason, "unavailable");
});
test("AI selects evidence, never publishes model prose", async () => {
  const r = await explain(med, {
    key: "fake-test-key",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: JSON.stringify({ indices: [0], text: "invented" }),
            },
          },
        ],
      }),
    }),
  });
  assert.equal(r.kind, "ai_selection");
  assert.equal(r.text, med.simple);
});
test("slow AI including stuck response body is bounded and aborted", async () => {
  let signal;
  const start = performance.now();
  const r = await explain(med, {
    key: "fake-test-key",
    timeout: 25,
    fetchImpl: async (u, o) => {
      signal = o.signal;
      return { ok: true, json: () => new Promise(() => {}) };
    },
  });
  assert.equal(r.reason, "unavailable");
  assert.ok(performance.now() - start < 400);
  assert.ok(signal.aborted);
});
test("pharmacy demo has no callable fictional numbers or inventory claims", async () => {
  const r = await createPharmacyService({ mode: "demo" }).search({
    area: "Jaipur",
  });
  assert.equal(r.mode, "demo");
  assert.equal(r.items.length, 3);
  assert.ok(
    r.items.every((x) => !x.phone && x.demo && x.stock === "Call to confirm"),
  );
});
test("manual Jaipur areas and coordinate validation", () => {
  assert.equal(location({ area: "Mansarovar, Jaipur" }).lat, 26.854);
  assert.throws(() => location({ area: "made up" }));
  for (const lat of ["nope", "", 91])
    assert.throws(() => location({ lat, lng: 75 }));
  assert.equal(distanceKm({ lat: 26, lng: 75 }, { lat: 26, lng: 75 }), 0);
});
test("live pharmacy failure stays live; never quietly inserts samples", async () => {
  const r = await createPharmacyService({
    mode: "live",
    snapshots: [],
    fetchImpl: async () => {
      throw Error("network");
    },
  }).search({ area: "Jaipur" });
  assert.equal(r.mode, "live");
  assert.equal(r.unavailable, true);
  assert.deepEqual(r.items, []);
});
test("pharmacy timeout covers stalled JSON body", async () => {
  let signal;
  const r = await createPharmacyService({
    mode: "live",
    snapshots: [],
    timeout: 25,
    fetchImpl: async (u, o) => {
      signal = o.signal;
      return { ok: true, json: () => new Promise(() => {}) };
    },
  }).search({ area: "Jaipur" });
  assert.equal(r.unavailable, true);
  assert.equal(signal.aborted, true);
});
test("Photon listings enrich OSM contacts without opening claims and cache by area", async () => {
  let calls = 0;
  const source = createPharmacyService({
    mode: "live",
    snapshots: [],
    fetchImpl: async (url) => {
      calls++;
      return {
        ok: true,
        json: async () =>
          url.includes("photon")
            ? {
                features: [
                  {
                    properties: {
                      osm_type: "N",
                      osm_id: 1,
                      osm_value: "pharmacy",
                      name: "Fixture",
                      street: "Test street",
                    },
                    geometry: { coordinates: [75.79, 26.91] },
                  },
                ],
              }
            : {
                elements: [
                  {
                    id: 1,
                    tags: {
                      phone: "+91 141 1234567",
                      opening_hours: "Mo-Fr 09:00-18:00",
                    },
                  },
                ],
              },
      };
    },
  });
  const a = await source.search({ area: "Jaipur" });
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].phone, "+91 141 1234567");
  assert.equal(a.items[0].openNow, undefined);
  await source.search({ area: "Jaipur" });
  assert.equal(calls, 2);
  await source.search({ area: "Mansarovar" });
  assert.ok(calls > 2);
});
test("directory fallback is explicitly dated and never claimed live stock", async () => {
  const source = createPharmacyService({
    mode: "live",
    fetchImpl: async () => {
      throw Error("offline");
    },
  });
  const r = await source.search({ area: "Jaipur" });
  assert.equal(r.unavailable, true);
  assert.ok(r.items.length > 0);
  assert.ok(
    r.items.every(
      (p) =>
        p.sourceKind === "directory" && p.checkedAt && p.phone && !p.inventory,
    ),
  );
  const distant = await source.search({ lat: 0, lng: 0 });
  assert.deepEqual(distant.items, []);
});
test("place search returns choices and caches without silently selecting", async () => {
  let calls = 0;
  const s = createPharmacyService({
    fetchImpl: async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          features: [
            {
              properties: { name: "First area", city: "Test city" },
              geometry: { coordinates: [75, 26] },
            },
            {
              properties: { name: "Second area" },
              geometry: { coordinates: [76, 27] },
            },
          ],
        }),
      };
    },
  });
  const r = await s.places("Some area");
  assert.equal(r.items.length, 2);
  await s.places("Some area");
  assert.equal(calls, 1);
});
