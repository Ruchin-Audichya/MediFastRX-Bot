import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createCatalog } from "../src/catalog/catalog.ts";
import { createKnowledgeBase } from "../src/kb/kb.ts";
import { parseDelimited, parseLayoutText, toItems } from "../src/kb/import.ts";
import { kbAnswer } from "../src/telegram/views.ts";

// Fixture in the PMBJP list's column layout. Test data only: not real prices, never shipped.
const fixture = toItems(parseDelimited(readFileSync(new URL("./fixtures/janaushadhi-sample.csv", import.meta.url), "utf8"), ","));
const catalog = createCatalog();
const kb = createKnowledgeBase(catalog, null);
const kbJan = createKnowledgeBase(catalog, { source: "test fixture", asOf: "2026-01-01", items: fixture });
const plain = (v: { text: string }) => v.text.replace(/<[^>]+>/g, "");

test("questions are recognised in English and Hinglish; plain names are not questions", () => {
  assert.deepEqual(kb.intent("what is Pan D"), { intent: "about", subject: "Pan D" });
  assert.deepEqual(kb.intent("brands of paracetamol"), { intent: "brands", subject: "paracetamol" });
  assert.deepEqual(kb.intent("generic of Telma 40?"), { intent: "generic", subject: "Telma 40" });
  assert.deepEqual(kb.intent("Thyronorm 50 kya hai"), { intent: "about", subject: "Thyronorm 50" });
  assert.deepEqual(kb.intent("Montair LC ke brands"), { intent: "brands", subject: "Montair LC" });
  assert.equal(kb.intent("Dolo 650"), null);
  assert.equal(kb.intent("Pan 40, Dolo 650 x2"), null);
});

test("answers come from the catalog: composition, same-composition brands, other strengths", () => {
  const t = plain(kbAnswer(kb, catalog, "about", "Thyronorm 50"));
  assert.match(t, /Contains: Levothyroxine 50 mcg/);
  assert.match(t, /Same composition, other brands: Eltroxin 50, Thyrox 50/);
  assert.match(t, /Thyronorm 25 tablet/);
  assert.match(t, /Information only/);
});

test("prescription status is per salt, and habit-forming medicines get a warning and no online link", () => {
  assert.match(plain(kbAnswer(kb, catalog, "brands", "paracetamol")), /Some combinations containing it need a prescription/);
  assert.doesNotMatch(plain(kbAnswer(kb, catalog, "brands", "paracetamol")), /^℞ Prescription medicine$/m);
  const alp = kbAnswer(kb, catalog, "about", "alprazolam");
  assert.match(plain(alp), /Habit-forming/);
  assert.equal(alp.keyboard, undefined);
});

test("unknown medicines say so instead of guessing", () => {
  assert.match(plain(kbAnswer(kb, catalog, "about", "xyzzy")), /don't have information/);
});

test("the importer reads the official list layout from CSV and from pdftotext output", () => {
  assert.equal(fixture.length, 11);
  assert.deepEqual(fixture[1], { code: "TEST2", name: "Telmisartan Tablets IP 40 mg", unit: "10's", mrp: 14.5, group: "Cardiovascular" });
  const layout = toItems(parseLayoutText("1   TEST1   Paracetamol Tablets IP 500 mg   10's   9.00   Analgesic\n2   TEST2   Telmisartan Tablets IP 40 mg   10's   14.50   Cardiovascular"));
  assert.equal(layout.length, 2);
  assert.equal(layout[1].mrp, 14.5);
});

test("with Jan Aushadhi data, answers show the generic and its MRP with the source", () => {
  const t = plain(kbAnswer(kbJan, catalog, "generic", "Telma 40"));
  assert.match(t, /Jan Aushadhi generic:[\s\S]*Telmisartan Tablets IP 40 mg, 10's · MRP ₹14\.5/);
  assert.match(t, /Source: MediFast catalog; test fixture \(2026-01-01\)/);
  assert.match(plain(kbAnswer(kbJan, catalog, "about", "metformin")), /Metformin Hydrochloride Tablets IP 500 mg/);
});

test("the board offers an online search only for items no nearby pharmacy can supply", async () => {
  const { world } = await import("./helpers.ts");
  const { boardView } = await import("../src/telegram/views.ts");
  const w = world();
  const ask = w.mf.asks.create(w.customer.id, { items: [{ productId: "dolo-650", qty: 1 }, { productId: "thyronorm-50", qty: 1 }], ...w.VAISHALI, radiusKm: 2 });
  for (const r of w.mf.asks.recipients(ask.id)) {
    w.mf.answers.mark(r.id, w.ownerOf(r.id), 0, "have");
    w.mf.answers.submit(r.id, w.ownerOf(r.id), { fill: "no" });
  }
  const links = { board: () => null, desk: () => null };
  const buttons = boardView(w.mf.asks.board(ask.id), links, Date.now()).keyboard!.inline_keyboard.flat() as any[];
  const online = buttons.filter((b) => b.url?.includes("blinkit.com"));
  assert.equal(online.length, 1);
  assert.match(online[0].text, /Thyronorm 50/);
  assert.equal(online[0].url, "https://blinkit.com/s/?q=Thyronorm%2050");
});
