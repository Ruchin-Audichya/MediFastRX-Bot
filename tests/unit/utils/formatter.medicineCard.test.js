"use strict";

/**
 * Unit + snapshot tests for `formatMedicineCard` (Phase 9 / Task 11.1).
 *
 * **Validates: Requirements 1.9, 2.9**
 *
 * Coverage:
 *   1. Card rendered from a real MedicineContext + full evidence (no enrichment).
 *   2. Card with MediAtlas-style enrichment (forecast + pharmacies + inventory).
 *   3. Empty input returns "" (caller fallback).
 *   4. HTML escaping of dangerous characters in name / alternatives / pharmacy.
 *   5. Sections suppressed when their data is absent.
 *   6. Determinism — repeated calls yield identical output.
 *
 * No production code is mocked; we use `createMedicineContext` directly.
 *
 * Snapshots stored alongside the test under `__snapshots__/`. To intentionally
 * refresh: `UPDATE_FORMATTER_CARD_SNAPSHOTS=1 node --test tests/unit/utils/formatter.medicineCard.test.js`.
 */

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SNAPSHOT_DIR = path.join(__dirname, "__snapshots__");

const { formatMedicineCard } = require(path.join(REPO_ROOT, "src/utils/formatter.js"));
const { createMedicineContext } = require(path.join(
  REPO_ROOT,
  "src/context/medicineContext.js"
));

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Tiny inline snapshot helper (mirrors tests/preserve/medicineContext.preservation.test.js).
// ---------------------------------------------------------------------------
const assertSnapshot = (name, actual) => {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  }
  const file = path.join(SNAPSHOT_DIR, `${name}.json`);
  const serialized = JSON.stringify(actual, null, 2);
  if (
    !fs.existsSync(file) ||
    process.env.UPDATE_FORMATTER_CARD_SNAPSHOTS === "1"
  ) {
    fs.writeFileSync(file, serialized + "\n", "utf8");
    return;
  }
  const stored = fs.readFileSync(file, "utf8").trim();
  assert.equal(
    serialized,
    stored,
    `Snapshot drift for "${name}".\nExpected (stored):\n${stored}\nActual:\n${serialized}`
  );
};

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------
const buildPregabalinContext = (overrides = {}) =>
  createMedicineContext({
    resolution: {
      medicine: {
        _id: "med-pre-001",
        medicineName: "Pregabalin",
        genericName: "Pregabalin",
        aliases: ["Lyrica", "Pregeb"],
        salts: ["Pregabalin"],
        brands: ["Lyrica", "Nuropil"],
        category: "Neuropathic-Pain",
      },
      confidence: 0.92,
      method: "direct knowledge match",
      reason: "exact alias",
      relationships: [
        { type: "same_generic", from: "Pregabalin", to: "Gabapentin", confidence: 0.5 },
      ],
      ...(overrides.resolution || {}),
    },
    conversationId: "tg-1",
    userId: "tg-1",
    now: NOW,
  });

const fullEvidence = {
  medicineContext: {
    medicine: {
      medicineName: "Pregabalin",
      genericName: "Pregabalin",
      symptoms: ["neuropathic pain", "fibromyalgia", "anxiety"],
      sideEffects: ["dizziness", "drowsiness", "weight gain"],
      prescriptionRequired: true,
    },
    alternatives: [
      { medicineName: "Gabapentin" },
      { medicineName: "Duloxetine" },
    ],
  },
  pharmacyContext: {
    pharmacies: [
      {
        name: "Apollo Pharmacy",
        distanceKm: 0.8,
        phone: "0141-1234567",
      },
      {
        name: "MedPlus",
        distanceKm: 1.4,
      },
    ],
  },
};

const fullSafety = {
  notes: [
    "For seniors, check existing conditions and regular medicines before use.",
    "This may involve prescription or higher-risk medicine. Do not self-medicate.",
    "This bot helps discover medicines and is not a replacement for a doctor.",
  ],
};

// MediAtlas-shaped enrichment (Phase 7 / Task 9.2 mapper output).
const fullEnrichment = {
  inventory: {
    status: "ok",
    items: [
      { pharmacyName: "Wellness Forever", distanceKm: 0.5, inStock: true, phone: "022-99887766" },
    ],
  },
  forecast: { status: "ok", demandLevel: "high" },
  substitutes: { status: "empty", items: [] },
  pharmacies: {
    status: "ok",
    items: [
      { name: "Wellness Forever", distanceKm: 0.5, phone: "022-99887766", inStock: true },
      { name: "Noble Chemists", distanceKm: 0.9, inStock: false },
    ],
  },
};

// ===========================================================================
// 1. Snapshot — full data, no enrichment (OSM fallback for nearby).
// ===========================================================================
test("formatMedicineCard — full data, no enrichment", async (t) => {
  const ctx = buildPregabalinContext();
  const html = formatMedicineCard(ctx, {
    evidence: fullEvidence,
    safety: fullSafety,
  });

  await t.test("snapshot matches stored baseline", () => {
    assertSnapshot("formatter.medicineCard.full.noEnrichment", { html });
  });

  await t.test("contains expected sections only when data is present", () => {
    assert.match(html, /💊 <b>Pregabalin<\/b>/);
    assert.match(html, /<b>Used for:<\/b>/);
    assert.match(html, /<b>Common side effects:<\/b>/);
    assert.match(html, /<b>Key safety notes:<\/b>/);
    assert.match(html, /<b>Alternatives:<\/b> Gabapentin, Duloxetine/);
    assert.match(html, /<b>Nearby availability:<\/b>/);
    assert.match(html, /Apollo Pharmacy/);
    // No MediAtlas enrichment in this case.
    assert.doesNotMatch(html, /<b>Forecast:<\/b>/);
  });

  await t.test("disclaimer always present in footer", () => {
    assert.match(html, /This bot helps discover medicines and is not a replacement for a doctor\./);
  });

  await t.test("output is deterministic", () => {
    const second = formatMedicineCard(ctx, {
      evidence: fullEvidence,
      safety: fullSafety,
    });
    assert.equal(html, second);
  });
});

// ===========================================================================
// 2. Snapshot — full data WITH enrichment (forecast + pharmacies + inventory).
// ===========================================================================
test("formatMedicineCard — full data, with enrichment", async (t) => {
  const ctx = buildPregabalinContext();
  const html = formatMedicineCard(ctx, {
    evidence: fullEvidence,
    safety: fullSafety,
    enrichment: fullEnrichment,
  });

  await t.test("snapshot matches stored baseline", () => {
    assertSnapshot("formatter.medicineCard.full.withEnrichment", { html });
  });

  await t.test("forecast and enriched nearby surface in card", () => {
    assert.match(html, /<b>Forecast:<\/b> high demand expected\./);
    assert.match(html, /<b>Nearby availability:<\/b>/);
    assert.match(html, /Wellness Forever/);
    assert.match(html, /in stock/);
    assert.match(html, /call to confirm/);
    // Enrichment pharmacies replace OSM evidence when both are present.
    assert.doesNotMatch(html, /Apollo Pharmacy/);
  });
});

// ===========================================================================
// 3. Empty / null context returns empty string.
// ===========================================================================
test("formatMedicineCard — empty / null context returns empty string", () => {
  assert.equal(formatMedicineCard(null), "");
  assert.equal(formatMedicineCard(undefined), "");
  assert.equal(formatMedicineCard("not-an-object"), "");
});

// ===========================================================================
// 4. HTML escaping correctness.
// ===========================================================================
test("formatMedicineCard — HTML escapes name, alternatives, pharmacy fields", () => {
  const ctx = createMedicineContext({
    resolution: {
      medicine: {
        _id: "evil-001",
        medicineName: "<script>alert(1)</script>",
        genericName: "Evil & Co",
        aliases: ["A&B"],
        salts: ["S1"],
        brands: [],
        category: "test",
      },
      confidence: 0.9,
      method: "test",
      relationships: [],
    },
    conversationId: "tg-evil",
    userId: "tg-evil",
    now: NOW,
  });

  const html = formatMedicineCard(ctx, {
    evidence: {
      medicineContext: {
        medicine: {
          symptoms: ["fever <b>here</b>"],
          sideEffects: ["nausea & cramps"],
        },
        alternatives: [
          { medicineName: "<img src=x onerror=alert(1)>" },
          { medicineName: "Tylenol & Co" },
        ],
      },
      pharmacyContext: {
        pharmacies: [{ name: "<b>Bad</b> Pharmacy", phone: "<x>", distanceKm: 1.2 }],
      },
    },
    safety: { notes: ["safety <note> & advice"] },
  });

  // Dangerous markup must be escaped, not interpolated.
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  // & in plain text must become &amp; everywhere we emit user data.
  assert.match(html, /Evil &amp; Co/);
  assert.match(html, /Tylenol &amp; Co/);
  assert.match(html, /A&amp;B/);
  assert.match(html, /nausea &amp; cramps/);
  assert.match(html, /safety &lt;note&gt; &amp; advice/);
  assert.match(html, /&lt;b&gt;Bad&lt;\/b&gt; Pharmacy/);
});

// ===========================================================================
// 5. Sections suppressed when their data is absent.
// ===========================================================================
test("formatMedicineCard — sections suppressed when data absent", async (t) => {
  const ctx = createMedicineContext({
    resolution: {
      medicine: {
        _id: "med-bare",
        medicineName: "Paracetamol",
        // No generic distinct from medicineName.
        genericName: "Paracetamol",
        aliases: [],
        salts: [],
        brands: [],
        category: null,
      },
      confidence: 0.65,
      method: "test",
      relationships: [],
    },
    now: NOW,
  });

  // No evidence, no safety, no enrichment.
  const html = formatMedicineCard(ctx);

  await t.test("snapshot matches stored baseline", () => {
    assertSnapshot("formatter.medicineCard.bare", { html });
  });

  await t.test("only header + confidence + disclaimer surface", () => {
    assert.match(html, /💊 <b>Paracetamol<\/b>/);
    assert.match(html, /Confidence: 65%/);
    assert.match(html, /This bot helps discover medicines and is not a replacement for a doctor\./);
    assert.doesNotMatch(html, /<b>Used for:<\/b>/);
    assert.doesNotMatch(html, /<b>Common side effects:<\/b>/);
    assert.doesNotMatch(html, /<b>Key safety notes:<\/b>/);
    assert.doesNotMatch(html, /<b>Alternatives:<\/b>/);
    assert.doesNotMatch(html, /<b>Nearby availability:<\/b>/);
    assert.doesNotMatch(html, /<b>Forecast:<\/b>/);
    assert.doesNotMatch(html, /<blockquote/);
  });

  await t.test("generic name is not duplicated when identical to medicineName", () => {
    // Header should be just the medicine name, not "Paracetamol (Paracetamol)".
    assert.doesNotMatch(html, /<b>Paracetamol<\/b>\s*<i>\(Paracetamol\)<\/i>/);
  });
});
