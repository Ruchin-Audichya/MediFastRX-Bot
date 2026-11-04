// Pincode → area and coordinates.
// 1. The pincodes table (imported from the Government of India's All India Pincode Directory,
//    `npm run import:pincodes`, or seeded for the demo areas).
// 2. Fallback: OpenStreetMap Nominatim (postal-code search), paced to 1 request/second and cached.
// Unknown or unreachable → a clear "couldn't find that pincode" instead of a guess.
import type { DB } from "../db/db.ts";
import type { Cache, Http } from "../net/http.ts";

export type PinPlace = { pincode: string; place: string; district: string | null; state: string | null; lat: number; lng: number; source: string };
export type PinResult = { ok: true; place: PinPlace } | { ok: false; reason: "invalid" | "not-found" | "unavailable" };

export const isPincode = (s: string) => /^[1-9]\d{5}$/.test(s.trim());
const inIndia = (lat: number, lng: number) => lat > 6 && lat < 37.5 && lng > 68 && lng < 97.5;

export function createPincodes(db: DB, opts: { http?: Http; cache?: Cache; geocoder?: boolean } = {}) {
  const byPin = db.prepare("SELECT * FROM pincodes WHERE pincode = ?");
  const upsert = db.prepare("INSERT OR REPLACE INTO pincodes(pincode, place, district, state, lat, lng, source) VALUES (?,?,?,?,?,?,?)");
  const insertIfMissing = db.prepare("INSERT OR IGNORE INTO pincodes(pincode, place, district, state, lat, lng, source) VALUES (?,?,?,?,?,?,?)");

  async function lookup(raw: string): Promise<PinResult> {
    const pin = raw.trim();
    if (!isPincode(pin)) return { ok: false, reason: "invalid" };
    const row = byPin.get(pin) as PinPlace | undefined;
    if (row) return { ok: true, place: row };
    if (!opts.geocoder || !opts.http) return { ok: false, reason: "not-found" };
    const key = `nominatim:${pin}`;
    const cached = opts.cache?.get<PinPlace | "none">(key);
    if (cached === "none") return { ok: false, reason: "not-found" };
    if (cached) return { ok: true, place: cached };
    try {
      type Hit = { lat: string; lon: string; display_name: string; address?: Record<string, string> };
      const hits = await opts.http.getJson<Hit[]>(
        `https://nominatim.openstreetmap.org/search?postalcode=${pin}&countrycodes=in&format=jsonv2&addressdetails=1&limit=1`,
        { minGapMs: 1100, timeoutMs: 6000 },
      );
      const h = hits[0];
      const lat = Number(h?.lat), lng = Number(h?.lon);
      if (!h || !inIndia(lat, lng)) { opts.cache?.set(key, "none", 7 * 86_400_000); return { ok: false, reason: "not-found" }; }
      const a = h.address ?? {};
      const place: PinPlace = {
        pincode: pin,
        place: a.suburb ?? a.neighbourhood ?? a.city_district ?? a.town ?? a.city ?? a.village ?? a.county ?? h.display_name.split(",")[0],
        district: a.state_district ?? a.county ?? null,
        state: a.state ?? null,
        lat, lng, source: "OpenStreetMap Nominatim (approximate)",
      };
      upsert.run(place.pincode, place.place, place.district, place.state, place.lat, place.lng, place.source);
      return { ok: true, place };
    } catch {
      return { ok: false, reason: "unavailable" };
    }
  }

  /** Bulk import (government directory): one row per pincode, averaged over its post offices. */
  function importRows(rows: PinPlace[]) {
    db.exec("BEGIN");
    try { for (const r of rows) upsert.run(r.pincode, r.place, r.district, r.state, r.lat, r.lng, r.source); db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  function seed(rows: PinPlace[]) { for (const r of rows) insertIfMissing.run(r.pincode, r.place, r.district, r.state, r.lat, r.lng, r.source); }
  const count = () => (db.prepare("SELECT COUNT(*) n FROM pincodes").get() as { n: number }).n;

  return { lookup, importRows, seed, count };
}
export type Pincodes = ReturnType<typeof createPincodes>;

/**
 * Demo seed: well-known Jaipur pincodes mapped to the demo areas' centres. Approximate and labelled so;
 * imported government data always takes precedence.
 */
export const DEMO_PINCODES: [string, string][] = [
  ["302021", "vaishali"], ["302001", "cscheme"], ["302017", "malviya"], ["302020", "mansarovar"],
  ["302004", "rajapark"], ["302016", "banipark"], ["302023", "vidhyadhar"],
];
