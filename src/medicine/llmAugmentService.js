"use strict";

// LLM-augment service — when the deterministic resolver + RAG return nothing
// confident, we fall back to a tightly-scoped Groq lookup so the user gets a
// useful answer instead of a dead-end "not found".
//
// Safety contract (do NOT loosen):
//   - Only triggers when the query LOOKS like a medicine name (1-3 words,
//     mostly letters/digits) — not a free-form sentence or symptom query.
//   - System prompt forbids dosage, stock, prescription advice, and any
//     claim that pretends to be from MediFast's verified database.
//   - Output is post-sanitized: any line that mentions a numeric dose
//     ("take 500 mg twice daily"), prescription advice, or pharmacy stock
//     gets stripped before the user sees it.
//   - The user-facing card carries a soft "compiled from general knowledge"
//     footnote so confidence is honest.
//   - Every augmented turn is persisted to `UnmatchedMedicineEnrichment`
//     for admin review and future DB enrichment ("training our thing").
//   - Strict timeout (LLM_AUGMENT_TIMEOUT_MS, default 4000ms).

const { createProvider } = require("../providers");
const UnmatchedMedicineEnrichment = require("../models/UnmatchedMedicineEnrichment");
const eventBus = require("../events/eventBus");
const logger = require("../utils/logger");

const ENABLED = () => process.env.ENABLE_LLM_AUGMENT !== "false"; // default ON
const TIMEOUT_MS = () => Number(process.env.LLM_AUGMENT_TIMEOUT_MS || 4000);
const MAX_QUERY_LENGTH = 64;

// Heuristic: query looks like a medicine name vs a free-form question.
// Keeps LLM use scoped to "user typed a medicine word/brand we don't know".
const looksLikeMedicineQuery = (query = "") => {
  const q = String(query || "").trim();
  if (!q || q.length > MAX_QUERY_LENGTH) return false;
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  // Must start with a letter, allow digits + dashes (Dolo650, Telma-AM, Pan-D).
  if (!/^[A-Za-z][A-Za-z0-9\s\-+/.]{0,63}$/.test(q)) return false;
  // Reject obvious sentences/questions.
  if (/\b(what|how|why|when|where|can|does|do|is|are|use|side|effect|nearby|near|me)\b/i.test(q)) {
    return false;
  }
  return true;
};

const SYSTEM_PROMPT = [
  "You are MediFast AI helping a user understand a medicine that is not yet in our verified database.",
  "Answer ONLY from your general medical knowledge.",
  "Be brief: 2-3 short sentences. Plain text. No headers, no bullet lists.",
  "Cover: what the medicine is generally used for, the typical generic / salt if widely known, and one common safety note.",
  "STRICT RULES — do not break any of these:",
  "- Never recommend a dose, frequency, duration, or quantity (no 'take 500 mg', no 'twice daily', no 'for 5 days').",
  "- Never state stock, availability, price, or pharmacy information.",
  "- Never tell the user to take, stop, increase, or change any medicine.",
  "- Never claim this came from MediFast's database.",
  "- If you do not know this medicine confidently, say so in one sentence and recommend speaking to a pharmacist.",
  "End with: 'Please confirm with a pharmacist or doctor before use.'",
].join(" ");

// Post-LLM sanitizer: strip any line that violates the safety floor even if
// the model slipped. Belt-and-suspenders alongside the system prompt.
const DOSE_LINE_PATTERNS = [
  /\b\d+\s?(mg|mcg|g|ml|tab|tablets?|capsules?|drops?|units?|iu)\b/i,
  /\btake\s+\d/i,
  /\b(twice|once|thrice|three|four)\s+daily\b/i,
  /\bevery\s+\d+\s*(hour|hours|hr|hrs)\b/i,
  /\bfor\s+\d+\s+days\b/i,
];
const STRIP_LINE_PATTERNS = [
  /\bin\s+stock\b/i,
  /\bavailable\s+at\b.*pharmacy/i,
  /\b(?:rs\.?|inr|₹)\s?\d/i,
  /\bprescription\s+is\s+required\b/i,
];

const stripUnsafeLines = (text = "") => {
  const lines = String(text || "").split(/\r?\n/);
  const safe = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      safe.push("");
      continue;
    }
    if (DOSE_LINE_PATTERNS.some((re) => re.test(trimmed))) continue;
    if (STRIP_LINE_PATTERNS.some((re) => re.test(trimmed))) continue;
    safe.push(line);
  }
  // Also catch in-line "X mg" inside an otherwise-safe sentence by replacing.
  return safe
    .join("\n")
    .replace(/\s\d+\s?(mg|mcg|g|ml|tab|tablets?|capsules?|drops?|units?|iu)\b/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const callGroqAugment = async ({ query }) => {
  // We use the existing provider factory so AbortController + timeout +
  // sanitizer + safety prompt all stay consistent with the main path.
  const provider = createProvider();
  const timeoutMs = TIMEOUT_MS();
  const evidenceShim = {
    medicineContext: { medicine: null },
    ragContext: { context: [] },
    augmentMode: true,
  };
  // Race the provider against a hard timeout so we never block the reply.
  const result = await Promise.race([
    provider.generate({
      prompt: query,
      fallback: "",
      context: [],
      memory: [],
      evidence: evidenceShim,
      systemPromptOverride: SYSTEM_PROMPT,
    }),
    new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            text: "",
            ok: false,
            provider: "groq",
            model: "augment-timeout",
            error: "augment_timeout",
          }),
        timeoutMs
      )
    ),
  ]);
  return result;
};

// Persist the (query, answer) pair so admins can promote good answers into the
// real catalog. We dedupe by `key = telegramId:normalized(query)` so re-asks
// from the same user roll up to one record.
const recordEnrichment = async ({
  telegramId,
  query,
  normalizedQuery,
  answer,
  provider,
  model,
  ok,
}) => {
  try {
    const normalized = String(normalizedQuery || query || "").trim().toLowerCase();
    const key = `augment:${telegramId || "anon"}:${normalized}`;
    await UnmatchedMedicineEnrichment.findOneAndUpdate(
      { key },
      {
        key,
        enrichmentType: "llm_augment_unknown_medicine",
        rawIdentity: String(query || "").slice(0, 256),
        normalizedIdentity: normalized,
        confidence: ok ? 0.5 : 0.0,
        reason: ok ? "groq_augmented" : "augment_failed",
        payload: {
          telegramId: telegramId ? String(telegramId) : undefined,
          provider,
          model,
          answer: String(answer || "").slice(0, 4000),
          observedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    eventBus.emitSafe("enrichment.captured", {
      telegramId,
      query,
      normalizedQuery: normalized,
      ok,
    });
  } catch (error) {
    // Persistence is best-effort — never block the user reply.
    logger.warn(`UnmatchedMedicineEnrichment write skipped: ${error.message}`);
  }
};

/**
 * Try to augment an unknown-medicine query via Groq. Returns:
 *   { ok: true, text, provider, model, augmented: true } on success
 *   { ok: false, augmented: false, reason } when skipped or failed
 */
const augmentUnknownMedicine = async ({
  telegramId,
  query,
  normalizedQuery,
} = {}) => {
  if (!ENABLED()) return { ok: false, augmented: false, reason: "disabled" };
  if (!looksLikeMedicineQuery(query)) {
    return { ok: false, augmented: false, reason: "query_not_medicine_like" };
  }

  const startedAt = Date.now();
  const result = await callGroqAugment({ query });
  const latencyMs = Date.now() - startedAt;
  const rawText = String(result?.text || "").trim();
  const safeText = stripUnsafeLines(rawText);
  const ok = Boolean(result?.ok && safeText);

  eventBus.emitSafe("llm.augment.used", {
    telegramId,
    query,
    ok,
    latencyMs,
    provider: result?.provider || null,
    model: result?.model || null,
    sanitizedDelta: rawText.length - safeText.length,
  });

  // Fire-and-forget DB log so we capture the seed for future enrichment.
  recordEnrichment({
    telegramId,
    query,
    normalizedQuery,
    answer: safeText || rawText,
    provider: result?.provider || null,
    model: result?.model || null,
    ok,
  });

  if (!ok) {
    return {
      ok: false,
      augmented: false,
      reason: result?.error || "augment_no_text",
      provider: result?.provider,
      model: result?.model,
    };
  }

  return {
    ok: true,
    augmented: true,
    text: safeText,
    provider: result.provider,
    model: result.model,
    latencyMs,
  };
};

module.exports = {
  augmentUnknownMedicine,
  looksLikeMedicineQuery,
  stripUnsafeLines,
  // exposed for tests
  __internals: { SYSTEM_PROMPT, TIMEOUT_MS, ENABLED },
};
