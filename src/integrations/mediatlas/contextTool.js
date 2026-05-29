"use strict";

const logger = require("../../utils/logger");
const { createClientFromEnv, isMediAtlasEnabled } = require("./mediatlasClient");
const { mapAIContextPacket } = require("./mediatlasMapper");
const { MediAtlasError } = require("./mediatlasErrors");

/**
 * getMediAtlasContext — feature-flagged tool entry point.
 *
 * When ENABLE_MEDIATLAS is not "true", returns
 *   { ok: false, disabled: true, reason }
 * so callers can short-circuit without throwing.
 *
 * When enabled and the call fails, returns
 *   { ok: false, disabled: false, error: { code, message, requestId } }
 * matching the MediFast tool result envelope used in toolExecutor.
 *
 * On success returns
 *   { ok: true, value: <mappedPacket>, requestId, status }
 */

let _cachedClient = null;

const _getClient = (env = process.env, overrides = {}) => {
  if (overrides.client) return overrides.client;
  if (_cachedClient) return _cachedClient;
  _cachedClient = createClientFromEnv(env, overrides);
  return _cachedClient;
};

const _resetClientForTests = () => {
  _cachedClient = null;
};

const getMediAtlasContext = async (input = {}, ctx = {}) => {
  const env = ctx.env || process.env;

  if (!isMediAtlasEnabled(env)) {
    return {
      ok: false,
      disabled: true,
      reason: "ENABLE_MEDIATLAS is not true; skipping MediAtlas call",
    };
  }

  let client;
  try {
    client = _getClient(env, ctx);
  } catch (err) {
    logger.warn(`[mediatlas] client init failed: ${err.message}`);
    return {
      ok: false,
      disabled: false,
      error: {
        code: err.code || "CONFIG",
        message: err.message,
        requestId: null,
      },
    };
  }

  try {
    const { packet, requestId, status } = await client.getAIContext(input);
    const mapped = mapAIContextPacket(packet);
    if (mapped?.medicineDriftDetected) {
      logger.warn(
        `[mediatlas] medicine identity drift between packet.medicine and availability.medicine (request_id=${requestId})`
      );
    }
    return { ok: true, value: mapped, requestId, status };
  } catch (err) {
    if (err instanceof MediAtlasError) {
      logger.warn(
        `[mediatlas] getAIContext failed (code=${err.code}, status=${err.status}, request_id=${err.requestId}): ${err.message}`
      );
      return {
        ok: false,
        disabled: false,
        error: {
          code: err.code,
          message: err.message,
          requestId: err.requestId,
          status: err.status,
        },
      };
    }
    logger.error(`[mediatlas] unexpected error: ${err.message}`);
    return {
      ok: false,
      disabled: false,
      error: { code: "INTERNAL", message: err.message, requestId: null },
    };
  }
};

module.exports = {
  getMediAtlasContext,
  __internal: { _resetClientForTests, _getClient },
};
