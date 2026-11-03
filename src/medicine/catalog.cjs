const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalize,
  parseIdentity,
  compatible,
  distance,
  phonetic,
} = require("./identity.cjs");
const demo = require("../../data/demo-medicines.json");
function validate(records) {
  if (!Array.isArray(records) || !records.length || records.length > 20000)
    throw Error("Catalog must contain 1–20,000 records.");
  const ids = new Set();
  for (const m of records) {
    if (
      !m ||
      typeof m !== "object" ||
      !/^[-a-z0-9]{1,64}$/.test(m.id) ||
      ids.has(m.id)
    )
      throw Error(
        "Each medicine needs a unique lowercase id (letters, digits, hyphens).",
      );
    ids.add(m.id);
    for (const field of ["name", "generic"])
      if (
        typeof m[field] !== "string" ||
        !m[field].trim() ||
        m[field].length > 160
      )
        throw Error(`Invalid ${field} on ${m.id}.`);
    for (const field of [
      "strength",
      "form",
      "description",
      "simple",
      "reviewedAt",
    ])
      if (
        m[field] != null &&
        (typeof m[field] !== "string" || m[field].length > 2000)
      )
        throw Error(`Invalid ${field} on ${m.id}.`);
    for (const field of ["aliases", "sideEffects", "precautions"])
      if (
        m[field] != null &&
        (!Array.isArray(m[field]) ||
          m[field].length > 30 ||
          m[field].some((x) => typeof x !== "string" || x.length > 500))
      )
        throw Error(`Invalid ${field} on ${m.id}.`);
    if (
      !Array.isArray(m.sources) ||
      !m.sources.length ||
      m.sources.length > 10 ||
      m.sources.some(
        (s) =>
          !s ||
          typeof s.label !== "string" ||
          s.label.length > 150 ||
          typeof s.url !== "string" ||
          s.url.length > 1000 ||
          !/^https:\/\//.test(s.url),
      )
    )
      throw Error(`Add HTTPS provenance sources to ${m.id}.`);
  }
  return records;
}
function openCatalog(
  file = process.env.CATALOG_FILE || path.resolve(".local/catalog.sqlite"),
  seed = demo,
) {
  if (file !== ":memory:")
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") fs.chmodSync(file, 0o600);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS medicines(id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS terms(term TEXT, medicine_id TEXT, kind TEXT, len INTEGER, prefix TEXT, sound TEXT, PRIMARY KEY(term,medicine_id,kind)); CREATE INDEX IF NOT EXISTS term_lookup ON terms(term); CREATE INDEX IF NOT EXISTS term_prefix ON terms(prefix,len); CREATE INDEX IF NOT EXISTS term_sound ON terms(sound,len); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT);",
  );
  function replace(records, mode = "catalog") {
    validate(records);
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM medicines; DELETE FROM terms;");
      const put = db.prepare("INSERT INTO medicines VALUES (?,?)"),
        term = db.prepare("INSERT OR IGNORE INTO terms VALUES (?,?,?,?,?,?)");
      for (const m of records) {
        const clean = {
          id: m.id,
          name: m.name,
          generic: m.generic,
          strength: m.strength || null,
          form: m.form || null,
          aliases: m.aliases || [],
          description: m.description || null,
          simple: m.simple || null,
          sideEffects: m.sideEffects || [],
          precautions: m.precautions || [],
          sources: m.sources,
          reviewedAt: m.reviewedAt || null,
          demo: mode === "demo",
        };
        put.run(clean.id, JSON.stringify(clean));
        const full = [
          `${m.name} ${m.strength || ""} ${m.form || ""}`,
          ...(m.aliases || []),
        ];
        for (const [names, kind] of [
          [[m.name, m.generic], "name"],
          [full, "full"],
        ])
          for (const name of names) {
            const t = normalize(name);
            term.run(t, m.id, kind, t.length, t.slice(0, 2), phonetic(t));
          }
      }
      db.prepare("INSERT OR REPLACE INTO metadata VALUES (?,?)").run(
        "mode",
        mode,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  if (!db.prepare("SELECT id FROM medicines LIMIT 1").get())
    replace(seed, "demo");
  const get = (id) => {
    const row = db.prepare("SELECT body FROM medicines WHERE id=?").get(id);
    return row ? JSON.parse(row.body) : null;
  };
  const rows = (terms) =>
    [...new Set(terms.map((t) => t.medicine_id))].map(get);
  function resolve(input) {
    const q = parseIdentity(input);
    if (q.name.length < 3 || q.normalized.length > 120)
      return { status: "not_found", candidates: [], method: "none" };
    const exact = db
      .prepare("SELECT medicine_id FROM terms WHERE term=? LIMIT 24")
      .all(q.normalized);
    let found = rows(exact);
    const isGenericQuery = found.some((m) => normalize(m.generic) === q.name);
    if (found.length && !isGenericQuery) return finish(found, "exact");
    const named = rows(
      db
        .prepare("SELECT medicine_id FROM terms WHERE term=? LIMIT 24")
        .all(q.name),
    );
    if (named.length) {
      found = named.filter((m) => compatible(q, m));
      return finish(found, "exact");
    }
    const pool = db
      .prepare(
        "SELECT term,medicine_id FROM terms WHERE (prefix=? OR sound=?) AND len BETWEEN ? AND ? LIMIT 180",
      )
      .all(
        q.name.slice(0, 2),
        phonetic(q.name),
        q.name.length - 2,
        q.name.length + 2,
      );
    // Never return a fuzzy medicine as confirmed, even if it is the only candidate.
    const close = pool.filter((t) => {
      const d = distance(q.name, t.term);
      return (
        d <= (q.name.length >= 8 ? 2 : 1) &&
        1 - d / Math.max(q.name.length, t.term.length) >= 0.78
      );
    });
    return finish(
      rows(close).filter((m) => compatible(q, m)),
      "spelling",
    );
  }
  function finish(found, method) {
    const candidates = found.slice(0, 8);
    return {
      status: !candidates.length
        ? "not_found"
        : candidates.length === 1 && method === "exact"
          ? "confirmed"
          : "candidates",
      candidates,
      method,
    };
  }
  return {
    db,
    get,
    resolve,
    replace,
    close: () => db.close(),
    status: () => ({
      mode: db.prepare("SELECT value FROM metadata WHERE key='mode'").get()
        .value,
      count: db.prepare("SELECT count(*) AS n FROM medicines").get().n,
    }),
  };
}
module.exports = { openCatalog, validate };
