"use strict";

// Conversation context service — refactored per design `### 2. Context store /
// follow-up engine`. Stores a canonical MedicineContext keyed by telegramId,
// gates by `MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD`, expires by
// `ACTIVE_CONTEXT_TTL_MS`, detects explicit-new-medicine via the deterministic
// resolver (`normalizeMedicineQuery`), and resolves follow-ups via an
// expanded pattern set.
//
// Contract preserved:
//   resolveContextualQuery(telegramId, text) → { query, usedContext, context, originalQuery? }
//
// Pure module — no Mongo, no Telegram, no logger imports.
//
// IMPORTANT preservation contract: when there is NO active context for the
// caller, this module MUST NOT call the deterministic resolver. The resolver
// performs Mongo I/O and would otherwise stall every non-medicine turn for the
// full mongoose buffer timeout (~10s). The "no active context" branch is a
// cheap pass-through identical to today's behavior (P4.d in the preservation
// test). Caller updates in Task 4.2 will store fresh contexts on the
// successful-search path; this module only exposes the active context.

const { normalizeMedicineQuery } = require("../medicine/medicineNormalizer");
const {
  createMedicineContext,
  getMedicineScope,
  isFresh,
} = require("../context/medicineContext");

const ACTIVE_CONTEXT_TTL_MS = Number(
  process.env.ACTIVE_CONTEXT_TTL_MS || 30 * 60 * 1000
);
const MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD = Number(
  process.env.MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD || 0.6
);

// telegramId (string) -> frozen MedicineContext
const activeContexts = new Map();

// ---------------------------------------------------------------------------
// Helpers (internal).
// ---------------------------------------------------------------------------

const normalizeTelegramId = (telegramId) => {
  if (telegramId === null || telegramId === undefined) return "";
  return String(telegramId);
};

const compactText = (value) => {
  if (value === null || value === undefined) return "";
  return String(value).trim();
};

const lowerTrim = (value) => {
  if (value === null || value === undefined) return "";
  const s = String(value).trim().toLowerCase();
  return s;
};

const buildIdentitySet = (ctx) => {
  const set = new Set();
  const add = (v) => {
    const s = lowerTrim(v);
    if (s) set.add(s);
  };
  add(ctx.medicineName);
  add(ctx.genericName);
  (ctx.aliases || []).forEach(add);
  (ctx.salts || []).forEach(add);
  (ctx.brands || []).forEach(add);
  return set;
};

const isSameIdentity = (ctx, resolvedMedicine) => {
  if (!ctx || !resolvedMedicine || typeof resolvedMedicine !== "object") return false;
  const set = buildIdentitySet(ctx);
  if (set.size === 0) return false;
  const candidates = [
    resolvedMedicine.medicineName,
    resolvedMedicine.genericName,
    ...(Array.isArray(resolvedMedicine.aliases) ? resolvedMedicine.aliases : []),
  ]
    .map(lowerTrim)
    .filter(Boolean);
  return candidates.some((c) => set.has(c));
};

const isHighConfidenceMedicine = (resolution) =>
  Boolean(
    resolution &&
      resolution.type === "medicine" &&
      Number(resolution.confidence || 0) >= MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD
  );

// Defensive resolver wrapper — never throws. Returns null on any error so the
// preservation contract is honored when the resolver cannot run.
const safeResolve = async (text) => {
  try {
    const r = await normalizeMedicineQuery(text);
    return r || null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Expanded follow-up patterns. First match wins. Order is most-specific first
// per design — interactions / precautions / generic come before broader
// alternatives / uses, and the pronoun-only pattern is checked last.
//
// Each `build(medicine, match)` returns the rewritten query string. `match` is
// the regex match array — used by the person-scoped pattern to extract the
// person reference deterministically (so a test can assert the medicine name
// appears in the rewritten query).
// ---------------------------------------------------------------------------

const FOLLOW_UP_PATTERNS = [
  // Side effects / adverse reactions.
  {
    name: "side_effects",
    test: /\b(side\s*effects?|adverse|reaction|reactions|nuksan)\b/i,
    build: (medicine) => `side effects of ${medicine}`,
  },
  // Drug-drug interactions ("can I take it with X", "interaction").
  {
    name: "interactions",
    test:
      /\b(interaction|interactions|drug\s*interaction|with\s+\w+|along\s*with|together\s*with|combined\s*with|mix(?:ed)?\s*with)\b/i,
    build: (medicine) => `interactions of ${medicine}`,
  },
  // Precautions / warnings / safety / avoid.
  {
    name: "precautions",
    test:
      /\b(precaution|precautions?|warning|warnings?|safety|avoid|savdhani|caution)\b/i,
    build: (medicine) => `precautions for ${medicine}`,
  },
  // Generic / salt / active ingredient.
  {
    name: "generic_salt",
    test:
      /\b(what(?:'s|\s+is)?\s+the\s+generic|generic\s+name|salt|active\s+ingredient|kya\s+salt|jenerik)\b/i,
    build: (medicine) => `generic name of ${medicine}`,
  },
  // Alternatives / substitutes / equivalents.
  {
    name: "alternatives",
    test:
      /\b(alternative|alternatives|similar|substitute|substitutes|replacement|swap|other\s+option|kuch\s+aur)\b/i,
    build: (medicine) => `alternatives of ${medicine}`,
  },
  // Nearby pharmacy / availability.
  {
    name: "nearby",
    test:
      /\b(nearby|near\s*me|pharmacy|medical\s*store|where\s+can\s+i\s+(?:get|buy)|available\s+near|kaha\s+milega)\b/i,
    build: (medicine) => `${medicine} near me`,
  },
  // Daily / dosage / how often / how much.
  {
    name: "daily_dosage",
    test:
      /\b(daily|every\s*day|dose|dosage|how\s+(?:often|much)|how\s+many\s+times|kab\s+leni|kab\s+lu|khurak)\b/i,
    build: (medicine) => `dosage of ${medicine}`,
  },
  // Person-scoped safety. Deterministic rewrite always references the active
  // medicine name so callers (and tests) can assert it appears in the query.
  {
    name: "person_scoped",
    test:
      /\b(can\s+(?:my|i)\s+(?:father|dad|papa|mother|mom|mummy|sister|brother|son|daughter|child|kid|baby|wife|husband|grand\w+)\s+(?:take|use|have)|safe\s+for\s+(?:kids?|children|infants?|pregnan\w+|seniors?|elderly)|can\s+(?:he|she|they)\s+(?:take|use))\b/i,
    build: (medicine) => `${medicine} for that family member`,
  },
  // Uses / what does it do (English + Hinglish).
  {
    name: "uses",
    test:
      /\b(what\s+does\s+it\s+do|what\s+is\s+it\s+(?:used\s+for|for)|used\s+for|uses?|kaam|kya\s+(?:karta|karti|hota|hote))\b/i,
    build: (medicine) => `what is ${medicine} used for`,
  },
  // Pronoun-only follow-up ("it", "this", "that medicine", "wahi"...).
  {
    name: "pronoun_only",
    test: /^(it|this|that|that\s+medicine|that\s+one|wahi|yahi)\s*\??$/i,
    build: (medicine) => `what is ${medicine} used for`,
  },
];

const matchFollowUp = (text) => {
  for (const pattern of FOLLOW_UP_PATTERNS) {
    const match = text.match(pattern.test);
    if (match) return { pattern, match };
  }
  return null;
};

// ---------------------------------------------------------------------------
// getActiveContext — synchronous; cleans up expired entries on read.
// ---------------------------------------------------------------------------

const getActiveContext = (telegramId) => {
  const key = normalizeTelegramId(telegramId);
  if (!key) return null;
  const ctx = activeContexts.get(key);
  if (!ctx) return null;
  if (!isFresh(ctx, ACTIVE_CONTEXT_TTL_MS, Date.now())) {
    activeContexts.delete(key);
    return null;
  }
  return ctx;
};

// ---------------------------------------------------------------------------
// clearActiveContext — explicit removal (useful for tests and explicit reset).
// ---------------------------------------------------------------------------

const clearActiveContext = (telegramId) => {
  const key = normalizeTelegramId(telegramId);
  if (!key) return false;
  return activeContexts.delete(key);
};

// ---------------------------------------------------------------------------
// setActiveMedicineContext — accepts:
//   (a) Legacy: { medicineName, genericName, query, aliases?, salts?, brands?, category?, confidence? }
//   (b) Resolution: { resolution, confidence?, conversationId?, userId? }
// Returns the stored MedicineContext, or null when nothing usable is provided.
// ---------------------------------------------------------------------------

const buildLegacyResolution = (payload) => {
  const medicineName = compactText(payload.medicineName);
  const genericName = compactText(payload.genericName);
  const query = compactText(payload.query);
  if (!medicineName && !genericName && !query) return null;
  const canonicalName = medicineName || query || genericName;
  const canonicalGeneric = genericName || canonicalName;
  return {
    medicine: {
      _id: null,
      medicineName: canonicalName,
      genericName: canonicalGeneric,
      aliases: Array.isArray(payload.aliases) ? payload.aliases : [],
      salts: Array.isArray(payload.salts) ? payload.salts : [],
      brands: Array.isArray(payload.brands) ? payload.brands : [],
      category: compactText(payload.category) || null,
    },
    type: "medicine",
    normalizedQuery: query || canonicalName,
    confidence:
      payload.confidence !== undefined && payload.confidence !== null
        ? Number(payload.confidence)
        : 0.95,
    method: "legacy:setActiveMedicineContext",
    reason: "legacy setActiveMedicineContext payload",
    relationships: [],
  };
};

const setActiveMedicineContext = (telegramId, payload = {}) => {
  const key = normalizeTelegramId(telegramId);
  if (!key) return null;
  if (!payload || typeof payload !== "object") return null;

  const hasResolution =
    payload.resolution && typeof payload.resolution === "object";
  const resolution = hasResolution
    ? payload.resolution
    : buildLegacyResolution(payload);
  if (!resolution || typeof resolution !== "object") return null;
  if (!resolution.medicine || typeof resolution.medicine !== "object") {
    return null;
  }

  const conversationId = compactText(payload.conversationId) || key;
  const userId = compactText(payload.userId) || key;

  let ctx;
  try {
    ctx = createMedicineContext({
      resolution,
      conversationId,
      userId,
      now: Date.now(),
    });
  } catch {
    return null;
  }

  if (!ctx || (!ctx.medicineName && !ctx.genericName)) return null;
  activeContexts.set(key, ctx);
  return ctx;
};

// ---------------------------------------------------------------------------
// resolveContextualQuery — async per design. Shape preserved:
//   { query, usedContext, context, originalQuery? }
//
// Order:
//   1. Synchronous fast-path: empty/whitespace text → pass through.
//   2. No active context → pass through unchanged. Do NOT call resolver.
//   3. Active context → run resolver:
//        a. High-conf medicine with different identity → signal context switch
//           (usedContext=false, context=null). The bot/search layer will store
//           the new context after a successful search.
//        b. Otherwise match expanded follow-up patterns and rewrite.
//        c. No follow-up match → pass through, expose active context for the
//           caller (so layers above can still scope nearby/formatter logic).
// ---------------------------------------------------------------------------

const resolveContextualQuery = async (telegramId, text) => {
  // 1. Synchronous fast-path for empty/whitespace input — never touch the
  // resolver and never read the context store.
  if (text === null || text === undefined || String(text).trim() === "") {
    return {
      query: String(text || ""),
      usedContext: false,
      context: null,
    };
  }

  const raw = String(text).trim();
  const activeCtx = getActiveContext(telegramId);

  // 2. No active context — preservation path. Identical to today's shape for
  // every non-medicine input (P4.d). Crucially, do NOT call the deterministic
  // resolver here; it would issue Mongo I/O for every plain-text turn.
  if (!activeCtx) {
    return { query: raw, usedContext: false, context: null };
  }

  // 3. Active context exists. Run the deterministic resolver to detect an
  // explicit new-medicine switch.
  const resolved = await safeResolve(raw);

  if (
    isHighConfidenceMedicine(resolved) &&
    !isSameIdentity(activeCtx, resolved.medicine)
  ) {
    // Signal a context switch to the caller without mutating storage. Task 4.2
    // updates `search.js` to call `setActiveMedicineContext` after a successful
    // search so the canonical context lands consistently.
    return {
      query: raw,
      usedContext: false,
      context: null,
      originalQuery: raw,
    };
  }

  // 3b. Treat as follow-up. Match against the expanded pattern set.
  const medicine =
    activeCtx.medicineName || activeCtx.genericName || activeCtx.medicineId;
  if (medicine) {
    const found = matchFollowUp(raw);
    if (found) {
      const rewritten = found.pattern.build(medicine, found.match);
      return {
        query: rewritten,
        usedContext: true,
        context: activeCtx,
        originalQuery: raw,
      };
    }
  }

  // 3c. No follow-up match. Surface the active context for downstream layers
  // (e.g., nearby/formatter) but pass the query through unchanged.
  return {
    query: raw,
    usedContext: false,
    context: activeCtx,
    originalQuery: raw,
  };
};

// ---------------------------------------------------------------------------
// Exports — preserve current names; add helpers used by the next phase.
// ---------------------------------------------------------------------------

const getActiveMedicineScope = (telegramId) => {
  const ctx = getActiveContext(telegramId);
  return ctx ? getMedicineScope(ctx) : null;
};

module.exports = {
  getActiveContext,
  setActiveMedicineContext,
  resolveContextualQuery,
  clearActiveContext,
  getActiveMedicineScope,
  // exposed for tests in 4.3
  _internals: {
    ACTIVE_CONTEXT_TTL_MS,
    MEDICINE_CONTEXT_CONFIDENCE_THRESHOLD,
  },
};
