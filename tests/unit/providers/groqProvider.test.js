"use strict";

/**
 * Task 7.4 — unit tests for the Groq provider's prompt grounding, helpers,
 * and sanitizer behavior. These complement the existing
 * `tests/groqProvider.test.js` (system prompt regex + missing-key fallback)
 * and focus on the BaseLLMProvider prompt builder contracts plus the
 * stubbed-fetch sanitizer path.
 *
 * **Validates: Requirements 2.9, 3.3, 3.7**
 *
 * Frameworks: node:test + node:assert/strict only. No new deps. No real
 * network — `globalThis.fetch` is stubbed and restored per subtest.
 */

const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const BaseLLMProvider = require(path.join(REPO_ROOT, "src/providers/baseLLMProvider"));
const { extractValidatedRagContext, extractEnrichment } = BaseLLMProvider;
const GroqProvider = require(path.join(REPO_ROOT, "src/providers/groqProvider"));

// ---------------------------------------------------------------------------
// Shared fixtures.
// ---------------------------------------------------------------------------

const buildEvidence = (over = {}) => ({
  medicineContext: {
    medicine: {
      medicineName: "Pregabalin",
      genericName: "Pregabalin",
      category: "neuropathic_pain",
    },
    alternatives: [{ medicineName: "Gabapentin" }],
    relationships: [{ type: "same_class", from: "Pregabalin", to: "Gabapentin" }],
  },
  ragContext: {
    context: [
      { text: "Pregabalin causes dizziness", belongsToActiveMedicine: true },
      { text: "Gabapentin overlap", belongsToActiveMedicine: false },
    ],
  },
  ...over,
});

// ===========================================================================
// A) Prompt grounding via BaseLLMProvider.buildPrompt
// ===========================================================================

test("buildPrompt — medicine-grounded prompt surfaces validated chunks only", () => {
  const provider = new BaseLLMProvider();
  const out = provider.buildPrompt({
    prompt: "side effects?",
    evidence: buildEvidence(),
    context: [],
    memory: [],
  });

  // First line begins with "You are MediFast AI." (the grounded path).
  assert.ok(
    out.startsWith("You are MediFast AI."),
    `prompt should start with "You are MediFast AI.", got: ${out.slice(0, 80)}`
  );

  // Active medicine header — no "(generic: ...)" suffix because they match.
  assert.ok(out.includes("Active medicine: Pregabalin"), "missing active-medicine header");
  assert.ok(!/\(generic:/.test(out), `unexpected "(generic: ...)" suffix in: ${out}`);

  // Category line.
  assert.ok(out.includes("Category: neuropathic_pain."), "missing category line");

  // Validated chunk surfaced; non-validated chunk filtered.
  assert.ok(out.includes("Pregabalin causes dizziness"), "validated chunk missing");
  assert.ok(!out.includes("Gabapentin overlap"), "non-validated chunk leaked");

  // Grounding rules header + 4 numbered rules present.
  assert.ok(out.includes("Grounding rules:"), "missing grounding rules header");
  for (const n of ["1.", "2.", "3.", "4."]) {
    assert.ok(out.includes(`\n${n} `), `missing grounding rule ${n}`);
  }

  // Ends with the user-question footer.
  assert.ok(
    out.endsWith("User question:\nside effects?"),
    `prompt should end with the user question, got tail: ${out.slice(-80)}`
  );
});

test("buildPrompt — generic prompt path used when evidence is null", () => {
  const provider = new BaseLLMProvider();
  const out = provider.buildPrompt({
    prompt: "what is fever?",
    evidence: null,
    context: [{ text: "fever guideline" }],
    memory: [],
  });

  // The legacy generic path retains the existing intro sentence so that
  // non-medicine flows are byte-for-byte unchanged (preservation contract).
  assert.ok(
    out.includes("You are MediFast AI, an India-first medicine discovery assistant."),
    "missing legacy generic intro line"
  );
  assert.ok(
    out.includes("Use retrieved context and tool results only."),
    "missing legacy 'use retrieved context only' sentence"
  );
  // Grounded-path markers MUST NOT appear in the generic path.
  assert.ok(!out.includes("Active medicine:"), "grounded header leaked into generic path");
  assert.ok(!out.includes("Grounding rules:"), "grounded rules leaked into generic path");
  assert.ok(out.endsWith("User question:\nwhat is fever?"), "generic path footer wrong");
});

test("buildPrompt — Live enrichment included only when present", () => {
  const provider = new BaseLLMProvider();

  // (a) With one enrichment slot populated → "Live enrichment" line appears.
  const evWith = buildEvidence();
  evWith.medicineContext.medicine.enrichment = {
    inventory: { items: [{ pharmacyName: "Apollo", inStock: true }] },
    forecast: null,
    substitutes: null,
    pharmacies: null,
  };
  const withEnrichment = provider.buildPrompt({ prompt: "?", evidence: evWith });
  assert.ok(
    withEnrichment.includes("Live enrichment"),
    "Live enrichment line should appear when inventory is present"
  );

  // (b) With all four slots null → "Live enrichment" line absent.
  const evWithout = buildEvidence();
  evWithout.medicineContext.medicine.enrichment = {
    inventory: null,
    forecast: null,
    substitutes: null,
    pharmacies: null,
  };
  const withoutEnrichment = provider.buildPrompt({ prompt: "?", evidence: evWithout });
  assert.ok(
    !withoutEnrichment.includes("Live enrichment"),
    "Live enrichment line must be absent when all slots are null"
  );
});

// ===========================================================================
// B) Helpers — extractValidatedRagContext, extractEnrichment
// ===========================================================================

test("extractValidatedRagContext — drops belongsToActiveMedicine === false", () => {
  const evidence = buildEvidence();
  const out = extractValidatedRagContext(evidence);
  assert.equal(out.length, 1, `expected 1 validated item, got ${out.length}`);
  assert.equal(out[0].text, "Pregabalin causes dizziness");
});

test("extractValidatedRagContext — keeps items with undefined or true tag", () => {
  const evidence = {
    ragContext: {
      context: [
        { text: "no tag" },                            // undefined → kept
        { text: "explicit true", belongsToActiveMedicine: true },
        { text: "explicit false", belongsToActiveMedicine: false }, // dropped
      ],
    },
  };
  const out = extractValidatedRagContext(evidence);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((c) => c.text), ["no tag", "explicit true"]);
});

test("extractValidatedRagContext — falls back to provided context when no evidence", () => {
  assert.deepEqual(extractValidatedRagContext(null), []);
  assert.deepEqual(extractValidatedRagContext(undefined), []);
  const fallback = [{ text: "ctx-1" }];
  assert.deepEqual(extractValidatedRagContext(null, fallback), fallback);
  // Empty ragContext.context array also falls back.
  assert.deepEqual(
    extractValidatedRagContext({ ragContext: { context: [] } }, fallback),
    fallback
  );
});

test("extractEnrichment — null when no enrichment is present", () => {
  assert.equal(extractEnrichment(null), null);
  assert.equal(extractEnrichment({}), null);
  assert.equal(extractEnrichment({ medicineContext: {} }), null);
  assert.equal(
    extractEnrichment({ medicineContext: { medicine: {} } }),
    null,
    "no enrichment object on medicine"
  );
});

test("extractEnrichment — returns only non-null subsections when some present", () => {
  const evidence = {
    medicineContext: {
      medicine: {
        enrichment: {
          inventory: { items: [{ pharmacyName: "Apollo" }] },
          forecast: null,
          substitutes: { count: 3 },
          pharmacies: null,
        },
      },
    },
  };
  const out = extractEnrichment(evidence);
  assert.deepEqual(Object.keys(out).sort(), ["inventory", "substitutes"]);
  assert.equal(out.inventory.items[0].pharmacyName, "Apollo");
  assert.equal(out.substitutes.count, 3);
});

test("extractEnrichment — null when all four slots are null", () => {
  const evidence = {
    medicineContext: {
      medicine: {
        enrichment: { inventory: null, forecast: null, substitutes: null, pharmacies: null },
      },
    },
  };
  assert.equal(extractEnrichment(evidence), null);
});

// ===========================================================================
// C) Sanitizer behavior — exercised through GroqProvider.generate with a
//    stubbed `globalThis.fetch`.
// ===========================================================================

const installFetchStub = (t, body) => {
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.GROQ_API_KEY;
  const originalModel = process.env.GROQ_MODEL;

  process.env.GROQ_API_KEY = "x";
  delete process.env.GROQ_MODEL;

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => body,
    text: async () => "",
  });

  t.after(() => {
    if (originalFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = originalModel;
  });
};

test("sanitizer — strips Confidence/Sources/URL lines when evidence has no URL", async (t) => {
  installFetchStub(t, {
    choices: [
      {
        message: {
          content:
            "Side effects: dizziness.\nConfidence: 0.9\nSources: pubmed.org\nhttps://example.com",
        },
      },
    ],
  });

  const provider = new GroqProvider();
  const result = await provider.generate({
    prompt: "test",
    evidence: null,
    context: [],
    memory: [],
  });

  assert.equal(result.ok, true);
  assert.ok(
    result.text.includes("Side effects: dizziness."),
    `expected substantive line preserved, got: ${result.text}`
  );
  assert.ok(!/Confidence:/i.test(result.text), "Confidence line should be stripped");
  assert.ok(!/Sources?:/i.test(result.text), "Sources line should be stripped");
  assert.ok(
    !result.text.includes("https://example.com"),
    "URL must be stripped when no URL is present in evidence/context"
  );
});

test("sanitizer — preserves URL lines when context contains a URL", async (t) => {
  installFetchStub(t, {
    choices: [
      {
        message: {
          content:
            "Side effects: dizziness.\nConfidence: 0.9\nSources: pubmed.org\nhttps://example.com",
        },
      },
    ],
  });

  const provider = new GroqProvider();
  const result = await provider.generate({
    prompt: "test",
    evidence: null,
    context: [{ text: "see https://example.com for more" }],
    memory: [],
  });

  assert.equal(result.ok, true);
  // URL line preserved because evidenceHasUrl picked up the URL in context.
  assert.ok(
    result.text.includes("https://example.com"),
    `URL line should survive when context carries a URL, got: ${result.text}`
  );
  // Confidence / Sources lines are still stripped regardless.
  assert.ok(!/Confidence:/i.test(result.text), "Confidence line still stripped");
  assert.ok(!/^\s*Sources?:/im.test(result.text), "Sources line still stripped");
  assert.ok(result.text.includes("Side effects: dizziness."), "substantive line preserved");
});
