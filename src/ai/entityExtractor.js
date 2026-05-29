const { detectIntent, normalizeQuery } = require("../services/intentEngine");

const RELATION_TERMS = [
  "papa",
  "father",
  "dad",
  "mummy",
  "mom",
  "mother",
  "maa",
  "child",
  "kid",
  "baby",
  "beta",
  "beti",
  "dada",
  "dadi",
  "nana",
  "nani",
  "self",
  "me",
];

const REORDER_TERMS = ["reorder", "repeat", "refill", "dobara", "phir se"];
const NEARBY_TERMS = ["nearby", "near me", "5km", "10km", "pharmacy", "medical store", "location"];
const SIDE_EFFECT_TERMS = ["side effect", "side effects", "adverse effect", "reaction", "nuksan", "side-effects"];
const PRECAUTION_TERMS = ["precaution", "precautions", "warning", "warnings", "safe", "safety", "avoid", "savdhani"];
const CONDITION_TERMS = ["bp", "blood pressure", "diabetes", "sugar", "asthma", "allergy", "thyroid", "hypertension"];
const DURATION_PATTERNS = [
  /\b(\d+\s*(day|days|din|hour|hours|ghante|week|weeks))\b/i,
  /\b(kal se|aaj se|subah se|raat se|since yesterday|from today)\b/i,
];

const extractFirstMatch = (query, values) => values.find((value) => query.includes(value)) || null;

const cleanupMedicinePhrase = (rawText = "") =>
  String(rawText)
    .replace(/\b(near me|nearby|pharmacy|medical store|5km|10km|location)\b/gi, " ")
    .replace(/\b(what|are|is|the|tell|me|about|of|for|used|uses?|does|do|kaam|ki|ke|ka|kya|hai|hota|hote|medicine|tablet|dawa)\b/gi, " ")
    .replace(/\b(side effects?|side-effects?|adverse effects?|reaction|reactions|precautions?|warnings?|safety|safe|avoid|nuksan|savdhani)\b/gi, " ")
    .replace(/\b(papa|father|dad|mummy|mom|mother|maa|child|kid|baby|beta|beti|dada|dadi|nana|nani|self)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const detectSpecialIntent = (normalized = "") => {
  if (SIDE_EFFECT_TERMS.some((term) => normalized.includes(term))) return "side_effects";
  if (PRECAUTION_TERMS.some((term) => normalized.includes(term))) return "precautions";
  if (NEARBY_TERMS.some((term) => normalized.includes(term))) return "nearby";
  return null;
};

const extractDuration = (rawText) => {
  for (const pattern of DURATION_PATTERNS) {
    const match = rawText.match(pattern);
    if (match) return match[1] || match[0];
  }
  return null;
};

const extractPerson = (normalized = "") => {
  const terms = normalized.includes("near me")
    ? RELATION_TERMS.filter((term) => term !== "me")
    : RELATION_TERMS;
  return extractFirstMatch(normalized, terms);
};

const extractEntities = (rawText = "", profile = null) => {
  const normalized = normalizeQuery(rawText);
  const intent = detectIntent(rawText);
  const profileMember = profile?.familyMembers?.find((member) => {
    const name = normalizeQuery(member.name);
    const relation = normalizeQuery(member.relation);
    return normalized.includes(name) || normalized.includes(relation);
  });

  const specialIntent = detectSpecialIntent(normalized);
  const person = profileMember?.relation || extractPerson(normalized);
  const reorderIntent = REORDER_TERMS.some((term) => normalized.includes(term));
  const nearbyIntent = NEARBY_TERMS.some((term) => normalized.includes(term));
  const condition = extractFirstMatch(normalized, CONDITION_TERMS);
  const extractedMedicine = cleanupMedicinePhrase(rawText);
  const hasGenericMedicineAsk = /\b(medicine|tablet|dawa|goli|meds?)\b/i.test(rawText);
  const meaningfulMedicinePhrase = extractedMedicine && normalizeQuery(extractedMedicine) !== normalizeQuery(rawText)
    ? extractedMedicine
    : null;
  const explicitIntentMedicine =
    intent.confidence !== "medicine" &&
    intent.normalizedQuery &&
    normalized.includes(normalizeQuery(intent.normalizedQuery))
      ? intent.normalizedQuery
      : null;
  const medicine =
    condition && (person || profileMember) && !specialIntent && !nearbyIntent
      ? null
      : hasGenericMedicineAsk && (person || profileMember) && !intent.key && !meaningfulMedicinePhrase
      ? null
      :
    intent.confidence === "medicine"
      ? (specialIntent || nearbyIntent ? meaningfulMedicinePhrase || intent.normalizedQuery : intent.normalizedQuery)
      : explicitIntentMedicine
      ? explicitIntentMedicine
      : null;
  const intentType =
    specialIntent ||
    (nearbyIntent ? "nearby" : null) ||
    (person || profileMember ? "family_context" : null) ||
    (intent.key ? "symptom_lookup" : null) ||
    (medicine ? "medicine_lookup" : "unknown");

  return {
    rawText,
    normalizedText: normalized,
    person,
    familyMemberName: profileMember?.name || null,
    symptom: intent.key && intent.confidence !== "medicine" ? intent.key : null,
    symptomLabel: intent.label || null,
    duration: extractDuration(rawText),
    condition,
    medicine,
    normalizedMedicineQuery: medicine || intent.normalizedQuery,
    intentType,
    reorderIntent,
    nearbyIntent,
    intent,
  };
};

module.exports = {
  extractEntities,
};
