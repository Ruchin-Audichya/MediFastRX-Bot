import { readFileSync } from "node:fs";
import type { MediFast } from "./medifast.ts";

export type DemoPharmacy = {
  key: string; name: string; area: string; address: string; lat: number; lng: number;
  studio?: boolean; sim?: { reply: number; delay: number; stock: number };
};
export type Area = { id: string; name: string; lat: number; lng: number };

export const AREAS: Area[] = JSON.parse(readFileSync(new URL("../../data/areas.json", import.meta.url), "utf8"));
export const DEMO_PHARMACIES: DemoPharmacy[] = JSON.parse(readFileSync(new URL("../../data/demo-pharmacies.json", import.meta.url), "utf8"));

export const STUDIO = {
  customer: "studio:1001",
  pharmacist: "studio:1002",
  admin: "studio:1003",
} as const;

/**
 * Idempotently creates the fictional demo network: one studio customer, one studio
 * pharmacist (a human drives them in Demo Studio), simulated pharmacists for the rest,
 * and a studio admin. Every demo pharmacy is flagged `demo` and says "fictional".
 */
export function seedDemo(mf: MediFast) {
  const customer = mf.users.upsert({ ref: STUDIO.customer, transport: "studio", chatId: "1001", name: "Aarav (demo)" });
  const admin = mf.users.upsert({ ref: STUDIO.admin, transport: "studio", chatId: "1003", name: "Admin (demo)" });
  mf.users.setAdmin(admin.id, true);
  for (const [i, p] of DEMO_PHARMACIES.entries()) {
    const owner = p.studio
      ? mf.users.upsert({ ref: STUDIO.pharmacist, transport: "studio", chatId: "1002", name: "Ravi · Pinkcity (demo)" })
      : mf.users.upsert({ ref: `sim:${p.key}`, transport: "sim", chatId: `sim-${p.key}`, name: `${p.name} (simulated)` });
    if (mf.pharmacies.byOwner(owner.id)) continue;
    mf.pharmacies.register(
      owner.id,
      { name: p.name, area: p.area, address: p.address, lat: p.lat, lng: p.lng, phone: `+9100000000${String(i).padStart(2, "0")}`, license: `DEMO-RJ-${1000 + i}` },
      { demo: true, approved: true, sim: p.sim },
    );
  }
  return { customer, admin };
}
