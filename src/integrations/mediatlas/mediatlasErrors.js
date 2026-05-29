"use strict";

/**
 * Typed error hierarchy for the MediAtlas integration.
 *
 * Every error carries:
 *   - status        HTTP status (or null for client/network failures)
 *   - code          MediAtlas error code (VALIDATION | AUTH | FORBIDDEN |
 *                   NOT_FOUND | RATE_LIMITED | UPSTREAM | INTERNAL | SCHEMA |
 *                   NETWORK | TIMEOUT | CONFIG)
 *   - requestId     X-Request-Id we sent (echoed by MediAtlas if available)
 *
 * The error envelope returned by MediAtlas is shaped as
 *   { error: { code, message, request_id } }
 * (locked, conditional on X-Client: medifast). This module knows how to
 * project that into typed errors.
 */

class MediAtlasError extends Error {
  constructor(message, { status = null, code = "INTERNAL", requestId = null, cause = null } = {}) {
    super(message);
    this.name = "MediAtlasError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    if (cause) this.cause = cause;
  }
}

class MediAtlasConfigError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { code: "CONFIG", ...opts });
    this.name = "MediAtlasConfigError";
  }
}

class MediAtlasAuthError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { status: opts.status ?? 401, code: opts.code || "AUTH", ...opts });
    this.name = "MediAtlasAuthError";
  }
}

class MediAtlasForbiddenError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { status: opts.status ?? 403, code: opts.code || "FORBIDDEN", ...opts });
    this.name = "MediAtlasForbiddenError";
  }
}

class MediAtlasNotFoundError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { status: opts.status ?? 404, code: opts.code || "NOT_FOUND", ...opts });
    this.name = "MediAtlasNotFoundError";
  }
}

class MediAtlasRateLimitError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { status: opts.status ?? 429, code: opts.code || "RATE_LIMITED", ...opts });
    this.name = "MediAtlasRateLimitError";
    this.retryAfterMs = opts.retryAfterMs ?? null;
  }
}

class MediAtlasValidationError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { status: opts.status ?? 422, code: opts.code || "VALIDATION", ...opts });
    this.name = "MediAtlasValidationError";
  }
}

class MediAtlasUpstreamError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { status: opts.status ?? 502, code: opts.code || "UPSTREAM", ...opts });
    this.name = "MediAtlasUpstreamError";
  }
}

class MediAtlasNetworkError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { code: opts.code || "NETWORK", ...opts });
    this.name = "MediAtlasNetworkError";
    this.isTimeout = Boolean(opts.isTimeout);
  }
}

class MediAtlasSchemaError extends MediAtlasError {
  constructor(message, opts = {}) {
    super(message, { code: "SCHEMA", ...opts });
    this.name = "MediAtlasSchemaError";
    this.path = opts.path || null;
    this.expected = opts.expected || null;
    this.received = opts.received || null;
  }
}

module.exports = {
  MediAtlasError,
  MediAtlasConfigError,
  MediAtlasAuthError,
  MediAtlasForbiddenError,
  MediAtlasNotFoundError,
  MediAtlasRateLimitError,
  MediAtlasValidationError,
  MediAtlasUpstreamError,
  MediAtlasNetworkError,
  MediAtlasSchemaError,
};
