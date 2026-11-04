// npm run import:pincodes -- <all_india_pincode.csv>
//
// Imports the Government of India "All India Pincode Directory" (data.gov.in, Open Government Data
// licence) into the pincodes table. Each pincode gets the average coordinates of its post offices.
// Expected columns (case-insensitive): pincode, officename, districtname, statename, latitude, longitude.
import { readFileSync } from "node:fs";
import { openDatabase } from "../db/db.ts";
import { createPincodes, type PinPlace } from "../geo/pincode.ts";
import { parseDelimited } from "../kb/import.ts";

const file = process.argv[2];
if (!file) { console.error("Usage: npm run import:pincodes -- all_india_pincode.csv"); process.exit(1); }
const rows = parseDelimited(readFileSync(file, "utf8").replace(/^﻿/, ""), ",");
const h = rows[0].map((c) => c.toLowerCase().replace(/[^a-z]/g, ""));
const col = (...names: string[]) => h.findIndex((c) => names.includes(c));
const iPin = col("pincode"), iOffice = col("officename"), iDist = col("districtname", "district"), iState = col("statename", "state"), iLat = col("latitude"), iLng = col("longitude");
if ([iPin, iLat, iLng].some((i) => i < 0)) { console.error("✖ Need pincode, latitude and longitude columns."); process.exit(1); }

const acc = new Map<string, { place: string; district: string | null; state: string | null; lat: number[]; lng: number[] }>();
for (const r of rows.slice(1)) {
  const pin = (r[iPin] ?? "").trim(), lat = Number(r[iLat]), lng = Number(r[iLng]);
  if (!/^[1-9]\d{5}$/.test(pin) || !(lat > 6 && lat < 37.5 && lng > 68 && lng < 97.5)) continue;
  const a = acc.get(pin) ?? { place: (r[iOffice] ?? "").replace(/\s+(B\.?O|S\.?O|H\.?O)\.?$/i, "").trim(), district: r[iDist] || null, state: r[iState] || null, lat: [], lng: [] };
  a.lat.push(lat); a.lng.push(lng);
  acc.set(pin, a);
}
const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const out: PinPlace[] = [...acc].map(([pincode, a]) => ({ pincode, place: a.place || pincode, district: a.district, state: a.state, lat: +avg(a.lat).toFixed(5), lng: +avg(a.lng).toFixed(5), source: "India Post, All India Pincode Directory (data.gov.in)" }));
const db = openDatabase(process.env.DATABASE_PATH ?? "var/medifast.db");
createPincodes(db).importRows(out);
console.log(`✔ Imported ${out.length} pincodes from ${rows.length - 1} post-office rows.`);
