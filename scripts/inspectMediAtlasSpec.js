"use strict";

/**
 * One-off inspector to dig into specific parts of the MediAtlas OpenAPI
 * spec that the validator flagged as drift. Walks all $refs and inline
 * enum/type declarations to find values that the top-level enum scan
 * missed.
 */

const fs = require("node:fs");
const path = require("node:path");

const SPEC_PATH =
  process.argv[2] ||
  "C:\\Users\\Ruchin Audichya\\Desktop\\MediAtlas\\.local\\openapi.json";

const spec = JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));

const resolveRef = (ref) => {
  if (!ref || !ref.startsWith("#/")) return null;
  const parts = ref.replace(/^#\//, "").split("/");
  let node = spec;
  for (const p of parts) {
    if (node == null) return null;
    node = node[p];
  }
  return node;
};

const walkProperties = (schema, label) => {
  if (!schema) return;
  const target = schema.$ref ? resolveRef(schema.$ref) : schema;
  if (!target) return;
  if (target.type === "object" && target.properties) {
    for (const [key, prop] of Object.entries(target.properties)) {
      const t = prop.$ref ? resolveRef(prop.$ref) : prop;
      const enumVals = Array.isArray(t?.enum) ? t.enum : null;
      const typeStr = t?.type || (t?.anyOf ? "anyOf" : "?");
      console.log(`  ${label}.${key}: ${typeStr}${enumVals ? " enum=[" + enumVals.join(",") + "]" : ""}`);
    }
  }
};

const findInlineEnumsByValue = (target, results = [], pathStack = []) => {
  if (!target || typeof target !== "object") return results;
  if (Array.isArray(target.enum)) {
    results.push({ path: pathStack.join("."), values: target.enum });
  }
  for (const [k, v] of Object.entries(target)) {
    if (k === "$ref") continue;
    if (v && typeof v === "object") {
      findInlineEnumsByValue(v, results, [...pathStack, k]);
    }
  }
  return results;
};

console.log("=== AIContextPacket properties (resolved) ===");
walkProperties(spec.components.schemas.AIContextPacket, "AIContextPacket");

console.log("\n=== Section: availability ===");
walkProperties(spec.components.schemas.Availability, "Availability");

console.log("\n=== Section: drug (DrugInfo) ===");
const drugSchemaName = Object.keys(spec.components.schemas).find((n) =>
  /^DrugInfo|^Drug$/.test(n)
);
console.log(`  drug schema: ${drugSchemaName}`);
if (drugSchemaName) walkProperties(spec.components.schemas[drugSchemaName], drugSchemaName);

console.log("\n=== All inline enums in AIContextPacket subtree ===");
const inline = findInlineEnumsByValue(spec.components.schemas.AIContextPacket);
for (const e of inline) {
  console.log(`  ${e.path || "<root>"}: [${e.values.join(",")}]`);
}

console.log("\n=== AIContextPacket.safety property ===");
const safety = spec.components.schemas.AIContextPacket.properties?.safety;
console.log(JSON.stringify(safety, null, 2));

console.log("\n=== Schemas with names matching status/severity/reason/trend ===");
const interesting = Object.keys(spec.components.schemas).filter((n) =>
  /(status|severity|reason|trend|frequency)/i.test(n)
);
for (const name of interesting) {
  const s = spec.components.schemas[name];
  const t = s.$ref ? resolveRef(s.$ref) : s;
  console.log(`  ${name}: type=${t.type || "?"} enum=${t.enum ? "[" + t.enum.join(",") + "]" : "n/a"}`);
}

console.log("\n=== /api/v1/health vs /api/health ===");
console.log("  /api/v1/health declared:", Object.keys(spec.paths).includes("/api/v1/health"));
console.log("  /api/health declared:   ", Object.keys(spec.paths).includes("/api/health"));
const healthV1 = spec.paths["/api/v1/health"];
const healthShort = spec.paths["/api/health"];
console.log("  /api/v1/health methods:", healthV1 ? Object.keys(healthV1) : "n/a");
console.log("  /api/health methods:   ", healthShort ? Object.keys(healthShort) : "n/a");
