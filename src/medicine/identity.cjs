// Keep strength and formulation separate from the name; never fuzzy-match them.
const normalize = (s = "") =>
  String(s)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[µμ]g/g, "mcg")
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .replace(/[^a-z0-9.%+/\s-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s*\+\s*/g, " + ")
    .replace(/\s+/g, " ")
    .trim();
const formWords = {
  tablets: "tablet",
  tab: "tablet",
  tabs: "tablet",
  tablet: "tablet",
  capsules: "capsule",
  caps: "capsule",
  cap: "capsule",
  capsule: "capsule",
  syrup: "syrup",
  suspension: "suspension",
  liquid: "liquid",
  cream: "cream",
  gel: "gel",
  injection: "injection",
  drops: "drops",
  inhaler: "inhaler",
};
function parseIdentity(input) {
  const normalized = normalize(input);
  const words = normalized.split(" ");
  const forms = words.filter((w) => formWords[w]).map((w) => formWords[w]);
  const release = words.filter((w) => /^(sr|er|xr|cr|mr|retard)$/.test(w));
  const strengths = [
    ...normalized.matchAll(/\d+(?:\.\d+)?\s*(?:mcg|mg|ml|g|iu|units|%)?/g),
  ].map((m) => m[0].replace(/\s/g, ""));
  const name = normalized
    .replace(/\d+(?:\.\d+)?\s*(?:mcg|mg|ml|g|iu|units|%)?/g, " ")
    .split(" ")
    .filter((w) => w && !formWords[w] && !release.includes(w) && w !== "/")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return { normalized, name, forms, release, strengths };
}
function compatible(query, medicine) {
  const item = parseIdentity(
    `${medicine.strength || ""} ${medicine.form || ""}`,
  );
  if (query.forms.some((f) => !item.forms.includes(f))) return false;
  if (query.release.join() !== item.release.join() && query.release.length)
    return false;
  if (query.strengths.length) {
    if (query.strengths.length !== item.strengths.length) return false;
    if (
      query.strengths.some((s, i) =>
        /[a-z%]/.test(s)
          ? s !== item.strengths[i]
          : parseFloat(s) !== parseFloat(item.strengths[i]),
      )
    )
      return false;
  }
  return true;
}
// Iterative edit distance retained from careops-servicenow's phonetics helper.
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++)
      row[j] = Math.min(
        row[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    prev = row;
  }
  return prev[b.length];
}
function phonetic(s) {
  return s
    .replace(/ph/g, "f")
    .replace(/ck/g, "k")
    .replace(/c/g, "k")
    .replace(/(.)\1/g, "$1")
    .replace(/[aeiou]/g, "");
}
module.exports = { normalize, parseIdentity, compatible, distance, phonetic };
