"use strict";

// Seed-stable generators for the property tests in tests/property/.
// Decision (Task 14.1): NO fast-check dependency. We avoided every new
// dependency in this bugfix; staying consistent here keeps the test runner
// (`node --test`) self-contained and the property tests reproducible from a
// fixed seed.
//
// Each property file picks 5-10 seeds (e.g., [1, 7, 42, 137, 999]) and
// asserts the property holds for every input the generators emit. The
// generators are pure: same seed → same input sequence, on every machine.

// xorshift32 — small, fast, seedable PRNG. Bias is irrelevant for our use:
// we only need a deterministic stream over a small finite set of values.
const makeRng = (seed = 1) => {
  let s = seed >>> 0;
  if (s === 0) s = 0x6d2b79f5;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) / 0x100000000;
  };
};

const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];

// Seven canonical medicines reused across P1-P6. Shaped to match what
// `searchMedicineKnowledge().medicine` returns and what
// `createMedicineContext` consumes.
const MEDICINES = [
  {
    _id: "med-pregabalin",
    medicineName: "Pregabalin",
    genericName: "Pregabalin",
    aliases: ["Lyrica"],
    salts: ["Pregabalin"],
    brands: ["Lyrica"],
    category: "neuropathic_pain",
    sideEffects: [{ effect: "dizziness" }, { effect: "drowsiness" }],
    symptoms: ["nerve pain"],
    prescriptionRequired: true,
  },
  {
    _id: "med-dolo650",
    medicineName: "Dolo650",
    genericName: "Paracetamol",
    aliases: ["Calpol", "Crocin"],
    salts: ["Paracetamol"],
    brands: ["Dolo650"],
    category: "analgesic",
    sideEffects: [{ effect: "nausea (rare)" }],
    symptoms: ["fever", "pain"],
    prescriptionRequired: false,
  },
  {
    _id: "med-crocin",
    medicineName: "Crocin",
    genericName: "Paracetamol",
    aliases: ["Crocin Advance"],
    salts: ["Paracetamol"],
    brands: ["Crocin"],
    category: "analgesic",
    sideEffects: [],
    symptoms: ["fever"],
    prescriptionRequired: false,
  },
  {
    _id: "med-telmisartan",
    medicineName: "Telmisartan",
    genericName: "Telmisartan",
    aliases: ["Telma"],
    salts: ["Telmisartan"],
    brands: ["Telma"],
    category: "antihypertensive",
    sideEffects: [{ effect: "dizziness" }],
    symptoms: ["high blood pressure"],
    prescriptionRequired: true,
  },
  {
    _id: "med-modafinil",
    medicineName: "Modafinil",
    genericName: "Modafinil",
    aliases: ["Modalert"],
    salts: ["Modafinil"],
    brands: ["Modalert"],
    category: "wakefulness",
    sideEffects: [],
    symptoms: ["narcolepsy"],
    prescriptionRequired: true,
  },
  {
    _id: "med-pantoprazole",
    medicineName: "Pantoprazole",
    genericName: "Pantoprazole",
    aliases: ["Pan"],
    salts: ["Pantoprazole"],
    brands: ["Pan-D"],
    category: "gastro",
    sideEffects: [],
    symptoms: ["acidity"],
    prescriptionRequired: false,
  },
  {
    _id: "med-cetirizine",
    medicineName: "Cetirizine",
    genericName: "Cetirizine",
    aliases: ["Cetzine"],
    salts: ["Cetirizine"],
    brands: ["Cetzine"],
    category: "antihistamine",
    sideEffects: [],
    symptoms: ["allergy"],
    prescriptionRequired: false,
  },
];

// Foreign chunks the contamination test seeds in addition to chunks that
// match the active medicine. Their `metadata.medicine` / `metadata.generic`
// is a medicine that is NOT the active one.
const FOREIGN_CHUNKS = [
  {
    text: "Gabapentin side effects include dizziness, fatigue, ataxia.",
    metadata: { medicine: "Gabapentin", generic: "Gabapentin", category: "neuropathic_pain" },
  },
  {
    text: "Alprazolam can cause sedation and memory impairment.",
    metadata: { medicine: "Alprazolam", generic: "Alprazolam", category: "anxiolytic" },
  },
  {
    text: "Atorvastatin lipid panel monitoring guidance.",
    metadata: { medicine: "Atorvastatin", generic: "Atorvastatin", category: "statin" },
  },
  {
    text: "Metformin GI side effects and lactic acidosis warnings.",
    metadata: { medicine: "Metformin", generic: "Metformin", category: "antidiabetic" },
  },
  {
    text: "Levothyroxine dosing notes for hypothyroidism.",
    metadata: { medicine: "Levothyroxine", generic: "Levothyroxine", category: "endocrine" },
  },
];

const FOLLOW_UP_TEMPLATES = [
  "side effects",
  "alternatives",
  "what does it do?",
  "can I take it daily?",
  "can my father use it?",
  "what is the generic?",
  "interactions with alcohol",
  "precautions",
  "is it safe for kids",
  "dosage",
  "how often should I take it",
  "salt name",
];

// generateMedicineRecords — n distinct medicines drawn deterministically.
const generateMedicineRecords = (rng, n = 5) => {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ ...pick(rng, MEDICINES) });
  return out;
};

// generateChunks — half match the active medicine, half foreign. Shape is
// the (text, metadata) shape used by `evidenceIntegrity.validateEvidence`.
const generateChunks = (rng, activeMedicine, n = 6) => {
  const out = [];
  const matches = Math.max(1, Math.floor(n / 2));
  for (let i = 0; i < matches; i += 1) {
    out.push({
      text: `${activeMedicine.medicineName} info chunk ${i}.`,
      metadata: {
        medicine: activeMedicine.medicineName,
        generic: activeMedicine.genericName,
        category: activeMedicine.category || null,
      },
    });
  }
  for (let i = 0; i < n - matches; i += 1) {
    const f = pick(rng, FOREIGN_CHUNKS);
    out.push({ text: f.text, metadata: { ...f.metadata } });
  }
  return out;
};

const generateFollowUpSequence = (rng, length = 4) => {
  const out = [];
  for (let i = 0; i < length; i += 1) out.push(pick(rng, FOLLOW_UP_TEMPLATES));
  return out;
};

// Pair generator: (M, N) where N differs in identity from M. Guarantees a
// non-trivial switch test for P3.
const generateDistinctMedicinePair = (rng) => {
  const m = pick(rng, MEDICINES);
  let n;
  do {
    n = pick(rng, MEDICINES);
  } while (n.medicineName === m.medicineName || n.genericName === m.genericName);
  return [m, n];
};

module.exports = {
  makeRng,
  pick,
  MEDICINES,
  FOREIGN_CHUNKS,
  FOLLOW_UP_TEMPLATES,
  generateMedicineRecords,
  generateChunks,
  generateFollowUpSequence,
  generateDistinctMedicinePair,
};
