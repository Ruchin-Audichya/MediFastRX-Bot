import { EventEmitter } from "node:events";
import { randomInt } from "node:crypto";
import { transaction, type DB } from "../db/db.ts";
import { label, type Catalog, type Product } from "../catalog/catalog.ts";
import { distanceM, validPoint, type Point } from "./geo.ts";

// ───────────────────────────── Types ─────────────────────────────

export type Transport = "live" | "studio" | "sim" | "web";
export type User = {
  id: number; ref: string; transport: Transport; chat_id: string; name: string; username: string | null;
  is_admin: number; lat: number | null; lng: number | null; place: string | null; radius_km: number;
};
export type Pharmacy = {
  id: number; owner_id: number; name: string; area: string; address: string; lat: number; lng: number;
  phone: string; license: string; status: "pending" | "approved" | "rejected" | "suspended";
  accepting: number; demo: number; sim: string | null; created_at: number;
};
export type Item = {
  productId: string; label: string; brand: string; composition: string; form: string;
  unit: string; schedule: Product["schedule"]; qty: number;
};
export type Answer = "have" | "tomorrow" | "alt" | "no";
export const ANSWERS: Answer[] = ["have", "tomorrow", "alt", "no"];
export type AskStatus = "open" | "reserved" | "expired" | "cancelled";
export type Ask = {
  id: string; customer_id: number; items: Item[]; lat: number; lng: number; place: string;
  radius_km: number; status: AskStatus; created_at: number; expires_at: number; closed_at: number | null;
  board_ref: string | null;
};
export type RecipientState = "pending" | "answered" | "expired" | "closed" | "chosen";
export type Recipient = {
  id: number; ask_id: string; pharmacy_id: number; distance_m: number; state: RecipientState;
  draft: (Answer | null)[]; answers: Answer[] | null; price: number | null; note: string | null;
  revision: number; notified_at: number; answered_at: number | null; message_ref: string | null;
};
export type ReservationStatus = "held" | "ready" | "collected" | "cancelled" | "declined" | "expired";
export type Reservation = {
  id: string; ask_id: string; recipient_id: number; pharmacy_id: number; customer_id: number;
  items: { index: number; when: "now" | "tomorrow" }[]; code: string; status: ReservationStatus;
  hold_until: number; created_at: number; updated_at: number; customer_ref: string | null; pharmacy_ref: string | null;
};
export type DraftItem = { productId: string; qty: number };
export type Plan = { recipientId: number; items: number[] }[];

export class DomainError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
const fail = (code: string, message: string): never => { throw new DomainError(code, message); };

export type Events = {
  "ask.created": { askId: string };
  "ask.updated": { askId: string };
  "recipient.changed": { recipientId: number };
  "ask.closed": { askId: string; reason: "reserved" | "expired" | "cancelled" };
  "reservation.changed": { reservationId: string; status: ReservationStatus; by: "customer" | "pharmacy" | "system" };
  "pharmacy.submitted": { pharmacyId: number };
  "pharmacy.reviewed": { pharmacyId: number };
};

export const LIMITS = {
  maxItems: 10,
  maxRecipients: 12,
  openAsksPerCustomer: 2,
  asksPerDay: 12,
  askTtlMs: 30 * 60_000,
  holdMs: 3 * 60 * 60_000,
  radiusKm: [1, 2, 5] as const,
};

// ───────────────────────────── Service ─────────────────────────────

export function createMediFast(db: DB, catalog: Catalog, opts: { now?: () => number } = {}) {
  const now = opts.now ?? Date.now;
  const bus = new EventEmitter();
  bus.setMaxListeners(50);
  const emit = <K extends keyof Events>(k: K, v: Events[K]) => queueMicrotask(() => bus.emit(k, v));
  const on = <K extends keyof Events>(k: K, fn: (v: Events[K]) => void) => bus.on(k, fn);
  const off = <K extends keyof Events>(k: K, fn: (v: Events[K]) => void) => bus.off(k, fn);

  const q = (sql: string) => db.prepare(sql);
  const log = (askId: string | null, kind: string, actor: number | null, data?: unknown) =>
    q("INSERT INTO events(ask_id, kind, actor, data, at) VALUES (?,?,?,?,?)").run(askId, kind, actor, data ? JSON.stringify(data) : null, now());

  const parseAsk = (r: any): Ask => r && { ...r, items: JSON.parse(r.items) };
  const parseRecipient = (r: any): Recipient =>
    r && { ...r, draft: r.draft ? JSON.parse(r.draft) : [], answers: r.answers ? JSON.parse(r.answers) : null };
  const parseReservation = (r: any): Reservation => r && { ...r, items: JSON.parse(r.items) };

  // ── Users
  const users = {
    upsert(input: { ref: string; transport: Transport; chatId: string; name: string; username?: string | null }): User {
      q(`INSERT INTO users(ref, transport, chat_id, name, username, created_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(ref) DO UPDATE SET chat_id = excluded.chat_id, name = excluded.name, username = excluded.username`)
        .run(input.ref, input.transport, input.chatId, input.name.slice(0, 64), input.username ?? null, now());
      return q("SELECT * FROM users WHERE ref = ?").get(input.ref) as User;
    },
    get: (id: number) => q("SELECT * FROM users WHERE id = ?").get(id) as User | undefined,
    byRef: (ref: string) => q("SELECT * FROM users WHERE ref = ?").get(ref) as User | undefined,
    setAdmin: (id: number, on: boolean) => q("UPDATE users SET is_admin = ? WHERE id = ?").run(on ? 1 : 0, id),
    admins: () => q("SELECT * FROM users WHERE is_admin = 1").all() as User[],
    setLocation(id: number, p: Point & { place: string }) {
      if (!validPoint(p)) fail("bad-location", "That location doesn't look right.");
      q("UPDATE users SET lat = ?, lng = ?, place = ? WHERE id = ?").run(p.lat, p.lng, p.place.slice(0, 80), id);
    },
    setRadius(id: number, radius: number) {
      if (!LIMITS.radiusKm.includes(radius as 1)) fail("bad-radius", "Choose 1, 2 or 5 km.");
      q("UPDATE users SET radius_km = ? WHERE id = ?").run(radius, id);
    },
    forget(id: number) {
      transaction(db, () => {
        q("UPDATE users SET lat = NULL, lng = NULL, place = NULL WHERE id = ?").run(id);
        q("DELETE FROM drafts WHERE user_id = ?").run(id);
        q("DELETE FROM saved WHERE user_id = ?").run(id);
        q("DELETE FROM chat_state WHERE user_id = ?").run(id);
      });
    },
    getState: (id: number) => {
      const r = q("SELECT state FROM chat_state WHERE user_id = ?").get(id) as { state: string } | undefined;
      return r ? JSON.parse(r.state) : null;
    },
    setState: (id: number, state: unknown) =>
      state == null
        ? q("DELETE FROM chat_state WHERE user_id = ?").run(id)
        : q("INSERT OR REPLACE INTO chat_state(user_id, state, updated_at) VALUES (?,?,?)").run(id, JSON.stringify(state), now()),
  };

  // ── Draft list (what the customer is about to ask for)
  const drafts = {
    get(userId: number): DraftItem[] {
      const r = q("SELECT items FROM drafts WHERE user_id = ?").get(userId) as { items: string } | undefined;
      return r ? (JSON.parse(r.items) as DraftItem[]).filter((i) => catalog.get(i.productId)) : [];
    },
    set(userId: number, items: DraftItem[]) {
      q("INSERT OR REPLACE INTO drafts(user_id, items, updated_at) VALUES (?,?,?)").run(userId, JSON.stringify(items), now());
      return items;
    },
    add(userId: number, productId: string, qty = 1) {
      const product = catalog.get(productId) ?? fail("unknown-product", "That product isn't in the catalog.");
      if (product.schedule === "restricted")
        fail("restricted", `${product.brand} is habit-forming, so MediFast doesn't broadcast it. Please ask your pharmacist directly with your prescription.`);
      const items = drafts.get(userId);
      const existing = items.find((i) => i.productId === productId);
      if (existing) existing.qty = Math.min(20, existing.qty + qty);
      else {
        if (items.length >= LIMITS.maxItems) fail("too-many", `A request can hold up to ${LIMITS.maxItems} medicines.`);
        items.push({ productId, qty: Math.min(20, Math.max(1, qty)) });
      }
      return drafts.set(userId, items);
    },
    change(userId: number, productId: string, delta: number) {
      const items = drafts.get(userId)
        .map((i) => (i.productId === productId ? { ...i, qty: Math.min(20, i.qty + delta) } : i))
        .filter((i) => i.qty > 0);
      return drafts.set(userId, items);
    },
    remove: (userId: number, productId: string) => drafts.set(userId, drafts.get(userId).filter((i) => i.productId !== productId)),
    clear: (userId: number) => q("DELETE FROM drafts WHERE user_id = ?").run(userId),
  };

  // ── Saved medicines (one-tap refills)
  const saved = {
    list: (userId: number) =>
      (q("SELECT product_id, qty FROM saved WHERE user_id = ? ORDER BY saved_at DESC").all(userId) as { product_id: string; qty: number }[])
        .filter((r) => catalog.get(r.product_id))
        .map((r) => ({ product: catalog.get(r.product_id)!, qty: r.qty })),
    save(userId: number, items: DraftItem[]) {
      const stmt = q("INSERT OR REPLACE INTO saved(user_id, product_id, qty, saved_at) VALUES (?,?,?,?)");
      transaction(db, () => items.forEach((i) => stmt.run(userId, i.productId, i.qty, now())));
    },
    remove: (userId: number, productId: string) => q("DELETE FROM saved WHERE user_id = ? AND product_id = ?").run(userId, productId),
  };

  // ── Pharmacies
  const pharmacies = {
    get: (id: number) => q("SELECT * FROM pharmacies WHERE id = ?").get(id) as Pharmacy | undefined,
    byOwner: (userId: number) => q("SELECT * FROM pharmacies WHERE owner_id = ?").get(userId) as Pharmacy | undefined,
    list: (status?: Pharmacy["status"]) =>
      (status ? q("SELECT * FROM pharmacies WHERE status = ? ORDER BY created_at").all(status) : q("SELECT * FROM pharmacies ORDER BY name").all()) as Pharmacy[],
    register(ownerId: number, input: { name: string; area: string; address: string; lat: number; lng: number; phone: string; license: string }, extra: { demo?: boolean; sim?: unknown; approved?: boolean } = {}) {
      const name = String(input.name ?? "").trim();
      const phone = String(input.phone ?? "").replace(/[^\d+]/g, "");
      const license = String(input.license ?? "").trim();
      if (name.length < 3 || name.length > 80) fail("bad-name", "Shop name should be 3–80 characters.");
      if (!/^\+?\d{10,13}$/.test(phone)) fail("bad-phone", "Phone number should have 10–13 digits.");
      if (license.length < 4 || license.length > 40) fail("bad-license", "Drug licence number looks too short.");
      if (!validPoint(input)) fail("bad-location", "Shop location is missing.");
      if (pharmacies.byOwner(ownerId)) fail("exists", "This account already has a pharmacy.");
      const r = q(`INSERT INTO pharmacies(owner_id, name, area, address, lat, lng, phone, license, status, demo, sim, created_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        ownerId, name, String(input.area || "").slice(0, 60), String(input.address || "").slice(0, 160), input.lat, input.lng,
        phone, license, extra.approved ? "approved" : "pending", extra.demo ? 1 : 0, extra.sim ? JSON.stringify(extra.sim) : null, now());
      const id = Number(r.lastInsertRowid);
      log(null, "pharmacy.submitted", ownerId, { pharmacyId: id });
      if (!extra.approved) emit("pharmacy.submitted", { pharmacyId: id });
      return pharmacies.get(id)!;
    },
    review(id: number, adminId: number, decision: "approved" | "rejected" | "suspended") {
      const admin = users.get(adminId);
      if (!admin?.is_admin) fail("forbidden", "Only an admin can review pharmacies.");
      const p = pharmacies.get(id) ?? fail("not-found", "Pharmacy not found.");
      q("UPDATE pharmacies SET status = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?").run(decision, now(), adminId, p.id);
      log(null, `pharmacy.${decision}`, adminId, { pharmacyId: id });
      emit("pharmacy.reviewed", { pharmacyId: id });
      return pharmacies.get(id)!;
    },
    setAccepting(ownerId: number, on: boolean) {
      const p = pharmacies.byOwner(ownerId) ?? fail("not-pharmacist", "No pharmacy on this account.");
      q("UPDATE pharmacies SET accepting = ? WHERE id = ?").run(on ? 1 : 0, p.id);
      return pharmacies.get(p.id)!;
    },
    nearby(p: Point, radiusKm: number) {
      return (q("SELECT * FROM pharmacies WHERE status = 'approved' AND accepting = 1").all() as Pharmacy[])
        .map((ph) => ({ pharmacy: ph, distance: distanceM(p, ph) }))
        .filter((x) => x.distance <= radiusKm * 1000)
        .sort((a, b) => a.distance - b.distance);
    },
    stats(id: number) {
      const rows = q("SELECT state, notified_at, answered_at FROM recipients WHERE pharmacy_id = ?").all(id) as { state: string; notified_at: number; answered_at: number | null }[];
      const answered = rows.filter((r) => r.answered_at);
      const times = answered.map((r) => r.answered_at! - r.notified_at).sort((a, b) => a - b);
      const res = q("SELECT status, COUNT(*) n FROM reservations WHERE pharmacy_id = ? GROUP BY status").all(id) as { status: string; n: number }[];
      const count = (s: string) => res.find((r) => r.status === s)?.n ?? 0;
      return {
        received: rows.length,
        answered: answered.length,
        responseRate: rows.length ? answered.length / rows.length : null,
        medianResponseMs: times.length ? times[Math.floor(times.length / 2)] : null,
        reservations: res.reduce((a, r) => a + r.n, 0),
        collected: count("collected"),
      };
    },
  };

  // ── Asks
  function snapshot(d: DraftItem): Item {
    const p = catalog.get(d.productId) ?? fail("unknown-product", "A medicine on the list is no longer in the catalog.");
    if (p.schedule === "restricted") fail("restricted", `${p.brand} can't be broadcast.`);
    return { productId: p.id, label: label(p), brand: p.brand, composition: p.composition, form: p.form, unit: p.unit, schedule: p.schedule, qty: d.qty };
  }

  const getAsk = (id: string) => parseAsk(q("SELECT * FROM asks WHERE id = ?").get(id)) as Ask | undefined;
  const recipientsOf = (askId: string) =>
    (q("SELECT * FROM recipients WHERE ask_id = ? ORDER BY distance_m").all(askId) as any[]).map(parseRecipient);
  const getRecipient = (id: number) => parseRecipient(q("SELECT * FROM recipients WHERE id = ?").get(id)) as Recipient | undefined;
  const reservationsOf = (askId: string) =>
    (q("SELECT * FROM reservations WHERE ask_id = ? ORDER BY created_at").all(askId) as any[]).map(parseReservation);
  const getReservation = (id: string) => parseReservation(q("SELECT * FROM reservations WHERE id = ?").get(id)) as Reservation | undefined;

  const newId = (len = 6) => Array.from({ length: len }, () => "abcdefghjkmnpqrstuvwxyz23456789"[randomInt(31)]).join("");

  function createAsk(customerId: number, input: { items: DraftItem[]; lat: number; lng: number; place: string; radiusKm: number }) {
    return transaction(db, () => {
      if (!input.items.length) fail("empty", "Add at least one medicine first.");
      if (input.items.length > LIMITS.maxItems) fail("too-many", `Up to ${LIMITS.maxItems} medicines per request.`);
      if (!validPoint(input)) fail("no-location", "Share your location or pick an area first.");
      const items = input.items.map(snapshot);
      const open = (q("SELECT COUNT(*) n FROM asks WHERE customer_id = ? AND status = 'open'").get(customerId) as { n: number }).n;
      if (open >= LIMITS.openAsksPerCustomer) fail("too-many-open", "You already have requests waiting for answers. Cancel one or wait a few minutes.");
      const today = (q("SELECT COUNT(*) n FROM asks WHERE customer_id = ? AND created_at > ?").get(customerId, now() - 86_400_000) as { n: number }).n;
      if (today >= LIMITS.asksPerDay) fail("daily-limit", "That's a lot of requests today. Please try again tomorrow.");
      const near = pharmacies.nearby(input, input.radiusKm).filter((n) => n.pharmacy.owner_id !== customerId).slice(0, LIMITS.maxRecipients);
      if (!near.length) fail("no-pharmacies", `No participating pharmacy within ${input.radiusKm} km yet. Try a wider radius.`);
      const id = newId();
      const t = now();
      q(`INSERT INTO asks(id, customer_id, items, lat, lng, place, radius_km, status, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, customerId, JSON.stringify(items), input.lat, input.lng, input.place.slice(0, 80), input.radiusKm, "open", t, t + LIMITS.askTtlMs);
      const ins = q("INSERT INTO recipients(ask_id, pharmacy_id, distance_m, state, draft, notified_at) VALUES (?,?,?,?,?,?)");
      for (const n of near) ins.run(id, n.pharmacy.id, n.distance, "pending", JSON.stringify(items.map(() => null)), t);
      log(id, "ask.created", customerId, { recipients: near.length, items: items.length });
      emit("ask.created", { askId: id });
      return getAsk(id)!;
    });
  }

  function cancelAsk(askId: string, customerId: number) {
    return transaction(db, () => {
      const ask = getAsk(askId) ?? fail("not-found", "Request not found.");
      if (ask.customer_id !== customerId) fail("forbidden", "That isn't your request.");
      if (ask.status !== "open") return ask;
      q("UPDATE asks SET status = 'cancelled', closed_at = ? WHERE id = ?").run(now(), askId);
      q("UPDATE recipients SET state = 'closed' WHERE ask_id = ? AND state IN ('pending','answered')").run(askId);
      log(askId, "ask.cancelled", customerId);
      emit("ask.closed", { askId, reason: "cancelled" });
      return getAsk(askId)!;
    });
  }

  function ownedRecipient(recipientId: number, actorId: number) {
    const r = getRecipient(recipientId) ?? fail("not-found", "Request not found.");
    const ph = pharmacies.get(r.pharmacy_id)!;
    if (ph.owner_id !== actorId) fail("forbidden", "This request was sent to another pharmacy.");
    const ask = getAsk(r.ask_id)!;
    return { r, ph, ask };
  }

  /** Pharmacist taps one item. Marks stay private until submitted. */
  function mark(recipientId: number, actorId: number, index: number, answer: Answer) {
    return transaction(db, () => {
      const { r, ask } = ownedRecipient(recipientId, actorId);
      if (ask.status !== "open") fail("closed", "This request is closed.");
      if (!ANSWERS.includes(answer) || !(index >= 0 && index < ask.items.length)) fail("bad-answer", "Unknown answer.");
      const draft = ask.items.map((_, i) => r.draft[i] ?? r.answers?.[i] ?? null);
      draft[index] = answer;
      q("UPDATE recipients SET draft = ? WHERE id = ?").run(JSON.stringify(draft), recipientId);
      emit("recipient.changed", { recipientId });
      return getRecipient(recipientId)!;
    });
  }

  /** Submit (or revise) a pharmacy's answer. `all` answers every item; `fill` answers only unmarked ones. */
  function answer(recipientId: number, actorId: number, opts: { all?: Answer; fill?: Answer; price?: number | null; note?: string | null } = {}) {
    return transaction(db, () => {
      const { r, ask } = ownedRecipient(recipientId, actorId);
      if (ask.status !== "open") fail("closed", "The customer has already chosen, or the request expired. Thank you!");
      const answers = ask.items.map((_, i) => opts.all ?? r.draft[i] ?? opts.fill ?? null);
      if (answers.some((a) => !a)) fail("incomplete", "Mark every item first.");
      const price = opts.price === undefined ? r.price : opts.price;
      if (price != null && !(price > 0 && price < 1_000_000)) fail("bad-price", "Price should be a positive amount in rupees.");
      const t = now();
      q("UPDATE recipients SET answers = ?, draft = ?, state = 'answered', price = ?, note = ?, revision = revision + 1, answered_at = COALESCE(answered_at, ?) WHERE id = ?")
        .run(JSON.stringify(answers), JSON.stringify(answers), price ?? null, (opts.note ?? r.note)?.slice(0, 200) ?? null, t, recipientId);
      log(ask.id, r.state === "answered" ? "answer.revised" : "answer.submitted", actorId, { recipientId, answers, price });
      emit("ask.updated", { askId: ask.id });
      emit("recipient.changed", { recipientId });
      return getRecipient(recipientId)!;
    });
  }

  /** Re-open a sent answer for changes. The customer keeps seeing the old answer until it's re-sent. */
  function edit(recipientId: number, actorId: number) {
    return transaction(db, () => {
      const { r, ask } = ownedRecipient(recipientId, actorId);
      if (ask.status !== "open") fail("closed", "This request is closed.");
      if (r.state !== "answered") return r;
      q("UPDATE recipients SET state = 'pending' WHERE id = ?").run(recipientId);
      emit("recipient.changed", { recipientId });
      return getRecipient(recipientId)!;
    });
  }

  function setPrice(recipientId: number, actorId: number, price: number | null) {
    return transaction(db, () => {
      const { r, ask } = ownedRecipient(recipientId, actorId);
      if (ask.status !== "open") fail("closed", "This request is closed.");
      if (price != null && !(price > 0 && price < 1_000_000)) fail("bad-price", "Price should be a positive amount in rupees.");
      q("UPDATE recipients SET price = ? WHERE id = ?").run(price, recipientId);
      if (r.state === "answered") emit("ask.updated", { askId: ask.id });
      emit("recipient.changed", { recipientId });
      return getRecipient(recipientId)!;
    });
  }

  // ── Board: the computed live view both channels render
  function board(askId: string) {
    const ask = getAsk(askId) ?? fail("not-found", "Request not found.");
    const rows = recipientsOf(askId).map((r) => {
      const ph = pharmacies.get(r.pharmacy_id)!;
      const a = r.answers;
      const count = (s: Answer) => (a ? a.filter((x) => x === s).length : 0);
      const have = count("have"), tomorrow = count("tomorrow"), alt = count("alt");
      return {
        recipientId: r.id, state: r.state, distanceM: r.distance_m, answers: a, price: r.price, note: r.note,
        responseMs: r.answered_at ? r.answered_at - r.notified_at : null,
        have, tomorrow, alt, complete: !!a && have === ask.items.length,
        reservable: !!a && have + tomorrow > 0,
        pharmacy: { id: ph.id, name: ph.name, area: ph.area, address: ph.address, lat: ph.lat, lng: ph.lng, phone: ph.phone, demo: !!ph.demo },
      };
    });
    const answered = rows.filter((r) => r.answers);
    answered.sort((x, y) => Number(y.complete) - Number(x.complete) || y.have - x.have || y.tomorrow - x.tomorrow || x.distanceM - y.distanceM);
    const ordered = [...answered, ...rows.filter((r) => !r.answers)];
    return {
      ask: { ...ask, board_ref: undefined },
      rows: ordered,
      counts: {
        asked: rows.length,
        answered: answered.length,
        waiting: rows.filter((r) => r.state === "pending").length,
        complete: answered.filter((r) => r.complete).length,
      },
      best: answered.filter((r) => r.reservable).slice(0, 3),
      split: answered.some((r) => r.complete) ? null : splitBasket(ask.items.length, answered),
      reservations: reservationsOf(askId),
      fastestMs: answered.length ? Math.min(...answered.map((r) => r.responseMs!)) : null,
    };
  }
  type SplitRow = { recipientId: number; distanceM: number; have: number; answers: Answer[] | null };

  /** Cheapest two-shop cover of every item that's available now, minimising total distance. */
  function splitBasket(n: number, rows: SplitRow[]): { parts: { recipientId: number; items: number[] }[]; distanceM: number } | null {
    const usable = rows.filter((r) => r.have > 0);
    let best: { parts: { recipientId: number; items: number[] }[]; distanceM: number } | null = null;
    for (let i = 0; i < usable.length; i++)
      for (let j = i + 1; j < usable.length; j++) {
        const [a, b] = [usable[i], usable[j]].sort((x, y) => x.distanceM - y.distanceM);
        const aItems: number[] = [], bItems: number[] = [];
        let ok = true;
        for (let k = 0; k < n; k++) {
          if (a.answers![k] === "have") aItems.push(k);
          else if (b.answers![k] === "have") bItems.push(k);
          else { ok = false; break; }
        }
        if (!ok || !aItems.length || !bItems.length) continue;
        const d = a.distanceM + b.distanceM;
        if (!best || d < best.distanceM) best = { parts: [{ recipientId: a.recipientId, items: aItems }, { recipientId: b.recipientId, items: bItems }], distanceM: d };
      }
    return best;
  }

  /** Default plan for "reserve at this pharmacy": everything they have now or by tomorrow. */
  function planFor(askId: string, recipientId: number): Plan {
    const r = getRecipient(recipientId);
    if (!r || r.ask_id !== askId || !r.answers) fail("not-answered", "That pharmacy hasn't answered yet.");
    const items = r!.answers!.flatMap((a, i) => (a === "have" || a === "tomorrow" ? [i] : []));
    if (!items.length) fail("nothing", "That pharmacy doesn't have anything on your list.");
    return [{ recipientId, items }];
  }

  function reserve(askId: string, customerId: number, plan: Plan) {
    return transaction(db, () => {
      const ask = getAsk(askId) ?? fail("not-found", "Request not found.");
      if (ask.customer_id !== customerId) fail("forbidden", "That isn't your request.");
      if (ask.status === "reserved") fail("already", "You've already reserved for this request.");
      if (ask.status !== "open") fail("closed", "This request has expired. Send it again to get fresh answers.");
      if (!plan.length || plan.length > 2) fail("bad-plan", "Choose one pharmacy, or a two-shop split.");
      const seen = new Set<number>();
      const created: Reservation[] = [];
      for (const part of plan) {
        const r = getRecipient(part.recipientId);
        if (!r || r.ask_id !== askId || !r.answers) fail("not-answered", "That pharmacy hasn't answered.");
        const items = part.items.map((index) => {
          if (seen.has(index)) fail("bad-plan", "An item can only be reserved at one pharmacy.");
          seen.add(index);
          const a = r!.answers![index];
          if (a !== "have" && a !== "tomorrow") fail("unavailable", `${ask.items[index]?.label ?? "An item"} isn't available there.`);
          return { index, when: a === "have" ? ("now" as const) : ("tomorrow" as const) };
        });
        const id = newId(8);
        const t = now();
        q(`INSERT INTO reservations(id, ask_id, recipient_id, pharmacy_id, customer_id, items, code, status, hold_until, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, askId, r!.id, r!.pharmacy_id, customerId, JSON.stringify(items), String(randomInt(1000, 10000)), "held",
          t + (items.some((i) => i.when === "tomorrow") ? 26 * 3_600_000 : LIMITS.holdMs), t, t);
        q("UPDATE recipients SET state = 'chosen' WHERE id = ?").run(r!.id);
        created.push(getReservation(id)!);
      }
      q("UPDATE asks SET status = 'reserved', closed_at = ? WHERE id = ?").run(now(), askId);
      q("UPDATE recipients SET state = 'closed' WHERE ask_id = ? AND state IN ('pending','answered')").run(askId);
      log(askId, "ask.reserved", customerId, { plan });
      emit("ask.closed", { askId, reason: "reserved" });
      created.forEach((c) => emit("reservation.changed", { reservationId: c.id, status: "held", by: "customer" }));
      return created;
    });
  }

  const RES_FLOW: Record<string, { from: ReservationStatus[]; by: "customer" | "pharmacy" }> = {
    ready: { from: ["held"], by: "pharmacy" },
    collected: { from: ["held", "ready"], by: "pharmacy" },
    declined: { from: ["held", "ready"], by: "pharmacy" },
    cancelled: { from: ["held", "ready"], by: "customer" },
  };

  function updateReservation(id: string, actorId: number, to: "ready" | "collected" | "declined" | "cancelled") {
    return transaction(db, () => {
      const res = getReservation(id) ?? fail("not-found", "Reservation not found.");
      const rule = RES_FLOW[to] ?? fail("bad-status", "Unknown status.");
      if (rule.by === "customer" && res.customer_id !== actorId) fail("forbidden", "That isn't your reservation.");
      if (rule.by === "pharmacy" && pharmacies.get(res.pharmacy_id)?.owner_id !== actorId) fail("forbidden", "This reservation belongs to another pharmacy.");
      if (res.status === to) return res; // idempotent repeat tap
      if (!rule.from.includes(res.status)) fail("bad-transition", `This reservation is already ${res.status}.`);
      q("UPDATE reservations SET status = ?, updated_at = ? WHERE id = ?").run(to, now(), id);
      log(res.ask_id, `reservation.${to}`, actorId, { reservationId: id });
      emit("reservation.changed", { reservationId: id, status: to, by: rule.by });
      return getReservation(id)!;
    });
  }

  const setRef = {
    board: (askId: string, ref: unknown) => q("UPDATE asks SET board_ref = ? WHERE id = ?").run(JSON.stringify(ref), askId),
    recipient: (id: number, ref: unknown) => q("UPDATE recipients SET message_ref = ? WHERE id = ?").run(JSON.stringify(ref), id),
    reservation: (id: string, side: "customer" | "pharmacy", ref: unknown) =>
      q(`UPDATE reservations SET ${side === "customer" ? "customer_ref" : "pharmacy_ref"} = ? WHERE id = ?`).run(JSON.stringify(ref), id),
  };

  /** Periodic housekeeping: expire unanswered asks and uncollected holds. */
  function tick() {
    const t = now();
    const expiredAsks = (q("SELECT id FROM asks WHERE status = 'open' AND expires_at <= ?").all(t) as { id: string }[]).map((r) => r.id);
    for (const id of expiredAsks)
      transaction(db, () => {
        q("UPDATE asks SET status = 'expired', closed_at = ? WHERE id = ? AND status = 'open'").run(t, id);
        q("UPDATE recipients SET state = 'expired' WHERE ask_id = ? AND state IN ('pending','answered')").run(id);
        log(id, "ask.expired", null);
        emit("ask.closed", { askId: id, reason: "expired" });
      });
    const expiredRes = (q("SELECT id FROM reservations WHERE status IN ('held','ready') AND hold_until <= ?").all(t) as { id: string }[]).map((r) => r.id);
    for (const id of expiredRes) {
      q("UPDATE reservations SET status = 'expired', updated_at = ? WHERE id = ?").run(t, id);
      emit("reservation.changed", { reservationId: id, status: "expired", by: "system" });
    }
    return { asks: expiredAsks.length, reservations: expiredRes.length };
  }

  const history = {
    asksOf: (customerId: number, limit = 10) =>
      (q("SELECT * FROM asks WHERE customer_id = ? ORDER BY created_at DESC LIMIT ?").all(customerId, limit) as any[]).map(parseAsk),
    inbox(pharmacyId: number) {
      const open = (q(`SELECT r.* FROM recipients r JOIN asks a ON a.id = r.ask_id
                       WHERE r.pharmacy_id = ? AND a.status = 'open' AND r.state IN ('pending','answered')
                       ORDER BY r.notified_at DESC`).all(pharmacyId) as any[]).map(parseRecipient);
      const holds = (q("SELECT * FROM reservations WHERE pharmacy_id = ? AND status IN ('held','ready') ORDER BY created_at DESC").all(pharmacyId) as any[]).map(parseReservation);
      const recent = (q("SELECT * FROM reservations WHERE pharmacy_id = ? AND status NOT IN ('held','ready') ORDER BY updated_at DESC LIMIT 10").all(pharmacyId) as any[]).map(parseReservation);
      return { open: open.map((r) => ({ recipient: r, ask: getAsk(r.ask_id)! })), holds: holds.map((h) => ({ reservation: h, ask: getAsk(h.ask_id)! })), recent };
    },
    timeline: (askId: string) => q("SELECT kind, actor, data, at FROM events WHERE ask_id = ? ORDER BY at, id").all(askId),
    metrics() {
      const one = (sql: string) => Object.values(q(sql).get() as object)[0] as number;
      return {
        asks: one("SELECT COUNT(*) FROM asks"),
        reserved: one("SELECT COUNT(*) FROM asks WHERE status = 'reserved'"),
        answers: one("SELECT COUNT(*) FROM recipients WHERE answered_at IS NOT NULL"),
        pharmacies: one("SELECT COUNT(*) FROM pharmacies WHERE status = 'approved'"),
        pending: one("SELECT COUNT(*) FROM pharmacies WHERE status = 'pending'"),
        collected: one("SELECT COUNT(*) FROM reservations WHERE status = 'collected'"),
      };
    },
  };

  /** Demo Studio reset: erase activity created by studio personas only. */
  function resetStudioActivity() {
    transaction(db, () => {
      const studioUsers = "SELECT id FROM users WHERE transport = 'studio'";
      const asks = `SELECT id FROM asks WHERE customer_id IN (${studioUsers})`;
      db.exec(`DELETE FROM events WHERE ask_id IN (${asks});
               DELETE FROM reservations WHERE ask_id IN (${asks});
               DELETE FROM recipients WHERE ask_id IN (${asks});
               DELETE FROM asks WHERE id IN (${asks});
               DELETE FROM drafts WHERE user_id IN (${studioUsers});
               DELETE FROM chat_state WHERE user_id IN (${studioUsers});
               DELETE FROM saved WHERE user_id IN (${studioUsers});
               UPDATE users SET lat = NULL, lng = NULL, place = NULL, radius_km = 2 WHERE transport = 'studio';
               UPDATE pharmacies SET accepting = 1 WHERE demo = 1;`);
    });
  }

  return {
    catalog, users, drafts, saved, pharmacies, on, off, now, resetStudioActivity,
    asks: { create: createAsk, cancel: cancelAsk, get: getAsk, recipients: recipientsOf, board, planFor, reserve },
    answers: { mark, submit: answer, edit, setPrice, get: getRecipient },
    reservations: { get: getReservation, update: updateReservation, of: reservationsOf },
    setRef, tick, history,
  };
}

export type MediFast = ReturnType<typeof createMediFast>;
export type Board = ReturnType<MediFast["asks"]["board"]>;
export type BoardRow = Board["rows"][number];
