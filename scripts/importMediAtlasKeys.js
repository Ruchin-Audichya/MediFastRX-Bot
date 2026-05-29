"use strict";

/**
 * Imports the MediAtlas service keys from the locked handover file into
 * MediFast's local secret store and writes the .acked signal back to the
 * MediAtlas workspace.
 *
 * Steps:
 *   1. Parse MediAtlas/.local/medifast_keys.txt
 *   2. Verify SHA-256 fingerprint of every plaintext key matches the
 *      corresponding `fingerprint-*` line.
 *   3. Refuse to proceed if expires_at is in the past.
 *   4. Append the dev key to MediFast's local .env (creating a backup
 *      first), under MEDIATLAS_API_KEY. Prod placeholder is stored
 *      separately for a later cutover; we do NOT write it into the
 *      active .env.
 *   5. Write MediAtlas/.local/medifast_keys.acked containing only the
 *      fingerprints that were imported, plus an ack timestamp.
 *
 * The script never echoes plaintext key material to stdout. It logs only
 * fingerprints, file paths, and counts.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MEDIATLAS_LOCAL = "C:\\Users\\Ruchin Audichya\\Desktop\\MediAtlas\\.local";
const KEYS_PATH = path.join(MEDIATLAS_LOCAL, "medifast_keys.txt");
const ACKED_PATH = path.join(MEDIATLAS_LOCAL, "medifast_keys.acked");

const MEDIFAST_ROOT = path.resolve(__dirname, "..");
const MEDIFAST_SECRETS = path.join(MEDIFAST_ROOT, ".local", "mediatlas_keys.txt");
const MEDIFAST_ENV = path.join(MEDIFAST_ROOT, ".env");

const sha256Hex = (input) => crypto.createHash("sha256").update(input, "utf8").digest("hex");

const parseKeysFile = (raw) => {
  const lines = raw.split(/\r?\n/);
  const map = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    map[key] = value;
  }
  return map;
};

const verifyFingerprint = (plaintextKey, expectedFingerprint, label) => {
  if (!expectedFingerprint) {
    throw new Error(`Missing fingerprint-${label} line; refusing to import`);
  }
  if (!expectedFingerprint.startsWith("sha256:")) {
    throw new Error(`Fingerprint for ${label} must be prefixed sha256:; got ${expectedFingerprint.slice(0, 12)}...`);
  }
  const expectedHex = expectedFingerprint.slice("sha256:".length).toLowerCase();
  const actualHex = sha256Hex(plaintextKey).toLowerCase();
  if (expectedHex !== actualHex) {
    throw new Error(
      `Fingerprint mismatch for ${label}: expected sha256:${expectedHex.slice(0, 12)}..., computed sha256:${actualHex.slice(0, 12)}...`
    );
  }
  return `sha256:${actualHex}`;
};

const ensureDir = (dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
};

const upsertEnvLine = (envPath, key, value) => {
  let body = "";
  if (fs.existsSync(envPath)) body = fs.readFileSync(envPath, "utf8");
  const lines = body.split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) {
    updated.push(`${key}=${value}`);
  }
  return updated.join("\n");
};

const writeSecretsFile = (target, payload) => {
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, payload, { mode: 0o600 });
};

const main = () => {
  if (!fs.existsSync(KEYS_PATH)) {
    console.error(`[handover] keys file not found at ${KEYS_PATH}`);
    process.exit(2);
  }

  const raw = fs.readFileSync(KEYS_PATH, "utf8");
  const parsed = parseKeysFile(raw);

  const required = [
    "medifast-dev",
    "medifast-prod-placeholder",
    "fingerprint-dev",
    "fingerprint-prod",
    "created_at",
    "expires_at",
  ];
  for (const key of required) {
    if (!parsed[key]) {
      console.error(`[handover] keys file is missing required field: ${key}`);
      process.exit(2);
    }
  }

  const expiresAt = Date.parse(parsed.expires_at);
  if (!Number.isFinite(expiresAt)) {
    console.error(`[handover] expires_at is not a valid timestamp: ${parsed.expires_at}`);
    process.exit(2);
  }
  const now = Date.now();
  if (expiresAt < now) {
    console.error(`[handover] keys expired at ${parsed.expires_at}; cannot import`);
    process.exit(3);
  }
  const remainingMin = Math.round((expiresAt - now) / 60000);
  console.log(`[handover] keys valid; ${remainingMin} minutes until TTL expiry`);

  let devFp;
  let prodFp;
  try {
    devFp = verifyFingerprint(parsed["medifast-dev"], parsed["fingerprint-dev"], "dev");
    prodFp = verifyFingerprint(parsed["medifast-prod-placeholder"], parsed["fingerprint-prod"], "prod");
  } catch (err) {
    console.error(`[handover] ${err.message}`);
    process.exit(4);
  }

  console.log(`[handover] dev  fingerprint OK: ${devFp.slice(0, 19)}...`);
  console.log(`[handover] prod fingerprint OK: ${prodFp.slice(0, 19)}...`);

  // Persist dev key into MediFast's local secret store. Prod placeholder is
  // kept beside it but not promoted to the active env.
  const secretsPayload = [
    "# MediAtlas service keys imported by scripts/importMediAtlasKeys.js",
    `# imported_at=${new Date().toISOString()}`,
    `# expires_at=${parsed.expires_at}`,
    `MEDIATLAS_DEV_KEY=${parsed["medifast-dev"]}`,
    `MEDIATLAS_DEV_FINGERPRINT=${devFp}`,
    `MEDIATLAS_PROD_PLACEHOLDER_KEY=${parsed["medifast-prod-placeholder"]}`,
    `MEDIATLAS_PROD_PLACEHOLDER_FINGERPRINT=${prodFp}`,
    "",
  ].join("\n");
  writeSecretsFile(MEDIFAST_SECRETS, secretsPayload);
  console.log(`[handover] secret store written: ${MEDIFAST_SECRETS}`);

  // Set MEDIATLAS_API_KEY in .env for the dev profile. Backup first so the
  // user can roll back. We do NOT enable ENABLE_MEDIATLAS automatically;
  // that flip happens after the smoke-test run.
  if (fs.existsSync(MEDIFAST_ENV)) {
    const backup = `${MEDIFAST_ENV}.bak.${Date.now()}`;
    fs.copyFileSync(MEDIFAST_ENV, backup);
    console.log(`[handover] .env backup at ${backup}`);
  }
  const newEnv = upsertEnvLine(MEDIFAST_ENV, "MEDIATLAS_API_KEY", parsed["medifast-dev"]);
  fs.writeFileSync(MEDIFAST_ENV, newEnv);
  console.log(`[handover] MEDIATLAS_API_KEY set in ${MEDIFAST_ENV} (dev key)`);

  // Write the .acked signal back to MediAtlas. Carries the fingerprints we
  // imported and the timestamp; no plaintext.
  const ackedPayload = [
    "# MediFast handover ack",
    `# acked_by=medifast`,
    `# acked_at=${new Date().toISOString()}`,
    `fingerprint-dev=${devFp}`,
    `fingerprint-prod=${prodFp}`,
    "",
  ].join("\n");
  fs.writeFileSync(ACKED_PATH, ackedPayload);
  console.log(`[handover] ack signal dropped at ${ACKED_PATH}`);

  console.log("[handover] DONE. Source file safe to delete on the MediAtlas side.");
};

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[handover] fatal: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { parseKeysFile, verifyFingerprint };
