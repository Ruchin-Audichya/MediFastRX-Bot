// The core flow: medicine + pincode → where can I get it.
// Step 1 confirms the exact product (strength and form are never guessed).
// Step 2 resolves the pincode. Step 3 asks every provider in parallel.
import { label, type Catalog, type Product } from "../catalog/catalog.ts";
import type { Pincodes, PinPlace } from "../geo/pincode.ts";
import { runProviders, type FindContext, type ProviderOutcome } from "./providers.ts";

type ProviderLike = { id: string; run: (c: FindContext) => Promise<ProviderOutcome<any>> };
export const productView = (p: Product) => ({ id: p.id, label: label(p), brand: p.brand, composition: p.composition, form: p.form, schedule: p.schedule, unit: p.unit, generic: p.generic });

export type FindResponse =
  | { stage: "need-medicine" }
  | { stage: "not-found"; query: string }
  | { stage: "choose"; query: string; reason: string; options: ReturnType<typeof productView>[] }
  | { stage: "need-location"; product: ReturnType<typeof productView>; error?: "invalid" | "not-found" | "unavailable" }
  | { stage: "results"; product: ReturnType<typeof productView>; place: PinPlace; providers: ProviderOutcome<any>[]; tookMs: number };

export function createFinder(catalog: Catalog, pincodes: Pincodes, providers: ProviderLike[]) {
  return async function find(input: { q?: string; productId?: string; pin?: string }): Promise<FindResponse> {
    const t0 = Date.now();
    let product: Product | undefined;
    if (input.productId) product = catalog.get(input.productId);
    if (!product) {
      const q = (input.q ?? "").trim().slice(0, 80);
      if (!q) return { stage: "need-medicine" };
      const r = catalog.resolve(q);
      if (r.kind === "none") return { stage: "not-found", query: q };
      if (r.kind === "choose") return { stage: "choose", query: q, reason: r.reason, options: r.options.map(productView) };
      product = r.product;
    }
    const pin = (input.pin ?? "").trim();
    if (!pin) return { stage: "need-location", product: productView(product) };
    const loc = await pincodes.lookup(pin);
    if (!loc.ok) return { stage: "need-location", product: productView(product), error: loc.reason };
    const outcomes = await runProviders(providers, { product, point: loc.place, place: loc.place.place });
    return { stage: "results", product: productView(product), place: loc.place, providers: outcomes, tookMs: Date.now() - t0 };
  };
}
export type Finder = ReturnType<typeof createFinder>;
