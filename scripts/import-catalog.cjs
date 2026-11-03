const fs = require("node:fs");
const { openCatalog, validate } = require("../src/medicine/catalog.cjs");
try {
  const file = process.argv[2];
  if (!file)
    throw Error("Usage: npm run catalog:import -- data/imports/catalog.json");
  if (fs.statSync(file).size > 20 * 1024 * 1024)
    throw Error("Catalog file exceeds 20 MB.");
  const rows = validate(JSON.parse(fs.readFileSync(file, "utf8")));
  const catalog = openCatalog();
  catalog.replace(rows, "catalog");
  catalog.close();
  console.log(
    `Imported ${rows.length} records. Restart MediFast. Provenance remains attached to each record.`,
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
