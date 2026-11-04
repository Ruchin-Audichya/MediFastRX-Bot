// Reproducible evaluation used in the project report: `npm run evaluate`.
// Prints JSON. Every number here is measured on the local machine; the network study
// uses the fictional demo pharmacies' assumed stock profiles and is labelled as simulation.
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { createCatalog, type Resolution } from "../catalog/catalog.ts";
import { openDatabase } from "../db/db.ts";
import { createMediFast } from "../domain/medifast.ts";
import { seedDemo } from "../domain/seed.ts";
import { createApp, PERSONAS } from "../app.ts";
import { loadConfig } from "../config.ts";
import { createExtractor } from "../extract/extract.ts";

process.removeAllListeners("warning");
const catalog = createCatalog();
const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s.at(-1)!.toFixed(3) };
};

// ── 1. Matching: a labelled query set. "unsafe" = an exact match to the wrong product.
type Case = { q: string; expect: "exact" | "choose" | "none" | "choose-or-none"; id?: string; group: string };
const cases: Case[] = [
  ...[["Dolo 650", "dolo-650"], ["Pan 40", "pan-40"], ["Augmentin 625", "augmentin-625"], ["Telma-H", "telma-h"], ["Montair LC", "montair-lc"],
     ["Thyronorm 50 mcg", "thyronorm-50"], ["Glycomet SR 500", "glycomet-sr-500"], ["Azithral 500", "azithral-500"], ["Shelcal 500", "shelcal-500"],
     ["Asthalin inhaler", "asthalin-100"], ["Ecosprin AV 75", "ecosprin-av-75"], ["Combiflam", "combiflam"], ["Allegra 180", "allegra-180"],
     ["Pan-D", "pan-d"], ["Zerodol SP", "zerodol-sp"], ["Ondem 4", "ondem-4"], ["Taxim-O 200", "taxim-o-200"], ["Amlong 5", "amlong-5"],
     ["Clopilet 75", "clopilet-75"], ["Rosuvas 10", "rosuvas-10"]].map(([q, id]) => ({ q, id, expect: "exact" as const, group: "brand + strength" })),
  ...[["dolo650", "dolo-650"], ["DOLO 650 TAB", "dolo-650"], ["pan40 tablet", "pan-40"], ["telma h tab", "telma-h"], ["augmentin 625 duo", "augmentin-625"],
     ["thyronorm 50mcg", "thyronorm-50"], ["montair-lc tab", "montair-lc"], ["ascoril ls syrup", "ascoril-ls"], ["eltroxin 50", "eltroxin-50"], ["concor 5", "concor-5"]]
    .map(([q, id]) => ({ q, id, expect: "exact" as const, group: "spacing / case / form words" })),
  ...[["dollo 650", "dolo-650"], ["crosin 650", "crocin-650"], ["combiflem", "combiflam"], ["shellcal 500", "shelcal-500"], ["becosule", "becosules"]]
    .map(([q, id]) => ({ q, id, expect: "exact" as const, group: "known misspellings (curated aliases)" })),
  ...["azithrall", "telmma", "panto-d", "montaire", "omezz", "ciploxx", "limceee", "calpoll", "amarill", "neurobione"]
    .map((q) => ({ q, expect: "choose" as const, group: "unknown misspellings (fuzzy)" })),
  ...["Thyronorm", "Allegra", "Atorva", "Amaryl", "Crocin", "Glycomet", "Calpol"].map((q) => ({ q, expect: "choose" as const, group: "brand without strength" })),
  ...["paracetamol", "azithromycin 500", "metformin", "cetirizine 10 mg", "amlodipine", "levothyroxine 50 mcg", "ondansetron", "pantoprazole 40"]
    .map((q) => ({ q, expect: "choose" as const, group: "salt / ingredient name" })),
  ...["Pan 20", "Dolo 500", "Thyronorm 60", "Telma 80", "Azithral 250", "Dolo 650 syrup", "Atorva 40", "Amlong 10"]
    .map((q) => ({ q, expect: "choose" as const, group: "strength / form not in catalog" })),
  // Other brands and salt spellings must never be pinned to one product (found and fixed during evaluation).
  ...["Pantop 40", "thyroxine 50", "frusemide 40", "cetrizine 10", "paracitamol", "ORS", "amoxycillin 500", "Glucomet 500"]
    .map((q) => ({ q, expect: "choose-or-none" as const, group: "other brand / salt spelling" })),
  ...["qwertyzz", "xyzzymed", "hello doctor", "blue pill", "zzzz 500"].map((q) => ({ q, expect: "none" as const, group: "not a medicine / unknown" })),
];
const groups = new Map<string, { total: number; correct: number; unsafe: number }>();
const failures: string[] = [];
for (const c of cases) {
  const r: Resolution = catalog.resolve(c.q);
  const g = groups.get(c.group) ?? { total: 0, correct: 0, unsafe: 0 };
  g.total++;
  const ok = c.expect === "choose-or-none" ? r.kind !== "exact" : r.kind === c.expect && (c.expect !== "exact" || (r.kind === "exact" && r.product.id === c.id));
  if (ok) g.correct++;
  else failures.push(`${c.q} → ${r.kind}${r.kind === "exact" ? ":" + r.product.id : ""}`);
  // Unsafe: confidently returns a product the query did not name.
  if (r.kind === "exact" && c.expect !== "exact") g.unsafe++;
  if (r.kind === "exact" && c.expect === "exact" && r.product.id !== c.id) g.unsafe++;
  groups.set(c.group, g);
}
const queries = cases.map((c) => c.q);
const timings: number[] = [];
for (let i = 0; i < 20_000; i++) {
  const q = queries[i % queries.length];
  const t = performance.now();
  catalog.resolve(q);
  timings.push((performance.now() - t) * 1000);
}

// ── 2. Domain operations (in-memory SQLite), milliseconds.
let clock = Date.UTC(2026, 10, 1);
const mf = createMediFast(openDatabase(":memory:"), catalog, { now: () => clock });
const { customer } = seedDemo(mf);
const opTimes: Record<string, number[]> = { createAsk: [], submitAnswer: [], board: [], reserve: [] };
const owner = (rid: number) => mf.pharmacies.get(mf.answers.get(rid)!.pharmacy_id)!.owner_id;
for (let i = 0; i < 300; i++) {
  clock += 86_400_000; // one request per simulated day, so per-customer limits don't interfere
  let t = performance.now();
  const ask = mf.asks.create(customer.id, { items: [{ productId: "dolo-650", qty: 2 }, { productId: "pan-40", qty: 1 }, { productId: "thyronorm-50", qty: 1 }], lat: 26.9116, lng: 75.7425, place: "Vaishali Nagar", radiusKm: 2 });
  opTimes.createAsk.push(performance.now() - t);
  const recips = mf.asks.recipients(ask.id);
  t = performance.now();
  mf.answers.submit(recips[0].id, owner(recips[0].id), { all: "have" });
  opTimes.submitAnswer.push(performance.now() - t);
  t = performance.now();
  mf.asks.board(ask.id);
  opTimes.board.push(performance.now() - t);
  t = performance.now();
  mf.asks.reserve(ask.id, customer.id, mf.asks.planFor(ask.id, recips[0].id));
  opTimes.reserve.push(performance.now() - t);
}

// ── 3. End to end through the real bot code (studio transport), milliseconds.
const app = createApp(loadConfig({ DATABASE_PATH: ":memory:", DEMO_SPEED: "1000", TELEGRAM_BOT_TOKEN: "", PUBLIC_URL: "" }), { extract: async () => "" });
const s = app.studio!;
const C = PERSONAS.customer, P = PERSONAS.pharmacist;
const btn = (chat: number, re: RegExp) => {
  for (const m of [...s.fake.snapshot(chat).messages].reverse()) for (const row of m.inline ?? []) for (const b of row) if (re.test(b.text) && b.callback_data) return { m, b };
  throw new Error(`no ${re}`);
};
const until = async (pred: () => boolean) => { const t = performance.now(); while (!pred()) { if (performance.now() - t > 5000) throw new Error("timeout"); await new Promise((r) => setImmediate(r)); } };
const e2e = { broadcastToPharmacist: [] as number[], answerToCustomerBoard: [] as number[] };
for (let i = 0; i < 40; i++) {
  app.resetStudio();
  await s.input.text(C, "Dolo 650, Pan 40");
  let x = btn(C.id, /Add these/); await s.input.press(C, x.m.id, x.b.callback_data!);
  x = btn(C.id, /Ask pharmacies/); await s.input.press(C, x.m.id, x.b.callback_data!);
  x = btn(C.id, /^Vaishali Nagar$/); await s.input.press(C, x.m.id, x.b.callback_data!);
  x = btn(C.id, /Send to/);
  const before = s.fake.snapshot(P.id).messages.length;
  let t = performance.now();
  await s.input.press(C, x.m.id, x.b.callback_data!);
  await until(() => s.fake.snapshot(P.id).messages.length > before);
  e2e.broadcastToPharmacist.push(performance.now() - t);
  x = btn(P.id, /Have everything/);
  t = performance.now();
  await s.input.press(P, x.m.id, x.b.callback_data!);
  await until(() => /Pinkcity Care Chemist/.test(s.fake.snapshot(C.id).messages.find((m) => /Asked \d+ pharmacies/.test(m.text))?.text ?? ""));
  e2e.answerToCustomerBoard.push(performance.now() - t);
}
app.stop();

// ── 4. Local OCR on the bundled sample prescription.
const ocr = createExtractor();
const img = readFileSync(new URL("../../data/demo-prescription.png", import.meta.url));
const ocrTimes: number[] = [];
let ocrText = "";
for (let i = 0; i < 6; i++) { const t = performance.now(); ocrText = await ocr(img, "image/png"); ocrTimes.push(performance.now() - t); }
const ocrLines = catalog.resolveMany(ocrText).map((l) => `${l.line} → ${l.result.kind}`);

// ── 5. Simulation study on the fictional network (assumed stock profiles; not field data).
const sim = createMediFast(openDatabase(":memory:"), catalog);
seedDemo(sim);
const near = sim.pharmacies.nearby({ lat: 26.9116, lng: 75.7425 }, 2);
const common = catalog.products.filter((p) => p.schedule !== "restricted").map((p) => p.id);
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const { createHash } = await import("node:crypto");
const unit = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("|")).digest().readUInt32BE(0) / 2 ** 32;
const trials = 2000;
let oneShop = 0, splitOnly = 0, neither = 0;
const responders: number[] = [];
for (let t = 0; t < trials; t++) {
  const size = 2 + Math.floor(rand() * 4); // 2–5 items
  const items = Array.from({ length: size }, () => common[Math.floor(rand() * common.length)]);
  const answering = near.filter((n) => rand() < JSON.parse(n.pharmacy.sim ?? '{"reply":0}').reply);
  responders.push(answering.length);
  const has = answering.map((n) => items.map((id) => unit(n.pharmacy.id, id, `day-${t % 30}`) < JSON.parse(n.pharmacy.sim!).stock));
  if (has.some((h) => h.every(Boolean))) oneShop++;
  else if (has.some((a, i) => has.some((b, j) => j > i && a.every((x, k) => x || b[k])))) splitOnly++;
  else neither++;
}

console.log(JSON.stringify({
  environment: { node: process.version, platform: `${process.platform}-${process.arch}`, catalogProducts: catalog.size },
  matching: {
    cases: cases.length,
    correct: [...groups.values()].reduce((a, g) => a + g.correct, 0),
    unsafe: [...groups.values()].reduce((a, g) => a + g.unsafe, 0),
    byGroup: Object.fromEntries(groups),
    failures,
    resolveMicroseconds: stats(timings),
  },
  domainMs: Object.fromEntries(Object.entries(opTimes).map(([k, v]) => [k, stats(v)])),
  endToEndMs: Object.fromEntries(Object.entries(e2e).map(([k, v]) => [k, stats(v)])),
  ocr: { coldMs: +ocrTimes[0].toFixed(0), warmMs: stats(ocrTimes.slice(1)), lines: ocrLines },
  simulation: {
    note: "Fictional network, assumed reply/stock profiles. Illustrates the mechanism, not field performance.",
    trials, pharmaciesWithin2km: near.length,
    respondersMedian: stats(responders).median,
    fulfilledByOneShop: +(oneShop / trials).toFixed(3),
    fulfilledOnlyBySplit: +(splitOnly / trials).toFixed(3),
    notFulfilled: +(neither / trials).toFixed(3),
  },
}, null, 2));
process.exit(0);
