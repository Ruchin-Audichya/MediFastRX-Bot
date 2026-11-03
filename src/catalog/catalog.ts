import { readFileSync } from "node:fs";
import {
  distance, normalize, parseIdentity, phonetic, splitLines, splitQuantity, strengthsAgree,
  type ParsedIdentity,
} from "./identity.ts";

export type Ingredient = { name: string; strength: string | null };
export type Schedule = "otc" | "rx" | "restricted";
export type Product = {
  id: string;
  brand: string;
  composition: string;
  ingredients: Ingredient[];
  form: string;
  release: string | null;
  schedule: Schedule;
  category: string;
  unit: string; // what one "pack" means at the counter
  generic: boolean;
  aliases: string[];
};

export type Resolution =
  | { kind: "exact"; product: Product }
  | { kind: "choose"; reason: "variants" | "ingredient" | "fuzzy" | "no-such-variant"; options: Product[] }
  | { kind: "none" };

const UNIT_BY_FORM: Record<string, string> = {
  tablet: "strip", capsule: "strip", syrup: "bottle", suspension: "bottle", drops: "bottle",
  spray: "bottle", cream: "tube", gel: "tube", ointment: "tube", inhaler: "inhaler", sachet: "sachet",
};

function parseComposition(text: string): { ingredients: Ingredient[]; release: string | null } {
  let release: string | null = null;
  const ingredients = text.split(/\s\+\s/).map((part) => {
    let p = part.trim();
    const rel = p.match(/\s(SR|XL|ER|CR)$/);
    if (rel) { release = rel[1].toLowerCase(); p = p.slice(0, -rel[0].length); }
    const m = p.match(/^(.*?)\s+(\d[\d.]*\s*(?:mg|mcg|g|IU|%)(?:\s*w\/[wv])?(?:\/\d+\s*ml)?)$/);
    return m ? { name: m[1], strength: m[2] } : { name: p, strength: null };
  });
  return { ingredients, release };
}

export function loadProducts(path = new URL("../../data/catalog.src.tsv", import.meta.url)): Product[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((line) => {
      const [id, brand, composition, form, rx, category, aliases = ""] = line.split("\t");
      const { ingredients, release } = parseComposition(composition);
      return {
        id, brand, composition, ingredients, form, release, category,
        schedule: rx === "2" ? "restricted" : rx === "1" ? "rx" : "otc",
        unit: UNIT_BY_FORM[form] ?? "pack",
        generic: /\(generic\)/.test(brand),
        aliases: aliases.split("|").map((a) => a.trim()).filter(Boolean),
      } satisfies Product;
    });
}

type Key = { name: string; numbers: string[]; product: Product };

export function createCatalog(products: Product[] = loadProducts()) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const ingredientNames = new Set(products.flatMap((p) => p.ingredients.map((i) => normalize(i.name))));
  const keys: Key[] = [];
  const byName = new Map<string, Key[]>();
  const addKey = (text: string, product: Product) => {
    const id = parseIdentity(text.replace(/\(generic\)/, ""));
    // Ingredient names are handled by the ingredient path, so brand choice stays explicit.
    if (!id.name || ingredientNames.has(id.name)) return;
    const key = { name: id.name, numbers: id.strengths, product };
    keys.push(key);
    byName.set(id.name, [...(byName.get(id.name) ?? []), key]);
  };
  for (const p of products) {
    addKey(p.brand, p);
    p.aliases.forEach((a) => addKey(a, p));
  }
  const names = [...byName.keys()];

  const strengthsOf = (p: Product) =>
    p.ingredients.map((i) => i.strength).filter(Boolean).map((s) => parseIdentity(s!).strengths[0]).filter(Boolean);

  function compatible(q: ParsedIdentity, p: Product, viaNumbers: string[][]): boolean {
    if (q.forms.length && !q.forms.includes(p.form)) return false;
    if (q.release.length && !q.release.includes(p.release ?? "")) return false;
    return strengthsAgree(q.strengths, [strengthsOf(p), ...viaNumbers]);
  }

  const unique = (list: Product[]) => [...new Map(list.map((p) => [p.id, p])).values()];
  const rank = (list: Product[]) =>
    unique(list).sort((a, b) => a.ingredients.length - b.ingredients.length || Number(b.generic) - Number(a.generic) || a.brand.localeCompare(b.brand));

  function resolve(input: string): Resolution {
    const q = parseIdentity(input);
    if (!q.name) return { kind: "none" };

    // 1. An ingredient name lists every product containing it. Brand choice stays human.
    const ingredientHit = [...ingredientNames].find((n) => n === q.name || (q.name.length > 7 && distance(n, q.name) <= 2));
    if (ingredientHit) {
      const containing = products.filter((p) => p.ingredients.some((i) => normalize(i.name) === ingredientHit));
      const filtered = containing.filter((p) => compatible(q, p, []));
      return { kind: "choose", reason: "ingredient", options: rank(filtered.length ? filtered : containing).slice(0, 8) };
    }

    // 2. Exact brand / alias name, then explicit strength / form / release gates.
    const hits = byName.get(q.name);
    if (hits) {
      const products = unique(hits.map((k) => k.product));
      const numbersFor = (p: Product) => keys.filter((k) => k.product === p && k.numbers.length).map((k) => k.numbers);
      const ok = products.filter((p) => compatible(q, p, numbersFor(p)));
      if (ok.length === 1) return { kind: "exact", product: ok[0] };
      if (ok.length > 1) {
        // "Dolo 650" names one product even if aliases also exist; "Allegra" names two.
        return { kind: "choose", reason: "variants", options: rank(ok) };
      }
      return { kind: "choose", reason: "no-such-variant", options: rank(products) };
    }

    // 3. Bounded fuzzy / phonetic / prefix suggestions. Never auto-confirmed.
    const limit = q.name.length <= 4 ? 1 : q.name.length <= 8 ? 2 : 3;
    const sound = phonetic(q.name);
    const scored = names
      .map((n) => {
        const d = distance(n, q.name);
        const score = d <= limit ? d : phonetic(n) === sound && sound.length >= 3 ? limit : q.name.length >= 3 && n.startsWith(q.name) ? limit + 0.5 : Infinity;
        return { n, score };
      })
      .filter((x) => x.score !== Infinity)
      .sort((a, b) => a.score - b.score)
      .slice(0, 6);
    const options = unique(scored.flatMap((s) => byName.get(s.n)!.map((k) => k.product)));
    const narrowed = options.filter((p) => compatible(q, p, []));
    if (options.length) return { kind: "choose", reason: "fuzzy", options: (narrowed.length ? narrowed : options).slice(0, 6) };
    return { kind: "none" };
  }

  /** Resolve a free-text list (typed, pasted or OCR'd) line by line. */
  function resolveMany(text: string) {
    return splitLines(text).map((line) => {
      const { text: name, qty } = splitQuantity(line);
      return { line, qty, result: resolve(name) };
    });
  }

  return { products, get: (id: string) => byId.get(id), resolve, resolveMany, size: products.length };
}

export type Catalog = ReturnType<typeof createCatalog>;

export function label(p: Product): string {
  const strength = !/\d/.test(p.brand) && p.ingredients.length === 1 && p.ingredients[0].strength ? ` ${p.ingredients[0].strength}` : "";
  const form = p.brand.toLowerCase().includes(p.form) ? "" : ` ${p.form}`;
  return `${p.brand}${strength}${form}`;
}
