const test = require("node:test"),
  assert = require("node:assert/strict");
const { openCatalog } = require("../src/medicine/catalog.cjs");
const { createPlatform } = require("../src/platform/core.cjs");
function setup() {
  const c = openCatalog(":memory:");
  let now = Date.parse("2026-10-22T10:00:00Z");
  const p = createPlatform(c, { now: () => now });
  return {
    c,
    p,
    customer: p.user("demo-customer"),
    pharmacy: p.user("demo-pharmacy"),
    admin: p.user("demo-admin"),
    advance: (n) => (now += n),
  };
}
const input = {
  pharmacyId: "demo-green",
  items: [{ medicineId: "dolo650", quantity: 1 }],
};
test("request complete lifecycle, quote, identity and actor timeline persist", () => {
  const { c, p, customer, pharmacy } = setup();
  try {
    let r = p.createRequest(customer, input, "one-request");
    for (const status of [
      "reviewing",
      "confirmed",
      "preparing",
      "ready",
      "completed",
    ])
      r = p.transition(pharmacy, r.id, {
        status,
        revision: r.revision,
        reviewed: true,
        reviewNote: "Demo pharmacist checked exact pack.",
      });
    assert.equal(r.status, "completed");
    assert.equal(r.quote, 30);
    assert.equal(r.items[0].strength, "650 mg");
    assert.equal(r.events.length, 6);
    assert.equal(
      p.inventory("demo-green").find((s) => s.medicine_id === "dolo650")
        .quantity,
      19,
    );
    assert.throws(
      () =>
        p.transition(customer, r.id, {
          status: "cancelled",
          revision: r.revision,
        }),
      /closed/,
    );
  } finally {
    c.close();
  }
});
test("request creation is idempotent and rejects payload reuse", () => {
  const { c, p, customer } = setup();
  try {
    const a = p.createRequest(customer, input, "same-request");
    assert.equal(p.createRequest(customer, input, "same-request").id, a.id);
    assert.throws(
      () =>
        p.createRequest(
          customer,
          { ...input, items: [{ medicineId: "cet10", quantity: 1 }] },
          "same-request",
        ),
      /different/,
    );
    assert.equal(p.requests(customer).length, 1);
  } finally {
    c.close();
  }
});
test("customer and another pharmacy cannot mutate another request", async () => {
  const { c, p, customer, pharmacy } = setup();
  try {
    const other = await p.register({
      email: "other@example.test",
      name: "Other",
      password: "LongPassword123",
      role: "customer",
    });
    const op = await p.register({
      email: "operator@example.test",
      name: "Other operator",
      password: "LongPassword123",
      role: "pharmacy",
    });
    let r = p.createRequest(customer, input, "access-test");
    assert.throws(() => p.request(other, r.id), /not found/);
    assert.throws(() => p.request(op, r.id), /not found/);
    assert.throws(
      () => p.transition(customer, r.id, { status: "confirmed", revision: 0 }),
      /cancel/,
    );
    assert.throws(
      () => p.transition(pharmacy, r.id, { status: "ready", revision: 0 }),
      /Invalid/,
    );
  } finally {
    c.close();
  }
});
test("confirmation requires review and current stock; concurrent last pack cannot double reserve", () => {
  const { c, p, customer, pharmacy } = setup();
  try {
    p.updateStock(pharmacy, "demo-green", {
      medicineId: "dolo650",
      quantity: 1,
      price: 42,
      unit: "strip of 15 tablets",
      revision: 0,
    });
    const requests = ["concurrent-a", "concurrent-b"].map((k) => {
      let r = p.createRequest(customer, input, k);
      return p.transition(pharmacy, r.id, {
        status: "reviewing",
        revision: r.revision,
      });
    });
    assert.throws(
      () =>
        p.transition(pharmacy, requests[0].id, {
          status: "confirmed",
          revision: 1,
        }),
      /review/,
    );
    const first = p.transition(pharmacy, requests[0].id, {
      status: "confirmed",
      revision: 1,
      reviewed: true,
      reviewNote: "Prescription and exact product checked",
    });
    assert.equal(first.quote, 42);
    assert.throws(
      () =>
        p.transition(pharmacy, requests[1].id, {
          status: "confirmed",
          revision: 1,
          reviewed: true,
          reviewNote: "Review completed",
        }),
      /stock/,
    );
    assert.equal(p.request(customer, requests[1].id).status, "reviewing");
    assert.equal(
      p.inventory("demo-green").find((s) => s.medicine_id === "dolo650")
        .quantity,
      0,
    );
    p.transition(customer, first.id, {
      status: "cancelled",
      revision: first.revision,
    });
    assert.equal(
      p.inventory("demo-green").find((s) => s.medicine_id === "dolo650")
        .quantity,
      1,
    );
  } finally {
    c.close();
  }
});
test("stock revision conflicts rejected and stale inventory becomes unknown", () => {
  const { c, p, pharmacy, advance } = setup();
  try {
    const change = {
      medicineId: "dolo650",
      quantity: 5,
      price: 30,
      unit: "one pack",
      revision: 0,
    };
    p.updateStock(pharmacy, "demo-green", change);
    assert.throws(
      () => p.updateStock(pharmacy, "demo-green", change),
      /changed/,
    );
    advance(86400001);
    const r = p.discover(["dolo650"], { lat: 26.91, lng: 75.79 });
    assert.equal(r[0].items[0].status, "unknown");
    assert.equal(r[0].items[0].price, null);
  } finally {
    c.close();
  }
});
test("expiration is persistent and releases reservations; rejection and unavailable are terminal", () => {
  const { c, p, customer, pharmacy, advance } = setup();
  try {
    let r = p.createRequest(customer, input, "expire-test");
    r = p.transition(pharmacy, r.id, { status: "reviewing", revision: 0 });
    r = p.transition(pharmacy, r.id, {
      status: "confirmed",
      revision: 1,
      reviewed: true,
      reviewNote: "Demo checked",
    });
    advance(86400001);
    assert.equal(p.expire(), 1);
    assert.equal(p.request(customer, r.id).status, "expired");
    assert.equal(
      p.inventory("demo-green").find((s) => s.medicine_id === "dolo650")
        .quantity,
      20,
    );
    for (const status of ["rejected", "unavailable"]) {
      let x = p.createRequest(customer, input, status + "-test");
      x = p.transition(pharmacy, x.id, { status, revision: 0 });
      assert.equal(x.status, status);
      assert.throws(
        () =>
          p.transition(pharmacy, x.id, { status: "reviewing", revision: 1 }),
        /closed/,
      );
    }
  } finally {
    c.close();
  }
});
test("pending partner cannot receive requests; only admin can approve", async () => {
  const { c, p, customer, pharmacy, admin } = setup();
  try {
    const op = await p.register({
      email: "pending@example.test",
      name: "Pending",
      password: "LongPassword123",
      role: "pharmacy",
    });
    const shop = p.registerPartner(op, {
      name: "Pending demo",
      address: "Fictional Jaipur",
      license: "DEMO",
      pharmacistName: "Demo",
      pharmacistReg: "DEMO",
      lat: 26.91,
      lng: 75.79,
    });
    assert.throws(
      () =>
        p.createRequest(
          customer,
          { ...input, pharmacyId: shop.id },
          "pending-request",
        ),
      /approved/,
    );
    assert.throws(() => p.approve(pharmacy, shop.id, true, true), /Admin/);
    assert.throws(() => p.approve(admin, shop.id, true, false), /reviewed/);
    p.approve(admin, shop.id, true, true);
    assert.ok(
      p.createRequest(
        customer,
        { ...input, pharmacyId: shop.id },
        "approved-request",
      ).id,
    );
  } finally {
    c.close();
  }
});
test("passwords hashed, sessions expire, logout revokes, live mode rejects demo logins", async () => {
  const { c, p, advance } = setup();
  try {
    const u = await p.login("customer@medifast.demo", "DemoPass!2026");
    assert.ok(
      !c.db
        .prepare("SELECT password FROM users LIMIT 1")
        .get()
        .password.includes("DemoPass"),
    );
    const token = p.session(u);
    assert.equal(p.authenticate(token).id, u.id);
    p.logout(token);
    assert.equal(p.authenticate(token), null);
    const other = p.session(u);
    advance(8 * 3600000 + 1);
    assert.equal(p.authenticate(other), null);
    const live = createPlatform(c, { mode: "live", seed: false });
    await assert.rejects(live.login("customer@medifast.demo", "DemoPass!2026"));
    assert.deepEqual(
      live.discover(["dolo650"], { lat: 26.91, lng: 75.79 }),
      [],
    );
  } finally {
    c.close();
  }
});
test("catalog identity changes invalidate stored stock rather than relabeling it", () => {
  const { c, p } = setup();
  try {
    const data = require("../data/demo-medicines.json").map((m) =>
      m.id === "dolo650" ? { ...m, strength: "500 mg" } : m,
    );
    c.replace(data);
    assert.equal(
      p.discover(["dolo650"], { lat: 26.91, lng: 75.79 })[0].items[0].status,
      "unknown",
    );
  } finally {
    c.close();
  }
});

test("imported batch expiry invalidates otherwise fresh stock and prevents confirmation", () => {
  const { c, p, customer, pharmacy, advance } = setup();
  try {
    const row = p
      .inventory("demo-green")
      .find((r) => r.medicine_id === "dolo650");
    p.importStock(pharmacy, "demo-green", [
      {
        medicineId: "dolo650",
        quantity: 3,
        price: 30,
        unit: "strip",
        revision: row.revision,
        identity: row.identity,
        expiry: "2026-10-22",
      },
    ]);
    let r = p.createRequest(customer, input, "expiry-date-test");
    r = p.transition(pharmacy, r.id, {
      status: "reviewing",
      revision: r.revision,
    });
    advance(9 * 3600000);
    assert.equal(
      p.discover(["dolo650"], { lat: 26.91, lng: 75.79 })[0].items[0].status,
      "unknown",
    );
    assert.throws(
      () =>
        p.transition(pharmacy, r.id, {
          status: "confirmed",
          revision: r.revision,
          reviewed: true,
          reviewNote: "Checked demo stock.",
        }),
      /Current stock/,
    );
  } finally {
    c.close();
  }
});

test("partner submission and approval notify the operator and discovery clients", async () => {
  const { c, p, admin } = setup();
  try {
    const operator = await p.register({
      email: "approval-events@example.test",
      name: "Demo operator",
      password: "LongPassword123!",
      role: "pharmacy",
    });
    let operatorEvents = 0,
      inventoryEvents = 0,
      adminEvents = 0;
    p.events.on(operator.id, () => operatorEvents++);
    p.events.on("inventory", () => inventoryEvents++);
    p.events.on(admin.id, () => adminEvents++);
    const shop = p.registerPartner(operator, {
      name: "Fictional demo",
      address: "Demo street Jaipur",
      license: "DEMO",
      pharmacistName: "Demo",
      pharmacistReg: "DEMO",
      lat: 26.91,
      lng: 75.79,
    });
    assert.ok(operatorEvents >= 1);
    assert.ok(adminEvents >= 1);
    assert.equal(inventoryEvents, 1);
    p.approve(admin, shop.id, true, true);
    assert.ok(operatorEvents >= 2);
    assert.equal(inventoryEvents, 2);
  } finally {
    c.close();
  }
});
