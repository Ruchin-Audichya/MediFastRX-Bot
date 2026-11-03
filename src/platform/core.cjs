const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { EventEmitter } = require("node:events");
const { distanceKm } = require("../pharmacy/service.cjs");
const derive = promisify(crypto.scrypt);
const terminal = new Set([
  "completed",
  "cancelled",
  "rejected",
  "expired",
  "unavailable",
]);
const transitions = {
  submitted: ["reviewing", "rejected", "unavailable"],
  reviewing: ["confirmed", "rejected", "unavailable"],
  confirmed: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
};
function passwordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.scryptSync(password, salt, 64).toString("hex");
}
async function checkPassword(password, hash) {
  const [salt, value] = hash.split(":");
  const actual = await derive(password, salt, 64);
  return crypto.timingSafeEqual(actual, Buffer.from(value, "hex"));
}
function fail(message, status = 400) {
  const e = Error(message);
  e.status = status;
  throw e;
}
function createPlatform(
  catalog,
  {
    mode = process.env.APP_MODE || "demo",
    now = () => Date.now(),
    seed = true,
  } = {},
) {
  if (!["demo", "live"].includes(mode))
    throw Error("APP_MODE must be demo or live.");
  const db = catalog.db,
    events = new EventEmitter();
  events.setMaxListeners(100);
  db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT NOT NULL,role TEXT NOT NULL,disabled INTEGER DEFAULT 0,demo INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS partners(id TEXT PRIMARY KEY,owner_id TEXT UNIQUE NOT NULL,body TEXT NOT NULL,approved INTEGER DEFAULT 0,demo INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS partner_inventory(pharmacy_id TEXT,medicine_id TEXT,quantity INTEGER NOT NULL,price REAL NOT NULL,unit TEXT NOT NULL,updated_at TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(pharmacy_id,medicine_id));
 CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,pharmacy_id TEXT NOT NULL,items TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER DEFAULT 0,created_at TEXT NOT NULL,expires_at INTEGER NOT NULL,prescription_id TEXT,reviewed_by TEXT,review_note TEXT,quote REAL,idempotency TEXT NOT NULL,payload_hash TEXT NOT NULL,UNIQUE(user_id,idempotency));
 CREATE INDEX IF NOT EXISTS request_customer ON requests(user_id,created_at);CREATE INDEX IF NOT EXISTS request_partner ON requests(pharmacy_id,created_at);CREATE INDEX IF NOT EXISTS request_expiry ON requests(status,expires_at);
 CREATE TABLE IF NOT EXISTS status_events(id INTEGER PRIMARY KEY,request_id TEXT NOT NULL,status TEXT NOT NULL,actor TEXT NOT NULL,at TEXT NOT NULL,note TEXT);
 CREATE TABLE IF NOT EXISTS audit_logs(id INTEGER PRIMARY KEY,actor TEXT NOT NULL,action TEXT NOT NULL,entity TEXT NOT NULL,at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS prescriptions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,path TEXT NOT NULL,mime TEXT NOT NULL,text TEXT,created_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS review_reports(id INTEGER PRIMARY KEY,user_id TEXT,kind TEXT NOT NULL,entity TEXT,note TEXT,at TEXT NOT NULL,resolved INTEGER DEFAULT 0);
 CREATE TABLE IF NOT EXISTS catalog_reviews(medicine_id TEXT PRIMARY KEY,reviewer TEXT,at TEXT);`);
  if (
    !db
      .prepare("PRAGMA table_info(partner_inventory)")
      .all()
      .some((c) => c.name === "identity")
  )
    db.exec("ALTER TABLE partner_inventory ADD COLUMN identity TEXT");
  db.exec(
    "CREATE INDEX IF NOT EXISTS status_event_request ON status_events(request_id,id); CREATE INDEX IF NOT EXISTS prescription_owner ON prescriptions(user_id,created_at); CREATE INDEX IF NOT EXISTS session_expiry ON sessions(expires);",
  );
  if (
    !db
      .prepare("PRAGMA table_info(partner_inventory)")
      .all()
      .some((c) => c.name === "expiry")
  )
    db.exec("ALTER TABLE partner_inventory ADD COLUMN expiry TEXT");
  const unexpired = (r) =>
    !r.expiry || now() <= Date.parse(`${r.expiry}T23:59:59+05:30`);
  const identity = (id) => {
    const m = catalog.get(id);
    return m ? JSON.stringify([m.name, m.generic, m.strength, m.form]) : null;
  };
  const stamp = () => new Date(now()).toISOString();
  const audit = (actor, action, entity) =>
    db
      .prepare(
        "INSERT INTO audit_logs(actor,action,entity,at) VALUES (?,?,?,?)",
      )
      .run(actor, action, entity, stamp());
  const publicUser = (u) =>
    u
      ? {
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          demo: !!u.demo,
          disabled: !!u.disabled,
        }
      : null;
  const user = (id) =>
    publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(id));
  const partner = (id) => {
    const p = db.prepare("SELECT * FROM partners WHERE id=?").get(id);
    return p
      ? {
          ...JSON.parse(p.body),
          id: p.id,
          ownerId: p.owner_id,
          approved: !!p.approved,
          demo: !!p.demo,
        }
      : null;
  };
  const ownPartner = (u) =>
    db.prepare("SELECT id FROM partners WHERE owner_id=?").get(u.id)?.id;
  const notify = (customer, pharmacy) => {
    events.emit(customer);
    const p = partner(pharmacy);
    if (p) events.emit(p.ownerId);
    for (const a of db.prepare("SELECT id FROM users WHERE role='admin'").all())
      events.emit(a.id);
  };
  const event = (id, status, actor, note = "") =>
    db
      .prepare(
        "INSERT INTO status_events(request_id,status,actor,at,note) VALUES (?,?,?,?,?)",
      )
      .run(id, status, actor, stamp(), note);
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  function seedDemo(reset = false) {
    if (mode !== "demo") fail("Demo seed is disabled in live mode.");
    if (reset && db.prepare("SELECT id FROM users WHERE demo=0 LIMIT 1").get())
      fail("Reset refused: this database contains non-demo accounts.");
    if (reset)
      transaction(() => {
        for (const table of [
          "sessions",
          "status_events",
          "requests",
          "partner_inventory",
          "partners",
          "users",
          "review_reports",
          "audit_logs",
          "catalog_reviews",
          "prescriptions",
        ])
          db.exec(`DELETE FROM ${table}`);
      });
    if (db.prepare("SELECT id FROM users LIMIT 1").get()) return;
    transaction(() => {
      for (const [id, email, name, role] of [
        [
          "demo-customer",
          "customer@medifast.demo",
          "Demo customer",
          "customer",
        ],
        [
          "demo-pharmacy",
          "pharmacy@medifast.demo",
          "Demo pharmacist",
          "pharmacy",
        ],
        ["demo-admin", "admin@medifast.demo", "Demo admin", "admin"],
      ])
        db.prepare(
          "INSERT INTO users(id,email,name,password,role,demo) VALUES (?,?,?,?,?,1)",
        ).run(id, email, name, passwordHash("DemoPass!2026"), role);
      const p = {
        name: "Demo · Green Corner Pharmacy",
        address: "Fictional partner near Jaipur city centre",
        lat: 26.9129,
        lng: 75.789,
        phone: null,
        hours: "Demo hours: 09:00–20:00",
        license: "DEMO-NOT-A-LICENCE",
        pharmacistName: "Demo pharmacist",
        pharmacistReg: "DEMO-ONLY",
      };
      db.prepare("INSERT INTO partners VALUES (?,?,?,1,1)").run(
        "demo-green",
        "demo-pharmacy",
        JSON.stringify(p),
      );
      for (const id of ["dolo650", "cet10", "ome20", "amox500"])
        db.prepare(
          "INSERT INTO partner_inventory(pharmacy_id,medicine_id,quantity,price,unit,updated_at,revision,identity) VALUES (?,?,?,?,?,?,0,?)",
        ).run(
          "demo-green",
          id,
          20,
          id === "dolo650" ? 30 : 50,
          "one sealed retail pack — confirm size",
          stamp(),
          identity(id),
        );
      audit("system", "demo.seed", "demo");
    });
  }
  if (seed && mode === "demo") seedDemo();
  async function register(input) {
    const email = String(input?.email || "")
        .trim()
        .toLowerCase(),
      name = String(input?.name || "").trim(),
      password = input?.password,
      role = input?.role;
    if (
      !/^[^\s@]{1,64}@[^\s@]{1,180}\.[^\s@]{2,20}$/.test(email) ||
      name.length < 2 ||
      name.length > 80 ||
      typeof password !== "string" ||
      password.length < 12 ||
      password.length > 128 ||
      !["customer", "pharmacy"].includes(role)
    )
      fail(
        "Use a valid email, name, role and a password of 12–128 characters.",
      );
    const id = crypto.randomUUID(),
      salt = crypto.randomBytes(16).toString("hex"),
      hash = await derive(password, salt, 64);
    try {
      db.prepare(
        "INSERT INTO users(id,email,name,password,role,demo) VALUES (?,?,?,?,?,?)",
      ).run(
        id,
        email,
        name,
        `${salt}:${hash.toString("hex")}`,
        role,
        mode === "demo" ? 1 : 0,
      );
    } catch {
      fail("An account with that email already exists.");
    }
    audit(id, "account.created", id);
    return user(id);
  }
  async function login(email, password) {
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      password.length > 128
    )
      fail("Invalid email or password.", 401);
    const u = db
      .prepare("SELECT * FROM users WHERE email=?")
      .get(email.trim().toLowerCase());
    if (
      !u ||
      !!u.demo !== (mode === "demo") ||
      u.disabled ||
      !(await checkPassword(password, u.password))
    )
      fail("Invalid email or password.", 401);
    return publicUser(u);
  }
  function session(u) {
    const raw = crypto.randomBytes(32).toString("hex"),
      hash = crypto.createHash("sha256").update(raw).digest("hex");
    db.prepare("DELETE FROM sessions WHERE expires<?").run(now());
    db.prepare("INSERT INTO sessions VALUES (?,?,?)").run(
      hash,
      u.id,
      now() + 8 * 3600000,
    );
    return raw;
  }
  function authenticate(raw) {
    if (!raw || typeof raw !== "string") return null;
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    const s = db
      .prepare("SELECT user_id FROM sessions WHERE token=? AND expires>?")
      .get(hash, now());
    const u = s ? user(s.user_id) : null;
    return u && !u.disabled && u.demo === (mode === "demo") ? u : null;
  }
  function logout(raw) {
    if (raw)
      db.prepare("DELETE FROM sessions WHERE token=?").run(
        crypto.createHash("sha256").update(raw).digest("hex"),
      );
  }
  function registerPartner(u, input) {
    if (u.role !== "pharmacy") fail("Pharmacy role required.", 403);
    const p = {};
    for (const key of [
      "name",
      "address",
      "phone",
      "hours",
      "license",
      "pharmacistName",
      "pharmacistReg",
    ]) {
      p[key] = String(input?.[key] || "").trim();
      if (p[key].length > 220) fail("A shop field is too long.");
    }
    p.lat = Number(input?.lat);
    p.lng = Number(input?.lng);
    if (
      !p.name ||
      p.address.length < 5 ||
      !p.license ||
      !p.pharmacistName ||
      !p.pharmacistReg ||
      input?.lat == null ||
      input?.lng == null ||
      input.lat === "" ||
      input.lng === "" ||
      !Number.isFinite(p.lat) ||
      !Number.isFinite(p.lng) ||
      Math.abs(p.lat) > 90 ||
      Math.abs(p.lng) > 180
    )
      fail("Complete the business, licence, pharmacist and map details.");
    if (mode === "live" && !/^\+?[\d ()-]{7,24}$/.test(p.phone))
      fail("Add a valid public shop phone number.");
    if (mode === "demo") p.phone = null;
    const id = ownPartner(u) || crypto.randomUUID();
    db.prepare(
      "INSERT INTO partners VALUES (?,?,?,0,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,approved=0",
    ).run(id, u.id, JSON.stringify(p), mode === "demo" ? 1 : 0);
    audit(u.id, "pharmacy.submitted", id);
    notify(u.id, id);
    events.emit("inventory");
    return partner(id);
  }
  function approve(u, id, approved, checked) {
    if (u.role !== "admin") fail("Admin role required.", 403);
    if (typeof approved !== "boolean" || (approved && checked !== true))
      fail(
        "Record that the identity, licence and pharmacist registration were reviewed.",
      );
    if (!partner(id)) fail("Pharmacy not found.", 404);
    db.prepare("UPDATE partners SET approved=? WHERE id=?").run(
      approved ? 1 : 0,
      id,
    );
    audit(u.id, approved ? "pharmacy.approved" : "pharmacy.suspended", id);
    events.emit(partner(id).ownerId);
    events.emit("inventory");
    return partner(id);
  }
  function inventory(id) {
    return db
      .prepare("SELECT * FROM partner_inventory WHERE pharmacy_id=? LIMIT 1000")
      .all(id)
      .map((r) => ({
        ...r,
        medicine: catalog.get(r.medicine_id),
        fresh:
          now() - Date.parse(r.updated_at) < 86400000 &&
          r.identity === identity(r.medicine_id) &&
          unexpired(r),
      }));
  }
  function updateStock(u, id, input) {
    const p = partner(id);
    if (!p || p.ownerId !== u.id || u.role !== "pharmacy")
      fail("This pharmacy is not yours.", 403);
    if (!catalog.get(input?.medicineId))
      fail("Confirm a catalog medicine first.");
    if (
      !Number.isInteger(input.quantity) ||
      input.quantity < 0 ||
      input.quantity > 100000 ||
      typeof input.price !== "number" ||
      !Number.isFinite(input.price) ||
      input.price < 0 ||
      input.price > 100000 ||
      typeof input.unit !== "string" ||
      !input.unit.trim() ||
      input.unit.length > 100
    )
      fail(
        "Use a whole stock quantity, non-negative INR price and a pack/unit label.",
      );
    const r = transaction(() => {
      const old = db
        .prepare(
          "SELECT * FROM partner_inventory WHERE pharmacy_id=? AND medicine_id=?",
        )
        .get(id, input.medicineId);
      if (old && old.revision !== input.revision)
        fail("Stock changed in another session. Refresh and try again.", 409);
      if (!old && input.revision != null)
        fail("Stock row changed. Refresh.", 409);
      db.prepare(
        "INSERT INTO partner_inventory(pharmacy_id,medicine_id,quantity,price,unit,updated_at,revision,identity) VALUES (?,?,?,?,?,?,0,?) ON CONFLICT(pharmacy_id,medicine_id) DO UPDATE SET quantity=excluded.quantity,price=excluded.price,unit=excluded.unit,updated_at=excluded.updated_at,revision=partner_inventory.revision+1,identity=excluded.identity,expiry=NULL",
      ).run(
        id,
        input.medicineId,
        input.quantity,
        input.price,
        input.unit.trim(),
        stamp(),
        identity(input.medicineId),
      );
      audit(u.id, "inventory.updated", id);
      return inventory(id);
    });
    events.emit("inventory");
    return r;
  }
  function importStock(u, id, rows) {
    const shop = partner(id);
    if (!shop || shop.ownerId !== u.id || u.role !== "pharmacy")
      fail("This pharmacy is not yours.", 403);
    transaction(() => {
      for (const r of rows) {
        const old = db
          .prepare(
            "SELECT revision FROM partner_inventory WHERE pharmacy_id=? AND medicine_id=?",
          )
          .get(id, r.medicineId);
        if ((old?.revision ?? null) !== r.revision)
          fail("Stock changed after the preview. Preview again.", 409);
        if (!unexpired(r))
          fail("Stock expired after preview. Preview again.", 409);
        if (identity(r.medicineId) !== r.identity)
          fail("Catalog changed after preview. Preview again.", 409);
      }
      for (const r of rows)
        db.prepare(
          "INSERT INTO partner_inventory(pharmacy_id,medicine_id,quantity,price,unit,updated_at,revision,identity,expiry) VALUES (?,?,?,?,?,?,0,?,?) ON CONFLICT(pharmacy_id,medicine_id) DO UPDATE SET quantity=excluded.quantity,price=excluded.price,unit=excluded.unit,updated_at=excluded.updated_at,revision=partner_inventory.revision+1,identity=excluded.identity,expiry=excluded.expiry",
        ).run(
          id,
          r.medicineId,
          r.quantity,
          r.price,
          r.unit,
          stamp(),
          r.identity,
          r.expiry || null,
        );
      audit(u.id, "inventory.csv_import", id);
    });
    events.emit("inventory");
    return inventory(id);
  }
  function release(r) {
    if (["confirmed", "preparing", "ready"].includes(r.status))
      for (const item of JSON.parse(r.items))
        db.prepare(
          "UPDATE partner_inventory SET quantity=quantity+?,revision=revision+1 WHERE pharmacy_id=? AND medicine_id=? AND identity=?",
        ).run(
          item.quantity,
          r.pharmacy_id,
          item.medicineId,
          item.identity || null,
        );
  }
  function expire() {
    const due = db
      .prepare(
        "SELECT * FROM requests WHERE expires_at<=? AND status NOT IN ('completed','cancelled','rejected','expired','unavailable') LIMIT 100",
      )
      .all(now());
    for (const r of due) {
      transaction(() => {
        release(r);
        db.prepare(
          "UPDATE requests SET status='expired',revision=revision+1 WHERE id=?",
        ).run(r.id);
        event(r.id, "expired", "system");
        audit("system", "request.expired", r.id);
      });
      notify(r.user_id, r.pharmacy_id);
    }
    return due.length;
  }
  function visible(u, r) {
    return (
      r &&
      (u.role === "admin" ||
        r.user_id === u.id ||
        (u.role === "pharmacy" && partner(r.pharmacy_id)?.ownerId === u.id))
    );
  }
  function request(u, id) {
    const r = db.prepare("SELECT * FROM requests WHERE id=?").get(id);
    if (!visible(u, r)) fail("Request not found.", 404);
    return {
      ...r,
      items: JSON.parse(r.items),
      pharmacy: {
        id: r.pharmacy_id,
        name: partner(r.pharmacy_id)?.name || "Removed pharmacy",
        demo: partner(r.pharmacy_id)?.demo,
      },
      events: db
        .prepare(
          "SELECT status,actor,at,note FROM status_events WHERE request_id=? ORDER BY id",
        )
        .all(id),
    };
  }
  function requests(u) {
    expire();
    let ids;
    if (u.role === "admin")
      ids = db
        .prepare("SELECT id FROM requests ORDER BY created_at DESC LIMIT 100")
        .all();
    else if (u.role === "pharmacy")
      ids = db
        .prepare(
          "SELECT id FROM requests WHERE pharmacy_id=? ORDER BY created_at DESC LIMIT 100",
        )
        .all(ownPartner(u) || "");
    else
      ids = db
        .prepare(
          "SELECT id FROM requests WHERE user_id=? ORDER BY created_at DESC LIMIT 100",
        )
        .all(u.id);
    return ids.map((r) => request(u, r.id));
  }
  function createRequest(u, input, key) {
    if (u.role !== "customer")
      fail("Use a customer account to request medicines.", 403);
    if (typeof key !== "string" || !/^[-a-zA-Z0-9]{8,100}$/.test(key))
      fail("A valid idempotency key is required.");
    const p = partner(input?.pharmacyId);
    if (!p || !p.approved || p.demo !== (mode === "demo"))
      fail("This pharmacy is not an approved participating partner.");
    if (
      !Array.isArray(input.items) ||
      !input.items.length ||
      input.items.length > 8
    )
      fail("Confirm 1–8 medicines.");
    const seen = new Set();
    const items = input.items.map((x) => {
      const m = catalog.get(x?.medicineId);
      if (
        !m ||
        seen.has(m.id) ||
        !Number.isInteger(x.quantity) ||
        x.quantity < 1 ||
        x.quantity > 20
      )
        fail("Use unique catalog medicines and 1–20 packs per item.");
      seen.add(m.id);
      return {
        medicineId: m.id,
        identity: identity(m.id),
        name: m.name,
        strength: m.strength,
        form: m.form,
        quantity: x.quantity,
      };
    });
    let rx = null;
    if (input.prescriptionId) {
      rx = db
        .prepare(
          "SELECT id FROM prescriptions WHERE id=? AND user_id=? AND created_at>?",
        )
        .get(input.prescriptionId, u.id, now() - 7 * 86400000);
      if (!rx) fail("Prescription not found or expired.", 404);
    }
    const payload = JSON.stringify({
        pharmacyId: p.id,
        items,
        prescriptionId: rx?.id || null,
      }),
      hash = crypto.createHash("sha256").update(payload).digest("hex"),
      prior = db
        .prepare(
          "SELECT id,payload_hash FROM requests WHERE user_id=? AND idempotency=?",
        )
        .get(u.id, key);
    if (prior) {
      if (prior.payload_hash !== hash)
        fail(
          "This submission key was already used for a different request.",
          409,
        );
      return request(u, prior.id);
    }
    const id = crypto.randomUUID();
    transaction(() => {
      db.prepare(
        "INSERT INTO requests(id,user_id,pharmacy_id,items,status,created_at,expires_at,prescription_id,idempotency,payload_hash) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        u.id,
        p.id,
        JSON.stringify(items),
        "submitted",
        stamp(),
        now() + 86400000,
        rx?.id || null,
        key,
        hash,
      );
      event(
        id,
        "submitted",
        u.id,
        "Availability request only. Pharmacist review required.",
      );
      audit(u.id, "request.created", id);
    });
    notify(u.id, p.id);
    return request(u, id);
  }
  function transition(u, id, input) {
    expire();
    const prior = request(u, id);
    if (prior.status === input.status && prior.revision === input.revision + 1)
      return prior;
    if (prior.revision !== input.revision)
      fail("Request changed. Refresh before responding.", 409);
    if (terminal.has(prior.status))
      fail("This request is already closed.", 409);
    const isCustomer = u.id === prior.user_id,
      isOwner =
        u.role === "pharmacy" && partner(prior.pharmacy_id)?.ownerId === u.id;
    if (isCustomer) {
      if (input.status !== "cancelled")
        fail("Customers can cancel their own requests.", 403);
    } else if (!isOwner) fail("Only this pharmacy can respond.", 403);
    else if (!(transitions[prior.status] || []).includes(input.status))
      fail("Invalid status transition.", 409);
    if (
      input.status === "confirmed" &&
      (!partner(prior.pharmacy_id)?.approved ||
        input.reviewed !== true ||
        typeof input.reviewNote !== "string" ||
        input.reviewNote.trim().length < 5 ||
        input.reviewNote.length > 500)
    )
      fail(
        "An approved pharmacy must record pharmacist review before confirming. Unknown prescription classification always requires review.",
      );
    transaction(() => {
      let quote = null,
        items = prior.items;
      if (input.status === "confirmed") {
        quote = 0;
        items = items.map((item) => {
          const s = db
            .prepare(
              "SELECT * FROM partner_inventory WHERE pharmacy_id=? AND medicine_id=?",
            )
            .get(prior.pharmacy_id, item.medicineId);
          if (
            !s ||
            s.identity !== identity(item.medicineId) ||
            item.identity !== s.identity ||
            now() - Date.parse(s.updated_at) >= 86400000 ||
            !unexpired(s) ||
            s.quantity < item.quantity
          )
            fail(
              "Current stock cannot fulfil all items. Update inventory or mark unavailable.",
              409,
            );
          const changed = db
            .prepare(
              "UPDATE partner_inventory SET quantity=quantity-?,revision=revision+1 WHERE pharmacy_id=? AND medicine_id=? AND revision=? AND quantity>=?",
            )
            .run(
              item.quantity,
              prior.pharmacy_id,
              item.medicineId,
              s.revision,
              item.quantity,
            );
          if (changed.changes !== 1) fail("Stock changed. Try again.", 409);
          quote = Math.round((quote + s.price * item.quantity) * 100) / 100;
          return { ...item, unit: s.unit, price: s.price, currency: "INR" };
        });
      }
      if (input.status === "cancelled")
        release({ ...prior, items: JSON.stringify(prior.items) });
      db.prepare(
        "UPDATE requests SET status=?,revision=revision+1,items=?,reviewed_by=COALESCE(?,reviewed_by),review_note=COALESCE(?,review_note),quote=COALESCE(?,quote) WHERE id=?",
      ).run(
        input.status,
        JSON.stringify(items),
        input.status === "confirmed" ? u.id : null,
        input.status === "confirmed" ? input.reviewNote.trim() : null,
        quote,
        id,
      );
      event(
        id,
        input.status,
        u.id,
        input.status === "confirmed"
          ? "Pharmacist review recorded."
          : String(input.note || "").slice(0, 250),
      );
      audit(u.id, `request.${input.status}`, id);
    });
    notify(prior.user_id, prior.pharmacy_id);
    events.emit("inventory");
    return request(u, id);
  }
  function discover(ids, center) {
    if (
      !Array.isArray(ids) ||
      ids.length > 8 ||
      ids.some((id) => !catalog.get(id))
    )
      fail("Select up to eight catalog medicines.");
    expire();
    return db
      .prepare("SELECT id FROM partners WHERE approved=1 AND demo=? LIMIT 100")
      .all(mode === "demo" ? 1 : 0)
      .map(({ id }) => {
        const p = partner(id),
          stock = inventory(id);
        const items = ids.map((medicineId) => {
          const s = stock.find((s) => s.medicine_id === medicineId);
          return {
            medicineId,
            status:
              !s || !s.fresh
                ? "unknown"
                : s.quantity > 0
                  ? "confirmed_in_stock"
                  : "confirmed_out_of_stock",
            source: p.demo
              ? "fictional demo stock"
              : "partner-managed inventory",
            quantity: s?.fresh ? s.quantity : null,
            price: s?.fresh ? s.price : null,
            unit: s?.unit || null,
            updatedAt: s?.updated_at || null,
            currency: "INR",
          };
        });
        return {
          id: p.id,
          name: p.name,
          address: p.address,
          lat: p.lat,
          lng: p.lng,
          phone: p.phone,
          hours: p.hours,
          demo: p.demo,
          approved: p.approved,
          distanceKm: distanceKm(center, p),
          items,
          fulfilsAll:
            items.length > 0 &&
            items.every((x) => x.status === "confirmed_in_stock"),
        };
      })
      .filter((p) => p.distanceKm <= 25)
      .sort(
        (a, b) =>
          Number(b.fulfilsAll) - Number(a.fulfilsAll) ||
          a.distanceKm - b.distanceKm,
      );
  }
  function report(u, kind, entity, note) {
    if (!["ocr_error", "ai_selection", "catalog"].includes(kind))
      fail("Unknown report type.");
    db.prepare(
      "INSERT INTO review_reports(user_id,kind,entity,note,at) VALUES (?,?,?,?,?)",
    ).run(
      u?.id || null,
      kind,
      String(entity || "").slice(0, 64),
      String(note || "").slice(0, 250),
      stamp(),
    );
  }
  function admin(u) {
    if (u.role !== "admin") fail("Admin role required.", 403);
    return {
      partners: db
        .prepare("SELECT id FROM partners LIMIT 100")
        .all()
        .map((p) => partner(p.id)),
      users: db.prepare("SELECT * FROM users LIMIT 100").all().map(publicUser),
      requests: requests(u),
      audit: db
        .prepare("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100")
        .all(),
      reports: db
        .prepare("SELECT * FROM review_reports ORDER BY id DESC LIMIT 100")
        .all(),
      catalog: db
        .prepare("SELECT id FROM medicines LIMIT 100")
        .all()
        .map((m) => ({
          ...catalog.get(m.id),
          review:
            db
              .prepare("SELECT * FROM catalog_reviews WHERE medicine_id=?")
              .get(m.id) || null,
        })),
      health: {
        database: "connected",
        mode,
        ocr: "local Tesseract",
        payments: "disabled",
        delivery: "disabled",
        sms: "disabled",
      },
    };
  }
  return {
    db,
    mode,
    events,
    now,
    stamp,
    audit,
    user,
    partner,
    ownPartner,
    register,
    login,
    session,
    authenticate,
    logout,
    registerPartner,
    approve,
    inventory,
    updateStock,
    importStock,
    createRequest,
    transition,
    request,
    requests,
    discover,
    expire,
    admin,
    report,
    seedDemo,
    fail,
  };
}
module.exports = { createPlatform, passwordHash, fail };
