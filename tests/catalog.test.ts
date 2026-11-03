import { test } from "node:test";
import assert from "node:assert/strict";
import { catalog } from "./helpers.ts";
import { label } from "../src/catalog/catalog.ts";

const exact = (q: string) => {
  const r = catalog.resolve(q);
  assert.equal(r.kind, "exact", `${q} → ${r.kind}`);
  return r.kind === "exact" ? r.product.id : "";
};
const choose = (q: string) => {
  const r = catalog.resolve(q);
  assert.equal(r.kind, "choose", `${q} → ${r.kind}`);
  return r.kind === "choose" ? r : null!;
};

test("exact brand, alias and typo-alias names resolve to one product", () => {
  assert.equal(exact("Dolo 650"), "dolo-650");
  assert.equal(exact("dolo650"), "dolo-650");
  assert.equal(exact("DOLLO 650 tablet"), "dolo-650");
  assert.equal(exact("Augmentin 625"), "augmentin-625");
  assert.equal(exact("Telma-H"), "telma-h");
  assert.equal(exact("thyronorm 50 mcg"), "thyronorm-50");
  assert.equal(exact("Glycomet SR 500"), "glycomet-sr-500");
});

test("strength, form and release are never silently swapped", () => {
  assert.equal(choose("Pan 20").reason, "no-such-variant");
  assert.equal(choose("Dolo 650 syrup").reason, "no-such-variant");
  assert.equal(choose("Thyronorm").reason, "variants");
  assert.equal(choose("Allegra").options.length, 2);
  assert.notEqual(catalog.resolve("Glycomet 500").kind === "exact" && (catalog.resolve("Glycomet 500") as any).product.id, "glycomet-sr-500");
});

test("an ingredient name lists products; brand choice stays with the person", () => {
  const r = choose("paracetamol 650");
  assert.equal(r.reason, "ingredient");
  assert.deepEqual(r.options.map((p) => p.id).sort(), ["crocin-650", "dolo-650", "gen-paracetamol-650"]);
  assert.ok(!choose("metformin").options.some((p) => p.id === "dolo-650"));
});

test("fuzzy suggestions need confirmation and unknown names stay unknown", () => {
  assert.equal(choose("azithrall").reason, "fuzzy");
  assert.equal(catalog.resolve("qwertyzz").kind, "none");
  assert.equal(catalog.resolve("").kind, "none");
});

test("lists are split into lines with quantities", () => {
  const lines = catalog.resolveMany("1. Dolo 650 x2\n2) Pan-D, Thyronorm 50 - 3 strips; azee 500");
  assert.deepEqual(lines.map((l) => [l.result.kind, l.qty]), [["exact", 2], ["exact", 1], ["exact", 3], ["exact", 1]]);
});

test("labels and schedules come from the catalog", () => {
  const p = catalog.get("asthalin-100")!;
  assert.equal(label(p), "Asthalin Inhaler 100 mcg");
  assert.equal(catalog.get("gen-alprazolam-025")!.schedule, "restricted");
  assert.equal(catalog.get("dolo-650")!.schedule, "otc");
  assert.ok(catalog.size >= 100);
});
