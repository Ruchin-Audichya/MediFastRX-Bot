"use strict";

// Lightweight phonetic + edit-distance helpers to make medicine fuzzy search
// feel "ChatGPT-like" — i.e. tolerant of bad spelling, sound-alikes, and
// transposed letters, even when the typo is in the FIRST characters (which the
// prefix-index based candidate generation otherwise misses).
//
// We use a compact Soundex-style key (good enough for drug brand/salt names)
// plus Levenshtein distance for close-typo scoring. No dependencies.

// --- Soundex-ish phonetic key ----------------------------------------------
// Maps a word to a coarse sound signature so "krocin"/"crocin",
// "paracetmol"/"paracetamol", "pentop"/"pantop" collapse to the same/near key.
const SOUNDEX_MAP = {
  b: "1", f: "1", p: "1", v: "1",
  c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2",
  d: "3", t: "3",
  l: "4",
  m: "5", n: "5",
  r: "6",
};

const phoneticKey = (value = "") => {
  const w = String(value || "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  if (!w) return "";
  // Common drug-name sound equalizers applied before encoding.
  const eq = w
    .replace(/ph/g, "f")
    .replace(/^kn/g, "n")
    .replace(/ck/g, "k")
    .replace(/x/g, "ks")
    .replace(/z/g, "s");
  // Encode the FIRST letter too (as a sound class when it has one) so
  // sound-alike initials collapse: c/k → "2", f/p → "1". Vowel initials keep
  // a stable "A" marker so "omez"/"omeprazole" still share a prefix.
  const firstClass = SOUNDEX_MAP[eq[0]] || "A";
  let prev = SOUNDEX_MAP[eq[0]] || "";
  let code = "";
  for (let i = 1; i < eq.length; i += 1) {
    const c = SOUNDEX_MAP[eq[i]];
    if (c && c !== prev) code += c;
    if (!c) prev = "";
    else prev = c;
  }
  return (firstClass + code).slice(0, 6);
};

// --- Levenshtein edit distance (bounded, iterative) -------------------------
const levenshtein = (a = "", b = "") => {
  a = String(a);
  b = String(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  const curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
};

// Normalized edit-distance similarity in [0,1] (1 = identical).
const editSimilarity = (a = "", b = "") => {
  const x = String(a).toLowerCase().replace(/[^a-z0-9]/g, "");
  const y = String(b).toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!x && !y) return 1;
  if (!x || !y) return 0;
  const d = levenshtein(x, y);
  return 1 - d / Math.max(x.length, y.length);
};

module.exports = { phoneticKey, levenshtein, editSimilarity };
