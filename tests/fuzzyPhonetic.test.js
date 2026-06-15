"use strict";

// Tests for the upgraded "ChatGPT-like" fuzzy matching: phonetic recall +
// edit-distance scoring so first-letter typos and sound-alikes still resolve.
// Pure in-memory index (no Mongo).

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMedicineMatcherIndex,
  matchMedicine,
} = require("../src/medicine/matching/medicineMatcher");
const { phoneticKey, editSimilarity } = require("../src/medicine/matching/phonetics");

const CATALOG = [
  { medicineName: "Crocin", genericName: "Paracetamol", brands: ["Crocin", "Crocin Advance"], salts: ["Paracetamol"], aliases: ["fever tablet"], commonSpellings: ["crocine"] },
  { medicineName: "Dolo 650", genericName: "Paracetamol", brands: ["Dolo 650"], salts: ["Paracetamol"], commonSpellings: ["dolo"] },
  { medicineName: "Pregabalin", genericName: "Pregabalin", brands: ["Lyrica"], salts: ["Pregabalin"] },
  { medicineName: "Pantoprazole", genericName: "Pantoprazole", brands: ["Pan 40", "Pantocid"], salts: ["Pantoprazole"] },
  { medicineName: "Azithromycin", genericName: "Azithromycin", brands: ["Azee", "Azithral"], salts: ["Azithromycin"] },
  { medicineName: "Phenytoin", genericName: "Phenytoin", brands: ["Eptoin"], salts: ["Phenytoin"] },
];

const index = buildMedicineMatcherIndex(CATALOG);

const resolve = async (q) =>
  matchMedicine({ medicineName: q, genericName: q, brands: [q] }, index, { useFuzzy: true });

test("phoneticKey collapses sound-alikes", () => {
  assert.equal(phoneticKey("crocin"), phoneticKey("krocin"));
  assert.equal(phoneticKey("phenytoin"), phoneticKey("fenytoin"));
});

test("editSimilarity is high for single-char typos", () => {
  assert.ok(editSimilarity("pregabalin", "pregabakin") > 0.85);
  assert.ok(editSimilarity("pantoprazole", "pantoprozole") > 0.85);
});

const TYPOS = [
  ["pregabakin", "Pregabalin"],
  ["pantoprozole", "Pantoprazole"],
  ["azithromicin", "Azithromycin"],
  ["krocin", "Crocin"],       // first-letter typo (was impossible before)
  ["fenytoin", "Phenytoin"],  // ph→f sound-alike
  ["paracetmol", "Paracetamol"], // dropped letter on the generic
];

for (const [typo, expected] of TYPOS) {
  test(`resolves typo "${typo}" → ${expected}`, async () => {
    const r = await resolve(typo);
    // matchMedicine returns { confidence, medicines[] } (no `type`). A
    // confident fuzzy hit clears the normalizer's 0.55 acceptance bar.
    assert.ok(
      r.confidence >= 0.55 && r.medicines.length > 0,
      `expected a confident match for "${typo}", got conf ${r.confidence}`
    );
    const top = r.medicines[0];
    const blob = `${top.medicineName} ${top.genericName} ${(top.brands || []).join(" ")}`.toLowerCase();
    const hit =
      blob.includes(expected.toLowerCase()) ||
      (expected === "Crocin" && /paracetamol/i.test(blob));
    assert.ok(hit, `expected ${expected}, got ${top.medicineName} / ${top.genericName}`);
  });
}

test("nonsense does NOT force a false match", async () => {
  const r = await resolve("zzzqwlmnop");
  assert.ok(r.confidence < 0.55, `nonsense should not match confidently, got ${r.confidence}`);
});
