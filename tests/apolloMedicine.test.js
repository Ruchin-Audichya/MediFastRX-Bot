"use strict";

// Tests for the Apollo Pharmacy (Parse) enrichment client + formatter.
// Mocks global fetch — no network. Validates the disabled-by-default contract,
// response normalization against the REAL observed shape, timeout/error
// graceful fallback, and the formatted card.

const test = require("node:test");
const assert = require("node:assert/strict");

const apollo = require("../src/integrations/parse/apolloMedicineClient");
const { formatApolloResults } = require("../src/utils/formatter");

// Real observed Apollo response shape (trimmed from a live call).
const APOLLO_RESPONSE = {
  status: "success",
  data: {
    query: "dolo 650",
    total_results: 20,
    products: [
      {
        name: "Dolo-650 Tablet 15's",
        sku: "DOL0026",
        price: 32.0,
        mrp: 32.0,
        discount_percentage: 0,
        manufacturer: "Micro Labs Ltd",
        availability: "in-stock",
        pack_size: "15 Tablet",
        is_prescription_required: false,
        tags: ["Paracetamol-650Mg", "Pain & Fever"],
      },
      {
        name: "Paracip-650 Tablet 10's",
        sku: "PAR0014",
        price: 15.91,
        mrp: 21.5,
        discount_percentage: 26,
        manufacturer: null,
        availability: "in-stock",
        pack_size: "10 Tablet",
        is_prescription_required: false,
        tags: ["Paracetamol-650Mg"],
      },
    ],
  },
};

const withMockFetch = async (impl, fn) => {
  const original = global.fetch;
  global.fetch = impl;
  try {
    return await fn();
  } finally {
    global.fetch = original;
  }
};

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
};

test("disabled by default → returns { ok:false, disabled:true }", async () => {
  await withEnv({ APOLLO_ENABLED: "false" }, async () => {
    const out = await apollo.search("dolo 650");
    assert.equal(out.ok, false);
    assert.equal(out.disabled, true);
    assert.deepEqual(out.results, []);
  });
});

test("enabled → normalizes the real Apollo response shape", async () => {
  await withEnv(
    {
      APOLLO_ENABLED: "true",
      PARSE_API_KEY: "test-key",
      APOLLO_SEARCH_ENDPOINT: "https://api.parse.bot/scraper/x/search_medicines",
    },
    async () => {
      await withMockFetch(
        async () => ({ ok: true, json: async () => APOLLO_RESPONSE }),
        async () => {
          const out = await apollo.search("dolo 650", { pincode: "302001" });
          assert.equal(out.ok, true);
          assert.equal(out.total, 20);
          assert.equal(out.results.length, 2);
          const first = out.results[0];
          assert.equal(first.medicineName, "Dolo-650 Tablet 15's");
          assert.equal(first.price, 32);
          assert.equal(first.manufacturer, "Micro Labs Ltd");
          assert.equal(first.inStock, true);
          assert.equal(first.prescriptionRequired, false);
          assert.deepEqual(first.tags, ["Paracetamol-650Mg", "Pain & Fever"]);
          assert.equal(out.results[1].discountPercentage, 26);
        }
      );
    }
  );
});

test("HTTP error → graceful { ok:false }, never throws", async () => {
  await withEnv(
    { APOLLO_ENABLED: "true", PARSE_API_KEY: "k", APOLLO_SEARCH_ENDPOINT: "https://x/y" },
    async () => {
      await withMockFetch(
        async () => ({ ok: false, status: 503, text: async () => "down" }),
        async () => {
          const out = await apollo.search("dolo");
          assert.equal(out.ok, false);
          assert.deepEqual(out.results, []);
        }
      );
    }
  );
});

test("network throw → graceful { ok:false }, never throws", async () => {
  await withEnv(
    { APOLLO_ENABLED: "true", PARSE_API_KEY: "k", APOLLO_SEARCH_ENDPOINT: "https://x/y" },
    async () => {
      await withMockFetch(
        async () => {
          throw new Error("ECONNRESET");
        },
        async () => {
          const out = await apollo.search("dolo");
          assert.equal(out.ok, false);
        }
      );
    }
  );
});

test("formatApolloResults renders prices, discount, stock, manufacturer", () => {
  const normalized = APOLLO_RESPONSE.data.products.map(apollo.normalizeProduct);
  const html = formatApolloResults("dolo 650", normalized);
  assert.match(html, /Apollo Pharmacy/);
  assert.match(html, /Dolo-650 Tablet 15's/);
  assert.match(html, /₹32/);
  assert.match(html, /26% off/);
  assert.match(html, /In stock/);
  assert.match(html, /Micro Labs Ltd/);
  assert.match(html, /Confirm with a pharmacist/);
});

test("formatApolloResults returns empty string for no results", () => {
  assert.equal(formatApolloResults("x", []), "");
});
