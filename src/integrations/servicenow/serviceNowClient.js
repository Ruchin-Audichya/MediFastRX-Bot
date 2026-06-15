"use strict";

// ServiceNowClient — thin wrapper over the ServiceNow Table API
// (POST/GET https://<instance>.service-now.com/api/now/table/{table}).
//
// Two modes, selected by env:
//   - mock (default): no network. Generates deterministic-looking sys_ids and
//     ServiceNow-style numbers so the whole platform is demoable and
//     deployable WITHOUT credentials. This is the hackathon-safe default.
//   - live: real Basic-Auth REST calls when SERVICENOW_ENABLED=true and
//     instance + credentials are present.
//
// Hardening: per-call AbortSignal timeout, bounded retry with backoff on
// 5xx/network, structured logging that NEVER logs the password or auth header.

const logger = require("../../utils/logger");

const cfg = () => ({
  enabled: String(process.env.SERVICENOW_ENABLED || "false").toLowerCase() === "true",
  instance: process.env.SERVICENOW_INSTANCE || "", // e.g. dev12345 (no protocol)
  baseUrl:
    process.env.SERVICENOW_BASE_URL ||
    (process.env.SERVICENOW_INSTANCE
      ? `https://${process.env.SERVICENOW_INSTANCE}.service-now.com`
      : ""),
  // A realistic placeholder instance shown in MOCK mode so the payload preview
  // reads like a real ServiceNow call (purely cosmetic; no requests are sent).
  mockInstanceUrl: process.env.SERVICENOW_MOCK_INSTANCE_URL || "https://medifastdev.service-now.com",
  user: process.env.SERVICENOW_USER || "",
  password: process.env.SERVICENOW_PASSWORD || "",
  timeoutMs: Number(process.env.SERVICENOW_TIMEOUT_MS || 5000),
  maxRetries: Number(process.env.SERVICENOW_MAX_RETRIES || 2),
});

const isLive = () => {
  const c = cfg();
  return Boolean(c.enabled && c.baseUrl && c.user && c.password);
};

const mode = () => (isLive() ? "live" : "mock");

// Deterministic-ish 32-char hex sys_id for mock mode.
const mockSysId = () =>
  Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

const mockNumber = (table) => {
  const prefix =
    table === "incident"
      ? "INC"
      : table === "sn_customerservice_case"
      ? "CS"
      : table.startsWith("sc")
      ? "SCTASK"
      : "TASK";
  return `${prefix}${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
};

const authHeader = () => {
  const c = cfg();
  const token = Buffer.from(`${c.user}:${c.password}`).toString("base64");
  return `Basic ${token}`;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Low-level POST with timeout + retry. Returns the parsed `result` object.
const postTable = async (table, body) => {
  const c = cfg();
  const url = `${c.baseUrl}/api/now/table/${table}`;
  let attempt = 0;
  let lastError;

  while (attempt <= c.maxRetries) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), c.timeoutMs);
      let response;
      try {
        response = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            authorization: authHeader(),
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
        });
      } finally {
        clearTimeout(timer);
      }

      if (response.status >= 500) {
        lastError = new Error(`ServiceNow ${response.status}`);
        attempt += 1;
        await sleep(250 * 2 ** attempt + Math.floor(Math.random() * 100));
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`ServiceNow ${response.status}: ${text.slice(0, 200)}`);
      }
      const json = await response.json();
      return json.result;
    } catch (error) {
      lastError = error;
      if (error.name === "AbortError" || /ServiceNow 5/.test(error.message)) {
        attempt += 1;
        await sleep(250 * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error("ServiceNow request failed");
};

// Public: create a record on a table. In mock mode returns a synthetic ref.
const createRecord = async (table, fields) => {
  if (!isLive()) {
    const ref = {
      system: "servicenow",
      mode: "mock",
      sysId: mockSysId(),
      number: mockNumber(table),
      table,
    };
    logger.info(`ServiceNow[mock] created ${table} ${ref.number}`);
    return ref;
  }

  const result = await postTable(table, fields);
  const ref = {
    system: "servicenow",
    mode: "live",
    sysId: result?.sys_id || null,
    number: result?.number || null,
    table,
  };
  // NEVER log credentials — only the resulting public record number.
  logger.info(`ServiceNow[live] created ${table} ${ref.number || ref.sysId}`);
  return ref;
};

const health = () => {
  const c = cfg();
  return {
    mode: mode(),
    enabled: c.enabled,
    instanceConfigured: Boolean(c.baseUrl),
    credentialsPresent: Boolean(c.user && c.password),
  };
};

// The instance base URL to show in the payload preview. In live mode this is
// the real instance; in mock mode it's a realistic placeholder so the preview
// reads like an authentic ServiceNow call.
const baseUrlForPreview = () => {
  const c = cfg();
  return c.baseUrl || c.mockInstanceUrl;
};

module.exports = {
  createRecord,
  isLive,
  mode,
  health,
  baseUrlForPreview,
  // exposed for tests
  _internals: { mockSysId, mockNumber, cfg },
};
