import { createHash } from "node:crypto";
import type { Answer, MediFast } from "../domain/medifast.ts";

type Profile = { reply: number; delay: number; stock: number };

/** 0..1, stable for the same inputs, so a simulated shop's shelf is consistent all day. */
const unit = (...parts: (string | number)[]) => createHash("sha256").update(parts.join("|")).digest().readUInt32BE(0) / 2 ** 32;

/**
 * Plays the fictional demo pharmacies. Each has a reply rate, typical reply delay and
 * shelf depth. It answers through the same domain calls a human pharmacist uses, and it
 * never quotes prices: inventing those would be fabricated data.
 */
export function createSimulator(mf: MediFast, opts: { speed?: number; random?: () => number } = {}) {
  const speed = opts.speed ?? 1;
  const random = opts.random ?? Math.random;
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(() => { timers.delete(t); try { fn(); } catch { /* the ask may have closed meanwhile */ } }, Math.max(0, ms * speed));
    t.unref?.();
    timers.add(t);
  };
  const profileOf = (pharmacyId: number): Profile | null => {
    const p = mf.pharmacies.get(pharmacyId);
    return p?.sim ? JSON.parse(p.sim) : null;
  };
  const day = () => new Date(mf.now()).toISOString().slice(0, 10);

  function decide(pharmacyId: number, productId: string, profile: Profile): Answer {
    const u = unit(pharmacyId, productId, day());
    if (u < profile.stock) return "have";
    const v = unit("alt", pharmacyId, productId, day());
    return v < 0.45 ? "tomorrow" : v < 0.6 ? "alt" : "no";
  }

  return {
    onRequest(recipientId: number) {
      const r = mf.answers.get(recipientId);
      if (!r) return;
      const ph = mf.pharmacies.get(r.pharmacy_id)!;
      const profile = profileOf(ph.id);
      if (!profile || random() > profile.reply) return; // some shops are busy and never answer
      const delayMs = profile.delay * 1000 * (0.6 + random() * 0.8);
      const ask = mf.asks.get(r.ask_id)!;
      // Marks arrive a beat apart, like a person checking shelves, then the answer is sent.
      ask.items.forEach((item, i) => later(delayMs * (0.4 + (0.4 * i) / ask.items.length), () => mf.answers.mark(recipientId, ph.owner_id, i, decide(ph.id, item.productId, profile))));
      later(delayMs, () => mf.answers.submit(recipientId, ph.owner_id, { fill: "no" }));
    },
    onReservation(reservationId: string, status: string) {
      if (status !== "held") return;
      const res = mf.reservations.get(reservationId)!;
      const owner = mf.pharmacies.get(res.pharmacy_id)!.owner_id;
      later(12_000 + random() * 10_000, () => mf.reservations.update(reservationId, owner, "ready"));
    },
    stop() { timers.forEach(clearTimeout); timers.clear(); },
  };
}
