// Identity parsing. Strength, form and release are kept apart from the name and are
// never fuzzy-matched: "Pan 20" must never silently become "Pan 40".

export const FORM_WORDS: Record<string, string> = {
  tab: "tablet", tabs: "tablet", tablet: "tablet", tablets: "tablet",
  cap: "capsule", caps: "capsule", capsule: "capsule", capsules: "capsule",
  syrup: "syrup", syp: "syrup", suspension: "suspension", susp: "suspension",
  cream: "cream", gel: "gel", ointment: "ointment", oint: "ointment",
  drops: "drops", drop: "drops", inhaler: "inhaler", puff: "inhaler",
  spray: "spray", sachet: "sachet", powder: "sachet", injection: "injection", inj: "injection",
};
const RELEASE = /^(sr|er|xr|cr|mr|xl|retard|od)$/;
const STRENGTH = /\d+(?:\.\d+)?\s*(?:mcg|mg|ml|g|iu|%)?/g;

export function normalize(input = ""): string {
  return String(input)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[µμ]g/g, "mcg")
    .replace(/[×]/g, " x ")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9.%+/\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s+/g, " ")
    .trim();
}

export type ParsedIdentity = {
  normalized: string;
  name: string;
  forms: string[];
  release: string[];
  strengths: string[];
};

export function parseIdentity(input: string): ParsedIdentity {
  const normalized = normalize(input).replace(/(\d) (mcg|mg|ml|g|iu)\b/g, "$1$2");
  const words = normalized.split(" ");
  const forms = [...new Set(words.filter((w) => FORM_WORDS[w]).map((w) => FORM_WORDS[w]))];
  const release = words.filter((w) => RELEASE.test(w));
  const strengths = [...normalized.matchAll(STRENGTH)].map((m) => m[0].replace(/\s/g, ""));
  const name = normalized
    .replace(STRENGTH, " ")
    .split(" ")
    .filter((w) => w && !FORM_WORDS[w] && !RELEASE.test(w) && !["/", "+", "w", "v", "x"].includes(w))
    .join(" ")
    .trim();
  return { normalized, name, forms, release, strengths };
}

const num = (s: string) => parseFloat(s);
const unit = (s: string) => s.replace(/^[\d.]+/, "");

/** Do the explicit constraints in a query agree with one of the given strength lists? */
export function strengthsAgree(query: string[], candidates: string[][]): boolean {
  if (!query.length) return true;
  return candidates.some(
    (list) =>
      list.length === query.length &&
      query.every((q, i) => num(q) === num(list[i]) && (!unit(q) || !unit(list[i]) || unit(q) === unit(list[i]))),
  );
}

export function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

export function phonetic(s: string): string {
  return s
    .replace(/\s/g, "")
    .replace(/ph/g, "f")
    .replace(/ck|q/g, "k")
    .replace(/c/g, "k")
    .replace(/z/g, "s")
    .replace(/(.)\1/g, "$1")
    .replace(/[aeiouy]/g, "");
}

/** Pull a trailing quantity out of a line: "Dolo 650 x2", "pan 40 - 3 strips". */
export function splitQuantity(line: string): { text: string; qty: number } {
  const m =
    line.match(/^(.*?)[\s,-]*(?:x|×|qty|quantity)\s*:?\s*(\d{1,2})\s*$/i) ||
    line.match(/^(.*?)[\s,-]+(\d{1,2})\s*(?:strips?|bottles?|tubes?|packs?|boxes?|inhalers?|sachets?|pcs)\s*$/i);
  if (m && m[1].trim()) return { text: m[1].trim(), qty: Math.min(20, Math.max(1, Number(m[2]))) };
  return { text: line.trim(), qty: 1 };
}

/** Split free text into medicine lines: newlines, commas, semicolons, " and ". */
export function splitLines(text: string): string[] {
  return text
    .split(/\n|;|,(?!\d)|\band\b|\baur\b/i)
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-•*])\s*/, "").trim())
    .filter((s) => s.length >= 2)
    .slice(0, 12);
}
