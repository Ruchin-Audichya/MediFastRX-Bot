"use strict";

const crypto = require("node:crypto");
const logger = require("../../utils/logger");
const { parseAIContextPacket } = require("./schemas");
const {
  MediAtlasError,
  MediAtlasConfigError,
  MediAtlasAuthError,
  MediAtlasForbiddenError,
  MediAtlasNotFoundError,
  MediAtlasRateLimitError,
  MediAtlasValidationError,
  MediAtlasUpstreamError,
  MediAtlasNetworkError,
} = require("./mediatlasErrors");

/**
 * MediAtlasClient — Node fetch wrapper for the MediAtlas REST surface.
 *
 * Locked contract (Sprint 1):
 *   - Authorization: Bearer <api-key>            (no X-API-Key header)
 *   - X-Client: medifast                          (logged + rate-limit bucketed)
 *   - X-Request-Id: <uuid>                        (echoed by MediAtlas)
 *   - Hard request timeout: 3000 ms (configurable via MEDIATLAS_TIMEOUT_MS)
 *   - Retries: 429 honors Retry-After; transient 502/503/504 retried with
 *     exponential backoff + jitter; total attempts bounded.
 *   - 4xx (other than 429) is NOT retried.
 *   - Errors arrive as { error: { code, message, request_id } } when
 *     X-Client: medifast is set. Anything else is treated as UPSTREAM.
 *
 * The client is intentionally thin. Domain shaping lives in mediatlasMapper.
 * The only schema-aware method is getAIContext, which validates and returns
 * a normalized packet ready for the mapper.
 */

const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

const HTTP_CODE_MAP = {
  401: MediAtlasAuthError,
  403: MediAtlasForbiddenError,
  404: MediAtlasNotFoundError,
  422: MediAtlasValidationError,
  429: MediAtlasRateLimitError,
  502: MediAtlasUpstreamError,
  503: MediAtlasUpstreamError,
  504: MediAtlasUpstreamError,
};

const ENV_BASE_URL = "MEDIATLAS_BASE_URL";
const ENV_API_KEY = "MEDIATLAS_API_KEY";
const ENV_TIMEOUT = "MEDIATLAS_TIMEOUT_MS";
const ENV_FLAG = "ENABLE_MEDIATLAS";

const isMediAtlasEnabled = (env = process.env) =>
  String(env[ENV_FLAG] || "").toLowerCase() === "true";

const newRequestId = () => crypto.randomUUID();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseRetryAfterMs = (header) => {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  // HTTP-date form is supported by MediAtlas in theory but unused today.
  const epoch = Date.parse(header);
  if (Number.isFinite(epoch)) return Math.max(0, epoch - Date.now());
  return null;
};

const backoffMs = (attempt) => {
  // 250ms * 2^(attempt-1) with up to 100ms jitter, capped at 2s
  const base = 250 * Math.pow(2, Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * 100);
  return Math.min(2000, base + jitter);
};

const safeJson = async (response) => {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const errorFromResponse = ({ status, body, requestId, retryAfterMs }) => {
  const envelope = body && typeof body === "object" && body.error;
  const code = envelope?.code || null;
  const message =
    envelope?.message ||
    (typeof body === "string" && body) ||
    `MediAtlas request failed with HTTP ${status}`;
  const ErrorClass = HTTP_CODE_MAP[status] || MediAtlasUpstreamError;
  if (ErrorClass === MediAtlasRateLimitError) {
    return new MediAtlasRateLimitError(message, {
      status,
      code: code || "RATE_LIMITED",
      requestId,
      retryAfterMs,
    });
  }
  return new ErrorClass(message, { status, code: code || undefined, requestId });
};

class MediAtlasClient {
  constructor(options = {}) {
    const env = options.env || process.env;
    const baseUrl = options.baseUrl ?? env[ENV_BASE_URL];
    const apiKey = options.apiKey ?? env[ENV_API_KEY];
    const timeoutMs = Number.parseInt(
      options.timeoutMs ?? env[ENV_TIMEOUT] ?? DEFAULT_TIMEOUT_MS,
      10
    );

    if (!baseUrl) {
      throw new MediAtlasConfigError(
        `MediAtlas base URL is not configured (env: ${ENV_BASE_URL})`
      );
    }
    if (!apiKey) {
      throw new MediAtlasConfigError(
        `MediAtlas API key is not configured (env: ${ENV_API_KEY})`
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new MediAtlasConfigError(
        `MediAtlas timeout must be a positive number, got ${timeoutMs}`
      );
    }

    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.userAgent = options.userAgent || "medifast-bot/mediatlas-client";
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.logger = options.logger || logger;
    this.onClampWarning =
      options.onClampWarning ||
      ((message) => this.logger.warn(`[mediatlas] ${message}`));

    if (typeof this.fetchImpl !== "function") {
      throw new MediAtlasConfigError(
        "Global fetch is not available; provide options.fetchImpl"
      );
    }
  }

  buildUrl(path, query) {
    const url = new URL(this.baseUrl + (path.startsWith("/") ? path : `/${path}`));
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) {
          url.searchParams.set(key, value.join(","));
          continue;
        }
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  buildHeaders({ requestId, extra }) {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "X-Client": "medifast",
      "X-Request-Id": requestId,
      "User-Agent": this.userAgent,
      Accept: "application/json",
      ...extra,
    };
  }

  async request(method, path, { query, body, headers, requestId } = {}) {
    const reqId = requestId || newRequestId();
    const url = this.buildUrl(path, query);
    const finalHeaders = this.buildHeaders({ requestId: reqId, extra: headers });
    if (body !== undefined) finalHeaders["Content-Type"] = "application/json";

    let attempt = 0;
    let lastError = null;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      let response;
      let timedOut = false;
      let abortError = null;

      // Per-attempt abort signal so retries get a fresh timer.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error(`mediatlas request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      try {
        response = await this.fetchImpl(url, {
          method,
          headers: finalHeaders,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } catch (err) {
        abortError = err;
      } finally {
        clearTimeout(timer);
      }

      if (abortError) {
        const isTimeout = timedOut || abortError.name === "AbortError" || abortError.name === "TimeoutError";
        lastError = new MediAtlasNetworkError(
          isTimeout
            ? `MediAtlas ${method} ${path} timed out after ${this.timeoutMs}ms`
            : `MediAtlas ${method} ${path} network error: ${abortError.message}`,
          { isTimeout, code: isTimeout ? "TIMEOUT" : "NETWORK", requestId: reqId, cause: abortError }
        );
        if (attempt < this.maxAttempts && isTimeout === false) {
          // Network errors retried once; timeouts not retried by default
          // (we'd rather fail fast than blow the user-turn budget).
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      const echoedRequestId = response.headers.get("x-request-id") || reqId;
      const responseBody = await safeJson(response);

      if (response.ok) {
        return {
          status: response.status,
          headers: response.headers,
          body: responseBody,
          requestId: echoedRequestId,
        };
      }

      if (RETRYABLE_STATUSES.has(response.status) && attempt < this.maxAttempts) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const wait = retryAfterMs != null ? retryAfterMs : backoffMs(attempt);
        this.logger.warn(
          `[mediatlas] ${method} ${path} -> HTTP ${response.status}; retrying in ${wait}ms (attempt ${attempt}/${this.maxAttempts}, request_id=${echoedRequestId})`
        );
        await sleep(wait);
        continue;
      }

      throw errorFromResponse({
        status: response.status,
        body: responseBody,
        requestId: echoedRequestId,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      });
    }

    if (lastError) throw lastError;
    throw new MediAtlasError(
      `MediAtlas ${method} ${path} exhausted ${this.maxAttempts} attempts`,
      { code: "UPSTREAM", requestId: reqId }
    );
  }

  /**
   * GET /api/v1/ai/context — primary call.
   *
   * Returns { packet, requestId, status, headers }. The packet has been
   * schema-validated against the locked sample. Domain mapping happens in
   * mediatlasMapper, not here.
   */
  async getAIContext(params = {}) {
    const query = {
      q: params.q,
      latitude: params.latitude,
      longitude: params.longitude,
      radius_km: params.radiusKm,
      city: params.city,
      also_taking: Array.isArray(params.alsoTaking) ? params.alsoTaking : undefined,
      include_availability: params.includeAvailability,
      include_drug: params.includeDrug,
      include_interactions: params.includeInteractions,
      limit: params.limit,
    };

    if (!query.q || typeof query.q !== "string") {
      throw new MediAtlasValidationError("getAIContext requires a non-empty `q`");
    }

    const { body, requestId, status, headers } = await this.request(
      "GET",
      "/api/v1/ai/context",
      { query, requestId: params.requestId }
    );

    const packet = parseAIContextPacket(body, { onClampWarning: this.onClampWarning });
    return { packet, requestId, status, headers };
  }

  /**
   * GET /api/v1/auth/whoami — handshake check after key import.
   * Returns whatever MediAtlas sends; not schema-pinned because v1 isn't
   * frozen on this endpoint yet.
   */
  async whoami() {
    const { body, requestId, headers } = await this.request("GET", "/api/v1/auth/whoami");
    return {
      keyName: body?.key_name ?? null,
      fingerprint: body?.fingerprint ?? headers.get("x-key-fingerprint") ?? null,
      role: body?.role ?? null,
      schemaVersion: body?.schema_version ?? null,
      requestId,
      raw: body,
    };
  }

  /**
   * GET /api/v1/health alias. Returns the raw body; not schema-pinned.
   */
  async health() {
    const { body, requestId } = await this.request("GET", "/api/v1/health");
    return { body, requestId };
  }
}

const createClientFromEnv = (env = process.env, overrides = {}) =>
  new MediAtlasClient({ env, ...overrides });

module.exports = {
  MediAtlasClient,
  createClientFromEnv,
  isMediAtlasEnabled,
  // exported for tests
  __internal: {
    parseRetryAfterMs,
    backoffMs,
    errorFromResponse,
    HTTP_CODE_MAP,
    ENV_BASE_URL,
    ENV_API_KEY,
    ENV_TIMEOUT,
    ENV_FLAG,
  },
};
