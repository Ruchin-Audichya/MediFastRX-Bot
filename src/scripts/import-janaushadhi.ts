// npm run import:janaushadhi -- <file.csv|file.tsv|file.txt> [--as-of YYYY-MM-DD] [--source "..."]
//
// Imports the official PMBJP (Jan Aushadhi) product list into data/janaushadhi.json.
// Get the list from janaushadhi.gov.in (Product List) or the PIB annexure, then:
//   - Excel/CSV: save as CSV and pass it here.
//   - PDF: open it in Excel (Data → Get Data → From PDF) or Word, save the table as CSV.
//     On Linux/macOS you can also run `pdftotext -layout list.pdf list.txt` and pass the .txt.
// Columns are detected by header names (drug code, generic name, unit/pack, MRP, group).
import { readFileSync, writeFileSync } from "node:fs";
import { parseDelimited, parseLayoutText, toItems } from "../kb/import.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
if (!file) { console.error("Usage: npm run import:janaushadhi -- <file.csv|.tsv|.txt> [--as-of 2025-12-31]"); process.exit(1); }

const raw = readFileSync(file, "utf8").replace(/^﻿/, "");
const rows = /\.txt$/i.test(file) ? parseLayoutText(raw) : parseDelimited(raw, /\.tsv$/i.test(file) || raw.split("\n")[0].includes("\t") ? "\t" : ",");
const items = toItems(rows);
if (items.length < 10) { console.error(`✖ Only ${items.length} rows recognised. Check the file has a header row with 'Generic Name' and 'MRP' columns.`); process.exit(1); }
const out = { source: opt("source") ?? "PMBJP (Jan Aushadhi) product list, Department of Pharmaceuticals, Government of India", asOf: opt("as-of") ?? new Date().toISOString().slice(0, 10), items };
writeFileSync(new URL("../../data/janaushadhi.json", import.meta.url), JSON.stringify(out, null, 1));
console.log(`✔ Imported ${items.length} Jan Aushadhi medicines → data/janaushadhi.json`);
console.log(`  Sample: ${items.slice(0, 3).map((i) => `${i.name} (${i.unit}, ₹${i.mrp ?? "?"})`).join(" · ")}`);
