import { test } from "node:test";
import assert from "node:assert/strict";
import { world, flush } from "./helpers.ts";
import { DomainError } from "../src/domain/medifast.ts";

const code = (fn: () => unknown) => {
  try { fn(); } catch (e) { return (e as DomainError).code; }
  return "no-error";
};

function askFor(w: ReturnType<typeof world>, ids = ["dolo-650", "pan-40", "thyronorm-50"]) {
  return w.mf.asks.create(w.customer.id, { items: ids.map((productId) => ({ productId, qty: 1 })), ...w.VAISHALI, radiusKm: 2 });
}

test("an ask is broadcast to approved, accepting pharmacies in radius, nearest first", () => {
  const w = world();
  const ask = askFor(w);
  const recips = w.mf.asks.recipients(ask.id);
  assert.ok(recips.length >= 5 && recips.length <= 12);
  assert.ok(recips.every((r, i) => i === 0 || r.distance_m >= recips[i - 1].distance_m));
  assert.ok(recips.every((r) => r.distance_m <= 2000));
  const names = recips.map((r) => w.mf.pharmacies.get(r.pharmacy_id)!.name);
  assert.ok(!names.includes("Sitara Medical Hall"), "Malviya Nagar is outside 2 km");
});

test("snapshots keep exact identity; restricted products are never broadcast", () => {
  const w = world();
  const ask = askFor(w, ["thyronorm-50"]);
  assert.equal(ask.items[0].composition, "Levothyroxine 50 mcg");
  assert.equal(code(() => w.mf.drafts.add(w.customer.id, "gen-alprazolam-025")), "restricted");
  assert.equal(code(() => askFor(w, ["gen-alprazolam-025"])), "restricted");
});

test("customers get clear limits: empty list, no pharmacies, too many open asks", () => {
  const w = world();
  assert.equal(code(() => w.mf.asks.create(w.customer.id, { items: [], ...w.VAISHALI, radiusKm: 2 })), "empty");
  assert.equal(code(() => w.mf.asks.create(w.customer.id, { items: [{ productId: "dolo-650", qty: 1 }], lat: 26.7, lng: 75.5, place: "Far", radiusKm: 1 })), "no-pharmacies");
  askFor(w); askFor(w);
  assert.equal(code(() => askFor(w)), "too-many-open");
});

test("pharmacists can only answer their own request, and every item must be marked", () => {
  const w = world();
  const ask = askFor(w);
  const [r1, r2] = w.mf.asks.recipients(ask.id);
  assert.equal(code(() => w.mf.answers.mark(r1.id, w.ownerOf(r2.id), 0, "have")), "forbidden");
  w.mf.answers.mark(r1.id, w.ownerOf(r1.id), 0, "have");
  assert.equal(code(() => w.mf.answers.submit(r1.id, w.ownerOf(r1.id))), "incomplete");
  const done = w.mf.answers.submit(r1.id, w.ownerOf(r1.id), { fill: "no", price: 120 });
  assert.deepEqual(done.answers, ["have", "no", "no"]);
  assert.equal(done.state, "answered");
  assert.equal(code(() => w.mf.answers.submit(r1.id, w.ownerOf(r1.id), { price: -3 })), "bad-price");
});

test("the board ranks complete answers first and suggests a two-shop split", () => {
  const w = world();
  const ask = askFor(w);
  const [a, b, c] = w.mf.asks.recipients(ask.id);
  w.clock.advance(20_000);
  w.mf.answers.submit(a.id, w.ownerOf(a.id), { all: "no" });
  w.mf.answers.mark(b.id, w.ownerOf(b.id), 0, "have");
  w.mf.answers.mark(b.id, w.ownerOf(b.id), 1, "have");
  w.mf.answers.submit(b.id, w.ownerOf(b.id), { fill: "tomorrow" });
  w.mf.answers.mark(c.id, w.ownerOf(c.id), 2, "have");
  w.mf.answers.submit(c.id, w.ownerOf(c.id), { fill: "no" });
  let board = w.mf.asks.board(ask.id);
  assert.equal(board.counts.answered, 3);
  assert.equal(board.rows[0].recipientId, b.id);
  assert.equal(board.fastestMs, 20_000);
  assert.deepEqual(board.split?.parts, [{ recipientId: b.id, items: [0, 1] }, { recipientId: c.id, items: [2] }].sort((x, y) => w.mf.answers.get(x.recipientId)!.distance_m - w.mf.answers.get(y.recipientId)!.distance_m));
  const d = w.mf.asks.recipients(ask.id)[3];
  w.mf.answers.submit(d.id, w.ownerOf(d.id), { all: "have" });
  board = w.mf.asks.board(ask.id);
  assert.equal(board.rows[0].complete, true);
  assert.equal(board.split, null);
});

test("reserving closes the ask for everyone else and issues a pickup code", async () => {
  const w = world();
  const closed: string[] = [];
  w.mf.on("ask.closed", (e) => closed.push(e.reason));
  const ask = askFor(w);
  const [a, b] = w.mf.asks.recipients(ask.id);
  w.mf.answers.submit(a.id, w.ownerOf(a.id), { all: "have" });
  assert.equal(code(() => w.mf.asks.reserve(ask.id, w.ownerOf(a.id), w.mf.asks.planFor(ask.id, a.id))), "forbidden");
  const [res] = w.mf.asks.reserve(ask.id, w.customer.id, w.mf.asks.planFor(ask.id, a.id));
  assert.match(res.code, /^\d{4}$/);
  assert.equal(res.status, "held");
  assert.equal(w.mf.asks.get(ask.id)!.status, "reserved");
  assert.equal(w.mf.answers.get(b.id)!.state, "closed");
  assert.equal(code(() => w.mf.answers.submit(b.id, w.ownerOf(b.id), { all: "have" })), "closed");
  assert.equal(code(() => w.mf.asks.reserve(ask.id, w.customer.id, w.mf.asks.planFor(ask.id, a.id))), "already");
  await flush();
  assert.deepEqual(closed, ["reserved"]);
});

test("a split plan reserves at two pharmacies; items can't be double-booked or invented", () => {
  const w = world();
  const ask = askFor(w);
  const [a, b] = w.mf.asks.recipients(ask.id);
  w.mf.answers.mark(a.id, w.ownerOf(a.id), 0, "have");
  w.mf.answers.submit(a.id, w.ownerOf(a.id), { fill: "no" });
  w.mf.answers.mark(b.id, w.ownerOf(b.id), 0, "have");
  w.mf.answers.submit(b.id, w.ownerOf(b.id), { fill: "have" });
  assert.equal(code(() => w.mf.asks.reserve(ask.id, w.customer.id, [{ recipientId: a.id, items: [0, 1] }])), "unavailable");
  assert.equal(code(() => w.mf.asks.reserve(ask.id, w.customer.id, [{ recipientId: a.id, items: [0] }, { recipientId: b.id, items: [0, 1, 2] }])), "bad-plan");
  const made = w.mf.asks.reserve(ask.id, w.customer.id, [{ recipientId: a.id, items: [0] }, { recipientId: b.id, items: [1, 2] }]);
  assert.equal(made.length, 2);
  assert.notEqual(made[0].pharmacy_id, made[1].pharmacy_id);
});

test("reservation lifecycle enforces who can do what", () => {
  const w = world();
  const ask = askFor(w, ["dolo-650"]);
  const [a] = w.mf.asks.recipients(ask.id);
  w.mf.answers.submit(a.id, w.ownerOf(a.id), { all: "have" });
  const [res] = w.mf.asks.reserve(ask.id, w.customer.id, w.mf.asks.planFor(ask.id, a.id));
  assert.equal(code(() => w.mf.reservations.update(res.id, w.customer.id, "ready")), "forbidden");
  assert.equal(w.mf.reservations.update(res.id, w.ownerOf(a.id), "ready").status, "ready");
  assert.equal(w.mf.reservations.update(res.id, w.ownerOf(a.id), "ready").status, "ready", "repeat taps are idempotent");
  assert.equal(w.mf.reservations.update(res.id, w.ownerOf(a.id), "collected").status, "collected");
  assert.equal(code(() => w.mf.reservations.update(res.id, w.customer.id, "cancelled")), "bad-transition");
  const stats = w.mf.pharmacies.stats(w.mf.answers.get(a.id)!.pharmacy_id);
  assert.equal(stats.collected, 1);
  assert.equal(stats.responseRate, 1);
});

test("tick expires unanswered asks and stale holds", () => {
  const w = world();
  const ask = askFor(w);
  w.clock.advance(31 * 60_000);
  assert.deepEqual(w.mf.tick(), { asks: 1, reservations: 0 });
  assert.equal(w.mf.asks.get(ask.id)!.status, "expired");
  assert.ok(w.mf.asks.recipients(ask.id).every((r) => r.state === "expired"));
});

test("pharmacy onboarding is validated and needs an admin to approve", () => {
  const w = world();
  const owner = w.mf.users.upsert({ ref: "live:42", transport: "live", chatId: "42", name: "New shop" });
  assert.equal(code(() => w.mf.pharmacies.register(owner.id, { name: "A", area: "", address: "", lat: 26.9, lng: 75.7, phone: "1", license: "x" })), "bad-name");
  const p = w.mf.pharmacies.register(owner.id, { name: "Test Medicos", area: "Vaishali Nagar", address: "x", lat: 26.9116, lng: 75.7426, phone: "9876543210", license: "RJ-20B-1234" });
  assert.equal(p.status, "pending");
  assert.ok(!w.mf.pharmacies.nearby(w.VAISHALI, 1).some((n) => n.pharmacy.id === p.id));
  assert.equal(code(() => w.mf.pharmacies.review(p.id, owner.id, "approved")), "forbidden");
  w.mf.pharmacies.review(p.id, w.admin.id, "approved");
  assert.equal(w.mf.pharmacies.nearby(w.VAISHALI, 1)[0].pharmacy.id, p.id);
  w.mf.pharmacies.setAccepting(owner.id, false);
  assert.ok(!w.mf.pharmacies.nearby(w.VAISHALI, 1).some((n) => n.pharmacy.id === p.id), "closed shops get no asks");
});
