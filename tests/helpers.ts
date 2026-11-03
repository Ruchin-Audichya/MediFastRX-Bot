import { openDatabase } from "../src/db/db.ts";
import { createCatalog } from "../src/catalog/catalog.ts";
import { createMediFast } from "../src/domain/medifast.ts";
import { seedDemo } from "../src/domain/seed.ts";

export const catalog = createCatalog();
export function world() {
  let t = Date.UTC(2026, 10, 3, 10, 0, 0);
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  const mf = createMediFast(openDatabase(":memory:"), catalog, { now: clock.now });
  const { customer, admin } = seedDemo(mf);
  const VAISHALI = { lat: 26.9116, lng: 75.7425, place: "Vaishali Nagar" };
  const ownerOf = (recipientId: number) => mf.pharmacies.get(mf.answers.get(recipientId)!.pharmacy_id)!.owner_id;
  return { mf, clock, customer, admin, VAISHALI, ownerOf };
}
export const flush = () => new Promise((r) => setImmediate(r));
