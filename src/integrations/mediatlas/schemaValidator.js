"use strict";

const { MediAtlasSchemaError } = require("./mediatlasErrors");

/**
 * Tiny schema validator tailored for the MediAtlas AIContextPacket contract.
 *
 * Design rules (locked with MediAtlas Sprint 1):
 *   - Object shapes are passthrough by default. Unknown forward-compat fields
 *     are preserved and ignored, never throw.
 *   - Sections that are documented as nullable (availability, drug,
 *     interactions, forecast.forecast, summary.best_pharmacy_*) accept null
 *     but the *key itself* must be present. Missing keys are a contract
 *     violation, not a degraded state.
 *   - Required scalars throw MediAtlasSchemaError on missing/wrong type.
 *   - Enum values are strict. New values from MediAtlas are telegraphed
 *     before /openapi.json bumps; if one slips through, CI goes red here.
 *   - Numeric scores in [0, 1] are clamped with a warning callback rather
 *     than rejected. A 1.000001 rounding artifact must not drop the packet.
 *
 * The validator returns a deeply-cloned, normalized object. The original
 * input is never mutated.
 */

const ISO_DATETIME_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const ISO_DATETIME_LOOSE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const join = (parent, child) => (parent ? `${parent}.${child}` : child);

const fail = (path, expected, received) => {
  throw new MediAtlasSchemaError(
    `MediAtlas response failed schema at "${path || "<root>"}": expected ${expected}, received ${describe(received)}`,
    { path: path || null, expected, received: describe(received) }
  );
};

const describe = (value) => {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) return `array(len=${value.length})`;
  if (typeof value === "object") return `object(keys=[${Object.keys(value).slice(0, 5).join(",")}])`;
  return `${typeof value}(${JSON.stringify(value).slice(0, 40)})`;
};

const requireKey = (obj, key, path) => {
  if (!isPlainObject(obj)) fail(path, "object", obj);
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    fail(join(path, key), "key present (may be null)", undefined);
  }
};

const validateString = (value, path, { minLength = 0 } = {}) => {
  if (typeof value !== "string") fail(path, "string", value);
  if (value.length < minLength) fail(path, `string with length >= ${minLength}`, value);
  return value;
};

const validateNullableString = (value, path) => {
  if (value === null) return null;
  return validateString(value, path);
};

const validateNumber = (value, path, { min = -Infinity, max = Infinity } = {}) => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "finite number", value);
  if (value < min || value > max) fail(path, `number in [${min}, ${max}]`, value);
  return value;
};

const validateNullableNumber = (value, path, opts) => {
  if (value === null) return null;
  return validateNumber(value, path, opts);
};

const validateInteger = (value, path) => {
  if (!Number.isInteger(value)) fail(path, "integer", value);
  return value;
};

const validateBoolean = (value, path) => {
  if (typeof value !== "boolean") fail(path, "boolean", value);
  return value;
};

const validateArray = (value, path, itemValidator) => {
  if (!Array.isArray(value)) fail(path, "array", value);
  return value.map((item, idx) => itemValidator(item, `${path}[${idx}]`));
};

const validateStringArray = (value, path) => validateArray(value, path, (v, p) => validateString(v, p));

const validateEnum = (value, allowed, path) => {
  if (typeof value !== "string" || !allowed.includes(value)) {
    fail(path, `one of [${allowed.join(", ")}]`, value);
  }
  return value;
};

const validateNullableEnum = (value, allowed, path) => {
  if (value === null) return null;
  return validateEnum(value, allowed, path);
};

const validateIsoDatetime = (value, path) => {
  validateString(value, path);
  if (!ISO_DATETIME_LOOSE.test(value)) fail(path, "ISO 8601 datetime", value);
  return value;
};

const validateNullableIsoDatetime = (value, path) => {
  if (value === null) return null;
  return validateIsoDatetime(value, path);
};

const validateIsoDate = (value, path) => {
  validateString(value, path);
  if (!ISO_DATE.test(value)) fail(path, "YYYY-MM-DD date", value);
  return value;
};

const validateNullableIsoDate = (value, path) => {
  if (value === null) return null;
  return validateIsoDate(value, path);
};

/**
 * Score in [0, 1] with clamp-on-overflow tolerance. A value at 1.000001 from
 * floating point rounding is clamped to 1.0 and a warning is emitted via
 * onClampWarning. Out-of-bound by more than EPSILON throws.
 */
const SCORE_EPSILON = 0.001;

const validateScore = (value, path, ctx = {}) => {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "score in [0, 1]", value);
  if (value >= 0 && value <= 1) return value;
  if (value < 0 && value >= -SCORE_EPSILON) {
    ctx.onClampWarning?.(`score at ${path} clamped from ${value} to 0`);
    return 0;
  }
  if (value > 1 && value <= 1 + SCORE_EPSILON) {
    ctx.onClampWarning?.(`score at ${path} clamped from ${value} to 1`);
    return 1;
  }
  fail(path, "score in [0, 1]", value);
  return value; // unreachable
};

const validateNullableScore = (value, path, ctx) => {
  if (value === null) return null;
  return validateScore(value, path, ctx);
};

/**
 * Passthrough object: validate known keys via shape, preserve unknown keys.
 * If `requiredKeys` is provided, those keys must exist (may be null if
 * marked nullable in the inner validator).
 */
const validateObject = (value, path, shape, ctx) => {
  if (!isPlainObject(value)) fail(path, "object", value);
  const out = { ...value };
  for (const [key, fn] of Object.entries(shape)) {
    requireKey(value, key, path);
    out[key] = fn(value[key], join(path, key), ctx);
  }
  return out;
};

const validateNullableObject = (value, path, shape, ctx) => {
  if (value === null) return null;
  return validateObject(value, path, shape, ctx);
};

module.exports = {
  ISO_DATETIME_MS,
  ISO_DATETIME_LOOSE,
  ISO_DATE,
  isPlainObject,
  fail,
  requireKey,
  validateString,
  validateNullableString,
  validateNumber,
  validateNullableNumber,
  validateInteger,
  validateBoolean,
  validateArray,
  validateStringArray,
  validateEnum,
  validateNullableEnum,
  validateIsoDatetime,
  validateNullableIsoDatetime,
  validateIsoDate,
  validateNullableIsoDate,
  validateScore,
  validateNullableScore,
  validateObject,
  validateNullableObject,
};
