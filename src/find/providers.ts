// Where can I get this medicine? Each provider answers for one product at one place, and says
// exactly how much it knows. Nothing here ever claims stock or a price it didn't get from a
// pharmacist or the provider itself.
import type { Product } from "../catalog/catalog.ts";
import type { MediFast } from "../domain/medifast.ts";
import { distanceM, type Point } from "../domain/geo.ts";
import type { Cache, Http } from "../net/http.ts";

export type Verification =
  | "pharmacist-confirms"   // a participating pharmacist answers this specific request
  | "location-only"         // we know the shop exists here; stock unknown
  | "not-checked";          // we open the provider's own search; availability and price not checked

export type NetworkResult = { kind: "network"; partners: number; nearestM: number | null; radiusKm: number; canAsk: boolean };
export type Place = { name: string; lat: number; lng: number; distanceM: number; phone: string | null; hours: string | null; address: string | null; osmUrl: string };
export type DirectoryResult = { kind: "directory"; places: Place[]; radiusKm: number; source: string };
export type OnlineLink = { id: string; name: string; url: string; type: "pharmacy" | "quick-commerce"; note: string; affiliate: boolean };
export type OnlineResult = { kind: "online"; links: OnlineLink[] };

export type ProviderOutcome<T> =
  | { id: string; status: "ok"; verification: Verification; data: T }
  | { id: string; status: "empty"; verification: Verification; message: string }
  | { id: string; status: "unavailable"; verification: Verification; message: string }
  | { id: string; status: "skipped"; verification: Verification; message: string };

export type FindContext = { product: Product; point: Point; place: string };

/** Participating pharmacies (answers confirmed by a pharmacist for each request). */
export function networkProvider(mf: MediFast) {
  return {
    id: "network" as const,
    async run({ product, point }: FindContext): Promise<ProviderOutcome<NetworkResult>> {
      if (product.schedule === "restricted")
        return { id: "network", status: "skipped", verification: "pharmacist-confirms", message: "Habit-forming medicines aren't broadcast to pharmacies. Please ask a pharmacist directly with your prescription." };
      for (const radiusKm of [2, 5]) {
        const near = mf.pharmacies.nearby(point, radiusKm);
        if (near.length) return { id: "network", status: "ok", verification: "pharmacist-confirms", data: { kind: "network", partners: Math.min(near.length, 12), nearestM: near[0].distance, radiusKm, canAsk: true } };
      }
      return { id: "network", status: "empty", verification: "pharmacist-confirms", message: "No participating pharmacy within 5 km yet." };
    },
  };
}

/** Real pharmacies from OpenStreetMap (Overpass API). Location and contact only, never stock. */
export function directoryProvider(http: Http | null, cache: Cache | null, opts: { enabled: boolean; endpoint?: string }) {
  const endpoint = opts.endpoint ?? "https://overpass-api.de/api/interpreter";
  type El = { lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string>; type: string; id: number };
  return {
    id: "directory" as const,
    async run({ point }: FindContext): Promise<ProviderOutcome<DirectoryResult>> {
      if (!opts.enabled || !http) return { id: "directory", status: "skipped", verification: "location-only", message: "Nearby pharmacy listings are turned off on this server." };
      const radiusKm = 3;
      const key = `osm-pharmacy:${point.lat.toFixed(3)},${point.lng.toFixed(3)}:${radiusKm}`;
      let els = cache?.get<El[]>(key);
      if (!els) {
        try {
          const q = `[out:json][timeout:10];(node["amenity"="pharmacy"](around:${radiusKm * 1000},${point.lat},${point.lng});way["amenity"="pharmacy"](around:${radiusKm * 1000},${point.lat},${point.lng}););out center tags 60;`;
          const res = await http.getJson<{ elements: El[] }>(endpoint, { method: "POST", body: `data=${encodeURIComponent(q)}`, headers: { "content-type": "application/x-www-form-urlencoded" }, timeoutMs: 8000, minGapMs: 1000 });
          els = res.elements ?? [];
          cache?.set(key, els, 24 * 3_600_000);
        } catch {
          return { id: "directory", status: "unavailable", verification: "location-only", message: "Couldn't load nearby pharmacies from OpenStreetMap right now." };
        }
      }
      const places: Place[] = els
        .map((e): Place | null => {
          const lat = e.lat ?? e.center?.lat, lng = e.lon ?? e.center?.lon, t = e.tags ?? {};
          if (lat == null || lng == null) return null;
          const address = [t["addr:housenumber"], t["addr:street"], t["addr:suburb"] ?? t["addr:city"]].filter(Boolean).join(", ") || null;
          return { name: t.name ?? t["name:en"] ?? "Pharmacy (name not listed)", lat, lng, distanceM: distanceM(point, { lat, lng }), phone: t.phone ?? t["contact:phone"] ?? null, hours: t.opening_hours ?? null, address, osmUrl: `https://www.openstreetmap.org/${e.type}/${e.id}` };
        })
        .filter((p): p is Place => !!p)
        .sort((a, b) => a.distanceM - b.distanceM)
        .slice(0, 15);
      if (!places.length) return { id: "directory", status: "empty", verification: "location-only", message: `No pharmacies are mapped on OpenStreetMap within ${radiusKm} km.` };
      return { id: "directory", status: "ok", verification: "location-only", data: { kind: "directory", places, radiusKm, source: "© OpenStreetMap contributors" } };
    },
  };
}

/**
 * Online platforms. We open each platform's own search for the exact product name; we do not
 * scrape them, and we never show their stock or price. Blinkit is listed last, as a fallback.
 * Affiliate parameters (AFFILIATE_<ID>="key=value") are disclosed on the page when set.
 */
export const ONLINE_PLATFORMS: { id: string; name: string; type: OnlineLink["type"]; url: (q: string) => string }[] = [
  { id: "1mg", name: "Tata 1mg", type: "pharmacy", url: (q) => `https://www.1mg.com/search/all?name=${encodeURIComponent(q)}` },
  { id: "pharmeasy", name: "PharmEasy", type: "pharmacy", url: (q) => `https://pharmeasy.in/search/all?name=${encodeURIComponent(q)}` },
  { id: "apollo", name: "Apollo 24|7", type: "pharmacy", url: (q) => `https://www.apollopharmacy.in/search-medicines/${encodeURIComponent(q)}` },
  { id: "netmeds", name: "Netmeds", type: "pharmacy", url: (q) => `https://www.netmeds.com/catalogsearch/result/${encodeURIComponent(q)}/all` },
  { id: "blinkit", name: "Blinkit", type: "quick-commerce", url: (q) => `https://blinkit.com/s/?q=${encodeURIComponent(q)}` },
];

export function onlineProvider(affiliates: Record<string, string> = {}) {
  return {
    id: "online" as const,
    async run({ product }: FindContext): Promise<ProviderOutcome<OnlineResult>> {
      if (product.schedule === "restricted")
        return { id: "online", status: "skipped", verification: "not-checked", message: "Habit-forming medicine: buy it only from a pharmacist with your prescription." };
      const q = product.brand.replace(/\s*\(generic\)/i, "");
      const rx = product.schedule === "rx";
      const links: OnlineLink[] = ONLINE_PLATFORMS.map((p) => {
        let url = p.url(q);
        const aff = affiliates[p.id];
        if (aff) url += (url.includes("?") ? "&" : "?") + aff;
        const note = p.type === "quick-commerce"
          ? "Quick delivery where it serves your area. Stock depends on your exact location."
          : rx ? "Delivers to most pincodes. Upload your prescription when ordering." : "Delivers to most pincodes.";
        return { id: p.id, name: p.name, url, type: p.type, note, affiliate: !!aff };
      });
      return { id: "online", status: "ok", verification: "not-checked", data: { kind: "online", links } };
    },
  };
}

/** Run every provider in parallel; one failing or slow provider never breaks the others. */
export async function runProviders<T extends { id: string; run: (c: FindContext) => Promise<ProviderOutcome<any>> }>(providers: T[], ctx: FindContext, timeoutMs = 9000) {
  return Promise.all(providers.map(async (p) => {
    try {
      return await Promise.race([
        p.run(ctx),
        new Promise<ProviderOutcome<never>>((r) => setTimeout(() => r({ id: p.id, status: "unavailable", verification: "not-checked", message: "Took too long to answer." }), timeoutMs)),
      ]);
    } catch {
      return { id: p.id, status: "unavailable", verification: "not-checked", message: "Something went wrong with this source." } as ProviderOutcome<never>;
    }
  }));
}
