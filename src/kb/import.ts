// Parsers for the official PMBJP (Jan Aushadhi) product list: CSV/TSV exports or `pdftotext -layout` text.
import type { JanItem } from "./kb.ts";

export function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.map((r) => r.map((c) => c.replace(/\s+/g, " ").trim())).filter((r) => r.some(Boolean));
}

/** pdftotext -layout output: columns separated by 2+ spaces; rows start with a serial number. */
export function parseLayoutText(text: string): string[][] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => l.split(/\s{2,}/));
}

export function toItems(rows: string[][]): JanItem[] {
  const headerIdx = rows.findIndex((r) => r.some((c) => /generic|product|medicine|drug name/i.test(c)) && r.some((c) => /mrp|price|code/i.test(c)));
  const items: JanItem[] = [];
  if (headerIdx >= 0) {
    const h = rows[headerIdx].map((c) => c.toLowerCase());
    const col = (re: RegExp) => h.findIndex((c) => re.test(c));
    const iCode = col(/code/), iName = col(/generic|product|medicine|drug name|name/), iUnit = col(/unit|pack/), iMrp = col(/mrp|price/), iGroup = col(/group|category|therap/);
    for (const r of rows.slice(headerIdx + 1)) {
      const name = r[iName]?.trim();
      if (!name || /^(generic|product)/i.test(name)) continue;
      const mrp = iMrp >= 0 ? Number(String(r[iMrp]).replace(/[^\d.]/g, "")) : NaN;
      items.push({ code: iCode >= 0 ? r[iCode] ?? "" : "", name, unit: iUnit >= 0 ? r[iUnit] ?? "" : "", mrp: Number.isFinite(mrp) && mrp > 0 ? mrp : null, group: iGroup >= 0 && r[iGroup] ? r[iGroup] : null });
    }
  } else {
    // Headerless layout text: "<sr> <code> <name> <unit> <mrp> [group]"
    for (const r of rows) {
      if (!/^\d+$/.test(r[0] ?? "") || r.length < 4) continue;
      const mrpIdx = r.findIndex((c, i) => i >= 3 && /^\d+(\.\d+)?$/.test(c));
      if (mrpIdx < 0) continue;
      items.push({ code: r[1], name: r[2], unit: r.slice(3, mrpIdx).join(" "), mrp: Number(r[mrpIdx]), group: r[mrpIdx + 1] ?? null });
    }
  }
  const seen = new Set<string>();
  return items.filter((it) => { const k = `${it.code}|${it.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

