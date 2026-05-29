"use strict";

/**
 * Cross-check the MediAtlas OpenAPI 3.1 spec against the schemas MediFast
 * has pinned in src/integrations/mediatlas/schemas.js.
 *
 * This is NOT an OpenAPI validator; it's a contract-drift detector for
 * the integration points MediFast actually consumes:
 *   - openapi version + info.version
 *   - presence of MediFast-facing routes
 *   - presence of the locked AIContextPacket section keys
 *   - declared enum values for stock_status, match_reason, forecast trend,
 *     section status (the four MediAtlas committed not to bump silently)
 *
 * Anything that drifts gets reported as a warning, not a hard fail. The
 * authoritative gate is the contract test against a real /ai/context
 * response on integration day.
 */

const fs = require("node:fs");
const path = require("node:path");

const { enums } = require("../src/integrations/mediatlas/schemas");

const SPEC_PATH =
  process.argv[2] ||
  "C:\\Users\\Ruchin Audichya\\Desktop\\MediAtlas\\.local\\openapi.json";

const REQUIRED_PATHS = [
  "/api/v1/ai/context",
  "/api/v1/auth/whoami",
  "/api/v1/medicine/resolve",
  "/api/v1/medicine/search",
  "/api/v1/availability",
  "/api/v1/forecast",
  "/api/v1/substitute",
  "/api/v1/substitutes", // alias
  "/api/v1/inventory",
  "/api/v1/inventory/search", // alias
  "/api/v1/normalize", // alias
  "/api/v1/health",
  "/api/health", // alias
  "/api/v1/webhooks/register",
  "/api/v1/events/stream",
];

const REQUIRED_AICONTEXT_KEYS = [
  "schema_version",
  "generated_at",
  "query",
  "city",
  "location",
  "medicine",
  "summary",
  "availability",
  "drug",
  "interactions",
  "facts",
  "disclaimer",
  "meta",
];

const findAIContextSchema = (spec) => {
  const schemas = spec.components?.schemas || {};
  const candidates = Object.keys(schemas).filter((name) =>
    /^AIContext(Packet|Response)?$/i.test(name)
  );
  if (candidates.length === 0) return null;
  return { name: candidates[0], schema: schemas[candidates[0]] };
};

const collectStringEnum = (spec, schemaNames) => {
  const out = new Map();
  const schemas = spec.components?.schemas || {};
  for (const name of schemaNames) {
    const s = schemas[name];
    if (!s) continue;
    if (Array.isArray(s.enum)) out.set(name, s.enum.map(String));
  }
  return out;
};

const findEnumByMembership = (spec, expectedMembers) => {
  // For enums named differently than our local labels, find any
  // string-enum schema whose values are a superset of expected.
  const schemas = spec.components?.schemas || {};
  const matches = [];
  for (const [name, schema] of Object.entries(schemas)) {
    if (!schema || !Array.isArray(schema.enum)) continue;
    const values = schema.enum.map(String);
    const covered = expectedMembers.every((m) => values.includes(m));
    if (covered) matches.push({ name, values });
  }
  return matches;
};

const main = () => {
  if (!fs.existsSync(SPEC_PATH)) {
    console.error(`[openapi] spec not found at ${SPEC_PATH}`);
    process.exit(2);
  }

  const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
  const warnings = [];
  const errors = [];

  // 1) Top-level
  if (spec.openapi !== "3.1.0") {
    errors.push(`openapi version is ${spec.openapi}, expected 3.1.0`);
  }
  if (spec.info?.version !== "1.0.0") {
    errors.push(`info.version is ${spec.info?.version}, expected 1.0.0`);
  }
  console.log(`[openapi] ${spec.info?.title} v${spec.info?.version} (${spec.openapi})`);

  // 2) Required paths
  const declaredPaths = Object.keys(spec.paths || {});
  console.log(`[openapi] declared paths: ${declaredPaths.length}`);
  const missingPaths = REQUIRED_PATHS.filter((p) => !declaredPaths.includes(p));
  for (const p of missingPaths) {
    warnings.push(`required path missing in spec: ${p}`);
  }
  for (const p of REQUIRED_PATHS) {
    if (declaredPaths.includes(p)) console.log(`  ok  ${p}`);
  }

  // 3) AIContext schema shape
  const found = findAIContextSchema(spec);
  if (!found) {
    warnings.push(
      "no AIContext-shaped schema found in components.schemas; cannot cross-check section keys"
    );
  } else {
    console.log(`[openapi] AIContext schema: ${found.name}`);
    const properties = found.schema.properties || {};
    const declaredKeys = Object.keys(properties);
    const missingKeys = REQUIRED_AICONTEXT_KEYS.filter((k) => !declaredKeys.includes(k));
    for (const k of missingKeys) warnings.push(`AIContext schema missing key: ${k}`);
    if (missingKeys.length === 0) {
      console.log(`[openapi] AIContext keys present (${REQUIRED_AICONTEXT_KEYS.length}/${REQUIRED_AICONTEXT_KEYS.length})`);
    }
  }

  // 4) Locked enums
  const enumGroups = [
    { label: "section status", expected: enums.SECTION_STATUS },
    { label: "stock_status", expected: enums.STOCK_STATUS },
    { label: "match_reason", expected: enums.MATCH_REASON },
    { label: "forecast trend", expected: enums.FORECAST_TREND },
    { label: "interaction severity", expected: enums.INTERACTION_SEVERITY },
  ];
  for (const group of enumGroups) {
    const matches = findEnumByMembership(spec, group.expected);
    if (matches.length === 0) {
      warnings.push(
        `no string enum in spec covers expected ${group.label} values: [${group.expected.join(", ")}]`
      );
    } else {
      // Pick the smallest-superset match to compare.
      const best = matches.sort((a, b) => a.values.length - b.values.length)[0];
      const extras = best.values.filter((v) => !group.expected.includes(v));
      if (extras.length) {
        warnings.push(
          `${group.label} enum (${best.name}) carries extra values not in MediFast schema: [${extras.join(", ")}] -- additive 1.1.x; widen Zod before flip`
        );
      } else {
        console.log(`[openapi] ${group.label} enum aligned (${best.name})`);
      }
    }
  }

  // 5) Summary
  console.log("");
  if (errors.length === 0 && warnings.length === 0) {
    console.log("[openapi] PASS: no drift detected against locked MediFast schemas.");
    process.exit(0);
  }
  if (errors.length) {
    console.log(`[openapi] ERRORS (${errors.length}):`);
    for (const e of errors) console.log(`  - ${e}`);
  }
  if (warnings.length) {
    console.log(`[openapi] WARNINGS (${warnings.length}):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  process.exit(errors.length ? 1 : 0);
};

if (require.main === module) main();
