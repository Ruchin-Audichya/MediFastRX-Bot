import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MIGRATIONS: string[] = [
  `CREATE TABLE users(
     id INTEGER PRIMARY KEY,
     ref TEXT UNIQUE NOT NULL,            -- transport-qualified identity, e.g. live:12345, studio:customer
     transport TEXT NOT NULL,             -- live | studio | sim
     chat_id TEXT NOT NULL,
     name TEXT NOT NULL,
     username TEXT,
     is_admin INTEGER NOT NULL DEFAULT 0,
     lat REAL, lng REAL, place TEXT, radius_km REAL NOT NULL DEFAULT 2,
     created_at INTEGER NOT NULL);
   CREATE TABLE chat_state(user_id INTEGER PRIMARY KEY, state TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE drafts(user_id INTEGER PRIMARY KEY, items TEXT NOT NULL, updated_at INTEGER NOT NULL);
   CREATE TABLE saved(user_id INTEGER NOT NULL, product_id TEXT NOT NULL, qty INTEGER NOT NULL, saved_at INTEGER NOT NULL, PRIMARY KEY(user_id, product_id));
   CREATE TABLE pharmacies(
     id INTEGER PRIMARY KEY,
     owner_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
     name TEXT NOT NULL, area TEXT NOT NULL, address TEXT NOT NULL,
     lat REAL NOT NULL, lng REAL NOT NULL, phone TEXT NOT NULL, license TEXT NOT NULL,
     status TEXT NOT NULL,                -- pending | approved | rejected | suspended
     accepting INTEGER NOT NULL DEFAULT 1,
     demo INTEGER NOT NULL DEFAULT 0,
     sim TEXT,                            -- JSON simulation profile for demo pharmacies
     created_at INTEGER NOT NULL, reviewed_at INTEGER, reviewed_by INTEGER);
   CREATE TABLE asks(
     id TEXT PRIMARY KEY,
     customer_id INTEGER NOT NULL REFERENCES users(id),
     items TEXT NOT NULL,                 -- identity snapshots, never re-resolved
     lat REAL NOT NULL, lng REAL NOT NULL, place TEXT NOT NULL, radius_km REAL NOT NULL,
     status TEXT NOT NULL,                -- open | reserved | expired | cancelled
     created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, closed_at INTEGER,
     board_ref TEXT);
   CREATE INDEX asks_customer ON asks(customer_id, created_at);
   CREATE INDEX asks_open ON asks(status, expires_at);
   CREATE TABLE recipients(
     id INTEGER PRIMARY KEY,
     ask_id TEXT NOT NULL REFERENCES asks(id),
     pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
     distance_m INTEGER NOT NULL,
     state TEXT NOT NULL,                 -- pending | answered | expired | closed | chosen
     draft TEXT,                          -- pharmacist's in-progress per-item marks
     answers TEXT,                        -- submitted per-item answers
     price REAL, note TEXT,
     revision INTEGER NOT NULL DEFAULT 0,
     notified_at INTEGER NOT NULL, answered_at INTEGER,
     message_ref TEXT,
     UNIQUE(ask_id, pharmacy_id));
   CREATE INDEX recipients_pharmacy ON recipients(pharmacy_id, notified_at);
   CREATE TABLE reservations(
     id TEXT PRIMARY KEY,
     ask_id TEXT NOT NULL REFERENCES asks(id),
     recipient_id INTEGER NOT NULL REFERENCES recipients(id),
     pharmacy_id INTEGER NOT NULL REFERENCES pharmacies(id),
     customer_id INTEGER NOT NULL REFERENCES users(id),
     items TEXT NOT NULL,                 -- [{index, when: now|tomorrow}]
     code TEXT NOT NULL,
     status TEXT NOT NULL,                -- held | ready | collected | cancelled | declined | expired
     hold_until INTEGER NOT NULL,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
     customer_ref TEXT, pharmacy_ref TEXT);
   CREATE INDEX reservations_pharmacy ON reservations(pharmacy_id, status);
   CREATE TABLE events(
     id INTEGER PRIMARY KEY,
     ask_id TEXT, kind TEXT NOT NULL, actor INTEGER, data TEXT, at INTEGER NOT NULL);
   CREATE INDEX events_ask ON events(ask_id, at);`,
];

export type DB = DatabaseSync;

export function openDatabase(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

const depth = new WeakMap<DB, number>();
/** Re-entrant: nested calls join the outer transaction. */
export function transaction<T>(db: DB, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) {
    depth.set(db, d + 1);
    try { return fn(); } finally { depth.set(db, d); }
  }
  depth.set(db, 1);
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth.set(db, 0);
  }
}
