const test = require("node:test");
const assert = require("node:assert/strict");
const { formatSearchResults } = require("../src/utils/formatter");

test("medicine card hides router internals for normal users", () => {
  const message = formatSearchResults(
    [
      {
        medicineName: "Modafinil",
        genericName: "Modafinil",
        category: "neurological",
        knowledgeOnly: true,
        confidence: 0.88,
        symptoms: ["wakefulness support"],
        brands: ["Modalert", "Modvigil"],
        pharmacy: {
          name: "Medicine knowledge match",
          area: "No live stock",
          address: "Use Nearby Pharmacy to check stores around you.",
        },
      },
    ],
    "Modafinil",
    {
      routes: [{ tool: "medicine", confidence: 0.91 }],
      intent: { label: "medicine lookup", confidence: "high" },
    }
  );

  assert.match(message, /💊 <b>Modafinil<\/b>/);
  assert.match(message, /<b>Used for:<\/b>/);
  assert.match(message, /• wakefulness support/);
  assert.match(message, /<b>Brands:<\/b>/);
  assert.match(message, /Modalert/);
  assert.doesNotMatch(message, /AI route/i);
  assert.doesNotMatch(message, /91%/);
  assert.doesNotMatch(message, /Router:/);
});

test("contextual medicine card announces continuation without debug metadata", () => {
  const message = formatSearchResults(
    [
      {
        medicineName: "Pregabalin",
        genericName: "Pregabalin",
        category: "neurological",
        knowledgeOnly: true,
        symptoms: ["neuropathic pain"],
        brands: ["Lyrica"],
        pharmacy: {
          name: "Medicine knowledge match",
          area: "No live stock",
          address: "Use Nearby Pharmacy to check stores around you.",
        },
      },
    ],
    "side effects of Pregabalin",
    {
      contextual: {
        usedContext: true,
        context: { medicineName: "Pregabalin" },
      },
    }
  );

  assert.match(message, /Continuing from Pregabalin/);
  assert.doesNotMatch(message, /AI DEBUG/);
});

test("medicine card shows alternatives inside expandable details", () => {
  const message = formatSearchResults(
    [
      {
        medicineName: "Dolo 650",
        genericName: "Paracetamol",
        category: "painkiller",
        knowledgeOnly: true,
        symptoms: ["fever"],
        alternatives: [{ medicineName: "Crocin" }],
        pharmacy: {
          name: "Medicine knowledge match",
          area: "No live stock",
          address: "Use Nearby Pharmacy to check stores around you.",
        },
      },
    ],
    "Dolo 650"
  );

  assert.match(message, /Alternatives: Crocin/);
  assert.match(message, /blockquote expandable/);
});

test("debug metadata only appears when formatter debug flag is explicit", () => {
  const message = formatSearchResults(
    [
      {
        medicineName: "Dolo 650",
        genericName: "Paracetamol",
        knowledgeOnly: true,
        symptoms: ["fever"],
        pharmacy: {
          name: "Medicine knowledge match",
          area: "No live stock",
          address: "Use Nearby Pharmacy to check stores around you.",
        },
      },
    ],
    "Dolo 650",
    {
      debug: true,
      routes: [{ tool: "medicine", confidence: 0.9 }],
    }
  );

  assert.match(message, /AI DEBUG/);
  assert.match(message, /Router:/);
});
