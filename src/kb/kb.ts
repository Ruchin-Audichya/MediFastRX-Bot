// Medicine knowledge base: deterministic answers from structured data, no language model.
// Sources: the MediFast catalog (brands, exact compositions, schedules) and, when imported,
// the official PMBJP (Jan Aushadhi) generic medicine list (generic name, pack, MRP, group).
// It describes medicines; it never recommends one for a symptom or advises on dosage.
import { existsSync, readFileSync } from "node:fs";
import { label, type Catalog, type Product } from "../catalog/catalog.ts";
import { distance, normalize } from "../catalog/identity.ts";

export type JanItem = { code: string; name: string; unit: string; mrp: number | null; group: string | null };
export type JanData = { source: string; asOf: string; items: JanItem[] };

export const GROUPS: Record<string, string> = {
  "pain-fever": "Pain and fever relief", gastro: "Stomach and digestion", antibiotic: "Antibiotics (bacterial infections)",
  allergy: "Allergy and cold", respiratory: "Breathing and asthma", diabetes: "Diabetes", "heart-bp": "Heart and blood pressure",
  thyroid: "Thyroid", vitamins: "Vitamins and supplements", neuro: "Nerves and mental health", skin: "Skin",
  "eye-ear": "Eye and ear", womens: "Women's health",
};

/** Strip pharmacopoeia and form words so "Paracetamol Tablets IP 500 mg" → "paracetamol 500 mg". */
const cleanGeneric = (s: string) =>
  normalize(s).replace(/\b(ip|bp|usp|tablets?|tab|capsules?|cap|syrup|oral|suspension|solution|injection|cream|gel|ointment|drops?|eye|ear|nasal|spray|film coated|fc|sr|er|xl|dt|md|for|and|with|w\/w|w\/v)\b/g, " ").replace(/\s+/g, " ").trim();

export function loadJanAushadhi(path = new URL("../../data/janaushadhi.json", import.meta.url)): JanData | null {
  if (!existsSync(path)) return null;
  const d = JSON.parse(readFileSync(path, "utf8")) as JanData;
  return Array.isArray(d.items) && d.items.length ? d : null;
}

export type SaltInfo = {
  salt: string;                // canonical ingredient name
  products: Product[];         // catalog products containing it
  sameComposition: Product[][]; // groups of brands with identical composition
  groups: string[];            // therapeutic groups
  jan: JanItem[];              // Jan Aushadhi generics containing it
  prescription: "yes" | "some" | "no"; // single-salt products ℞ / only some combinations ℞ / none
  restricted: boolean;
};

export function createKnowledgeBase(catalog: Catalog, jan: JanData | null = loadJanAushadhi()) {
  const ingredients = new Map<string, string>(); // normalized → display name
  for (const p of catalog.products) for (const i of p.ingredients) ingredients.set(normalize(i.name), i.name);
  const janIndex = (jan?.items ?? []).map((it) => ({ it, key: cleanGeneric(it.name) }));

  /** Which salt(s) does the user mean? Accepts brand names, salt names and close misspellings. */
  function salts(query: string): string[] {
    const q = normalize(query).replace(/\b\d+(\.\d+)?\s*(mg|mcg|g|ml|iu|%)?\b/g, " ").replace(/\s+/g, " ").trim();
    if (!q) return [];
    const direct = [...ingredients.keys()].filter((n) => n === q || (q.length > 7 && distance(n, q) <= 2));
    if (direct.length) return direct.map((n) => ingredients.get(n)!);
    const r = catalog.resolve(query);
    const fromProducts = r.kind === "exact" ? [r.product] : r.kind === "choose" && r.reason !== "fuzzy" ? r.options : [];
    const names = new Set(fromProducts.flatMap((p) => p.ingredients.map((i) => i.name)));
    if (names.size) return [...names];
    // Salts known only from the Jan Aushadhi list.
    const jHit = janIndex.find(({ key }) => key.split(" ").slice(0, 2).join(" ").startsWith(q) || key.startsWith(q));
    return jHit ? [jHit.it.name.split(/\s+(?:tablets?|capsules?|syrup|injection|cream|gel|ointment|drops|ip|bp|usp)\b/i)[0]] : [];
  }

  function info(salt: string): SaltInfo {
    const key = normalize(salt);
    const products = catalog.products.filter((p) => p.ingredients.some((i) => normalize(i.name) === key));
    const byComp = new Map<string, Product[]>();
    for (const p of products) {
      const k = `${normalize(p.composition)}|${p.form}|${p.release ?? ""}`;
      byComp.set(k, [...(byComp.get(k) ?? []), p]);
    }
    const jItems = janIndex.filter(({ key: k }) => k.includes(key)).map(({ it }) => it);
    return {
      salt: ingredients.get(key) ?? salt,
      products,
      sameComposition: [...byComp.values()].filter((g) => g.length > 1),
      groups: [...new Set([...products.map((p) => GROUPS[p.category] ?? p.category), ...jItems.map((j) => j.group).filter(Boolean) as string[]])],
      jan: jItems.slice(0, 6),
      prescription: products.filter((p) => p.ingredients.length === 1).some((p) => p.schedule !== "otc") ? "yes" : products.some((p) => p.schedule !== "otc") ? "some" : "no",
      restricted: products.some((p) => p.schedule === "restricted"),
    };
  }

  /** Brands with exactly the same composition, form and release as a product (not a substitution recommendation). */
  const sameAs = (p: Product) =>
    catalog.products.filter((o) => o.id !== p.id && normalize(o.composition) === normalize(p.composition) && o.form === p.form && (o.release ?? "") === (p.release ?? ""));

  type Intent = "about" | "brands" | "generic" | "strengths";
  const PATTERNS: [Intent, RegExp][] = [
    ["brands", /^(?:which |what |list )?(?:other )?brands?(?: names?)?(?: of| for)?\s+(.+?)\??$|^(.+?)\s+(?:ke |ka |ki )?brands?\??$/i],
    ["generic", /^(?:(?:what is|what's|show)\s+)?(?:the\s+)?(?:generic|cheaper|cheap|sasta|jan ?aushadhi)(?:\s+(?:version|option|alternative))?(?:\s+(?:of|for))?\s+(.+?)\??$|^(.+?)\s+(?:ka |ki )?(?:generic|sasta|jan ?aushadhi)\??$/i],
    ["strengths", /^(?:what |which )?(?:strengths?|doses? available|sizes?)(?:\s+(?:of|for))?\s+(.+?)\??$|^(.+?)\s+(?:strengths?)\??$/i],
    ["about", /^(?:what is|what's|tell me about|about|info(?:rmation)?(?: on| about)?|explain|\/info)\s+(.+?)\??$|^(.+?)\s+(?:kya hai|kya hota hai|ke baare mein)\??$/i],
  ];
  function intent(text: string): { intent: Intent; subject: string } | null {
    const t = text.trim();
    for (const [name, re] of PATTERNS) {
      const m = t.match(re);
      if (m) {
        const subject = (m[1] ?? m[2] ?? "").trim();
        if (subject) return { intent: name, subject };
      }
    }
    return null;
  }

  return { salts, info, sameAs, intent, hasJan: !!jan, janSource: jan ? `${jan.source} (${jan.asOf})` : null, janCount: jan?.items.length ?? 0 };
}
export type KnowledgeBase = ReturnType<typeof createKnowledgeBase>;

/** Short label for a product including strength, used in answers. */
export const short = (p: Product) => `${label(p)}${p.schedule === "rx" ? " ℞" : ""}`;
