const { parse } = require("csv-parse/sync");
const fields = {
  name: ["itemname", "item", "product", "productname", "medicinename", "name"],
  strength: ["strength"],
  form: ["form", "formulation"],
  quantity: ["closingstock", "stock", "qty", "quantity", "balance"],
  unit: ["unit", "stockunit"],
  pack: ["pack", "packing", "packsize"],
  mrp: ["mrp", "rate"],
  batch: ["batch", "batchno", "batchnumber"],
  expiry: ["expiry", "exp", "expdate", "expirydate"],
};
const cleanKey = (x) =>
  String(x)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
function readSheet(text) {
  if (
    typeof text !== "string" ||
    Buffer.byteLength(text) > 300000 ||
    !text.trim()
  )
    throw Error("Choose a CSV/TSV file or paste rows, up to 300 KB.");
  const line = text.replace(/^\uFEFF/, "").split(/\r?\n/)[0];
  const delimiter = line.includes("\t")
    ? "\t"
    : line.includes(";") && !line.includes(",")
      ? ";"
      : ",";
  let rows;
  try {
    rows = parse(text, {
      bom: true,
      delimiter,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 6000,
      relax_column_count: true,
    });
  } catch {
    throw Error(
      "Could not read this sheet. Export UTF-8 CSV, with one header row and no report title.",
    );
  }
  if (rows.length < 2 || rows.length > 1001)
    throw Error("Include a header and 1–1,000 product rows.");
  const headers = rows.shift();
  if (
    headers.length > 30 ||
    headers.some((h) => !h || h.length > 80) ||
    new Set(headers).size !== headers.length
  )
    throw Error("Use 1–30 distinct, non-empty column headings.");
  const mapping = {};
  for (const [key, aliases] of Object.entries(fields))
    mapping[key] = headers.find((h) => aliases.includes(cleanKey(h))) || "";
  return { headers, rows, mapping };
}
function expiryDate(value) {
  if (!value) return null;
  let y, m, d;
  let a;
  if ((a = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value))) {
    [, y, m, d] = a;
  } else if ((a = /^(\d{1,2})[/-](\d{4})$/.exec(value))) {
    m = a[1];
    y = a[2];
  } else return false;
  y = Number(y);
  m = Number(m);
  d = d ? Number(d) : new Date(Date.UTC(y, m, 0)).getUTCDate();
  const date = new Date(Date.UTC(y, m - 1, d));
  return y >= 2000 &&
    y < 2100 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
    ? date.toISOString().slice(0, 10)
    : false;
}
module.exports = { readSheet, expiryDate };
