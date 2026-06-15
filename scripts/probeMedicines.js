"use strict";

// Force-probe the REAL medicine pipeline against real-world names — common,
// obscure, typo, Hinglish, and need-based — to see exactly what the bot would
// return. Exercises: searchMedicine (Mongo + fallback) → Apollo live →
// Groq need-suggestion. Read-only; does not send Telegram messages.
//
//   node scripts/probeMedicines.js

require("dotenv").config();
const connectDB = require("../config/database");
const mongoose = require("mongoose");
const { searchMedicine } = require("../src/services/searchService");
const apollo = require("../src/integrations/parse/apolloMedicineClient");
const {
  suggestMedicinesForNeed,
  looksLikeMedicineNeed,
  looksLikeMedicineQuery,
} = require("../src/medicine/llmAugmentService");

const QUERIES = [
  // --- common India brands (likely in seed) ---
  "Dolo 650", "Crocin", "Pantoprazole",
  // --- real brands probably NOT in the small seed ---
  "Shelcal 500", "Zincovit", "Liv 52", "Becosules", "Thyronorm 50",
  "Ecosprin 75", "Volini gel", "Combiflam", "Digene", "Vicks Action 500",
  "Saridon", "Disprin", "Revital H", "Unienzyme", "Gelusil",
  // --- chronic / serious real meds ---
  "Atorvastatin 20", "Losartan 50", "Rosuvastatin", "Clopidogrel",
  "Levothyroxine", "Amlodipine 5", "Insulin Glargine", "Warfarin",
  // --- antibiotics / specialist ---
  "Augmentin 625", "Cefixime 200", "Doxycycline", "Hydroxychloroquine",
  // --- typos of real meds ---
  "atorvastain", "rosuvastatn", "clopidogril", "levothyroxin", "amoxicilin",
  // --- Hinglish / need-based ---
  "bukhar ki dawa", "gas ki tablet", "sir dard ki medicine", "loose motion ki dawa",
  "sex medicine", "neend ki dawa", "khansi ka syrup", "sugar ki tablet",
  // --- nonsense control ---
  "zzqwlmed", "asdf123",
];

const liveInventory = process.env.ENABLE_LIVE_INVENTORY_SEARCH === "true";

const probeOne = async (q) => {
  const out = { query: q, path: [], outcome: "", detail: "" };
  try {
    const res = await searchMedicine(q);
    if (res.results && res.results.length) {
      const top = res.results[0];
      out.path.push(top.knowledgeOnly ? "catalog(knowledge)" : "catalog(inventory)");
      out.outcome = "RESOLVED";
      out.detail = `${top.medicineName}${top.genericName ? ` [${top.genericName}]` : ""}`;
      return out;
    }
    out.path.push("catalog:MISS");

    // Apollo live (real India catalog) — only when it looks like a name.
    if (apollo.isEnabled() && looksLikeMedicineQuery(q) && !looksLikeMedicineNeed(q)) {
      const a = await apollo.search(q);
      if (a.ok && a.results.length) {
        out.path.push("apollo");
        out.outcome = "RESOLVED (Apollo)";
        out.detail = `${a.results[0].medicineName} ₹${a.results[0].price ?? "?"} ${a.results[0].availability ?? ""}`.trim();
        return out;
      }
      out.path.push("apollo:MISS");
    }

    // Need-based Groq suggestion.
    if (looksLikeMedicineNeed(q)) {
      const s = await suggestMedicinesForNeed({ telegramId: "probe", query: q });
      if (s.ok && s.suggestions.length) {
        out.path.push("groq-suggest");
        out.outcome = "SUGGESTED";
        out.detail = s.suggestions.join(", ");
        return out;
      }
      out.path.push("groq-suggest:MISS");
    }

    out.outcome = "NOT FOUND";
    out.detail = (res.suggestions || []).map((x) => x.medicineName).filter(Boolean).join(", ") || "(no suggestions)";
    return out;
  } catch (e) {
    out.outcome = "ERROR";
    out.detail = e.message;
    return out;
  }
};

const run = async () => {
  await connectDB();
  console.log(`\nLIVE_INVENTORY=${liveInventory}  APOLLO=${apollo.isEnabled()}\n`);
  console.log("QUERY".padEnd(26), "OUTCOME".padEnd(20), "PATH".padEnd(34), "DETAIL");
  console.log("-".repeat(120));
  const tally = {};
  for (const q of QUERIES) {
    const r = await probeOne(q);
    tally[r.outcome] = (tally[r.outcome] || 0) + 1;
    console.log(
      q.padEnd(26),
      r.outcome.padEnd(20),
      r.path.join(" → ").padEnd(34),
      String(r.detail).slice(0, 60)
    );
  }
  console.log("\n=== Tally ===");
  Object.entries(tally).forEach(([k, v]) => console.log(`${k}: ${v}`));
  await mongoose.connection.close();
  process.exit(0);
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
