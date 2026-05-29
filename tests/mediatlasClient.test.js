"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  MediAtlasClient,
  isMediAtlasEnabled,
  __internal,
} = require("../src/integrations/mediatlas/mediatlasClient");
const {
  MediAtlasAuthError,
  MediAtlasForbiddenError,
  MediAtlasNotFoundError,
  MediAtlasRateLimitError,
  MediAtlasValidationError,
  MediAtlasUpstreamError,
  MediAtlasNetworkError,
  MediAtlasConfigError,
} = require("../src/integrations/mediatlas/mediatlasErrors");

const FIXTURE_PATH = path.join(__dirname, "contract", "mediatlas.context.fixture.json");
const loadFixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

const silentLogger = { warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };

const makeFetchSequence = (responses) => {
  let i = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const idx = Math.min(i, responses.length - 1);
    const next = responses[idx];
    i += 1;
    if (typeof next === "function") return next(url, init);
    if (next instanceof Error) throw next;
    // Clone so persistent-error tests can replay the same Response across
    // retries; bodies are single-use otherwise.
    return next.clone();
  };
  return { fetchImpl, calls };
};

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

test("isMediAtlasEnabled honors ENABLE_MEDIATLAS env flag", () => {
  assert.equal(isMediAtlasEnabled({ ENABLE_MEDIATLAS: "true" }), true);
  assert.equal(isMediAtlasEnabled({ ENABLE_MEDIATLAS: "True" }), true);
  assert.equal(isMediAtlasEnabled({ ENABLE_MEDIATLAS: "false" }), false);
  assert.equal(isMediAtlasEnabled({}), false);
});

test("constructor throws MediAtlasConfigError when base url or key missing", () => {
  assert.throws(
    () =>
      new MediAtlasClient({
        env: {},
      }),
    MediAtlasConfigError
  );
  assert.throws(
    () =>
      new MediAtlasClient({
        env: { MEDIATLAS_BASE_URL: "http://localhost:8000" },
      }),
    MediAtlasConfigError
  );
});

test("getAIContext sends Bearer + X-Client + X-Request-Id, parses packet", async () => {
  const fixture = loadFixture();
  const { fetchImpl, calls } = makeFetchSequence([jsonResponse(200, fixture)]);

  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "test-key-123",
    fetchImpl,
    logger: silentLogger,
  });

  const result = await client.getAIContext({
    q: "Dolo 650",
    latitude: 26.9124,
    longitude: 75.7873,
    radiusKm: 5,
    alsoTaking: ["Pregabalin"],
  });

  assert.equal(result.packet.medicine.resolved_name, "Dolo 650");
  assert.equal(calls.length, 1);

  const headers = calls[0].init.headers;
  assert.equal(headers.Authorization, "Bearer test-key-123");
  assert.equal(headers["X-Client"], "medifast");
  assert.match(headers["X-Request-Id"], /^[0-9a-f-]{36}$/i);

  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/v1/ai/context");
  assert.equal(url.searchParams.get("q"), "Dolo 650");
  assert.equal(url.searchParams.get("latitude"), "26.9124");
  assert.equal(url.searchParams.get("also_taking"), "Pregabalin");
});

test("getAIContext rejects empty query without hitting the network", async () => {
  const { fetchImpl, calls } = makeFetchSequence([jsonResponse(200, {})]);
  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "k",
    fetchImpl,
    logger: silentLogger,
  });
  await assert.rejects(client.getAIContext({}), MediAtlasValidationError);
  assert.equal(calls.length, 0);
});

test("retries on 429 honoring Retry-After header", async () => {
  const fixture = loadFixture();
  const { fetchImpl, calls } = makeFetchSequence([
    jsonResponse(
      429,
      { error: { code: "RATE_LIMITED", message: "slow down", request_id: "r1" } },
      { "retry-after": "0" }
    ),
    jsonResponse(200, fixture),
  ]);

  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "k",
    fetchImpl,
    logger: silentLogger,
    maxAttempts: 3,
  });

  const result = await client.getAIContext({ q: "Dolo 650" });
  assert.equal(result.packet.medicine.resolved_name, "Dolo 650");
  assert.equal(calls.length, 2);
});

test("throws MediAtlasRateLimitError after max attempts on persistent 429", async () => {
  const { fetchImpl } = makeFetchSequence([
    jsonResponse(
      429,
      { error: { code: "RATE_LIMITED", message: "slow down", request_id: "r1" } },
      { "retry-after": "0" }
    ),
  ]);

  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "k",
    fetchImpl,
    logger: silentLogger,
    maxAttempts: 2,
  });

  await assert.rejects(client.getAIContext({ q: "Dolo 650" }), MediAtlasRateLimitError);
});

test("retries on 502/503/504 then succeeds", async () => {
  const fixture = loadFixture();
  const { fetchImpl, calls } = makeFetchSequence([
    jsonResponse(503, { error: { code: "UPSTREAM", message: "warmup" } }),
    jsonResponse(200, fixture),
  ]);

  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "k",
    fetchImpl,
    logger: silentLogger,
    maxAttempts: 3,
  });

  const result = await client.getAIContext({ q: "Dolo 650" });
  assert.equal(result.packet.medicine.resolved_name, "Dolo 650");
  assert.equal(calls.length, 2);
});

test("does NOT retry on 4xx other than 429 (e.g. 401)", async () => {
  const { fetchImpl, calls } = makeFetchSequence([
    jsonResponse(401, { error: { code: "AUTH", message: "bad key", request_id: "r1" } }),
    jsonResponse(200, loadFixture()),
  ]);

  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "k",
    fetchImpl,
    logger: silentLogger,
    maxAttempts: 3,
  });

  await assert.rejects(client.getAIContext({ q: "Dolo 650" }), MediAtlasAuthError);
  assert.equal(calls.length, 1);
});

test("403 maps to MediAtlasForbiddenError, 404 to NotFound, 422 to Validation", async () => {
  for (const [status, ErrorClass] of [
    [403, MediAtlasForbiddenError],
    [404, MediAtlasNotFoundError],
    [422, MediAtlasValidationError],
  ]) {
    const { fetchImpl } = makeFetchSequence([
      jsonResponse(status, { error: { code: "X", message: `m${status}` } }),
    ]);
    const client = new MediAtlasClient({
      baseUrl: "http://localhost:8000",
      apiKey: "k",
      fetchImpl,
      logger: silentLogger,
      maxAttempts: 1,
    });
    await assert.rejects(client.getAIContext({ q: "Dolo 650" }), ErrorClass);
  }
});

test("non-2xx without proper envelope still maps to typed error with synthesized message", async () => {
  const { fetchImpl } = makeFetchSequence([
    jsonResponse(500, "<html>nginx</html>"),
  ]);
  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "k",
    fetchImpl,
    logger: silentLogger,
    maxAttempts: 1,
  });
  await assert.rejects(client.getAIContext({ q: "Dolo 650" }), MediAtlasUpstreamError);
});

test("network error raises MediAtlasNetworkError", async () => {
  const { fetchImpl } = makeFetchSequence([new Error("ECONNREFUSED")]);
  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "k",
    fetchImpl,
    logger: silentLogger,
    maxAttempts: 1,
  });
  await assert.rejects(client.getAIContext({ q: "Dolo 650" }), MediAtlasNetworkError);
});

test("timeout raises MediAtlasNetworkError with isTimeout=true and does not retry", async () => {
  const slowFetch = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });

  const client = new MediAtlasClient({
    baseUrl: "http://localhost:8000",
    apiKey: "k",
    fetchImpl: slowFetch,
    logger: silentLogger,
    timeoutMs: 30,
    maxAttempts: 3,
  });

  await assert.rejects(client.getAIContext({ q: "Dolo 650" }), (err) => {
    assert.equal(err instanceof MediAtlasNetworkError, true);
    assert.equal(err.isTimeout, true);
    return true;
  });
});

test("parseRetryAfterMs handles seconds and HTTP-date formats", () => {
  assert.equal(__internal.parseRetryAfterMs("0"), 0);
  assert.equal(__internal.parseRetryAfterMs("3"), 3000);
  assert.equal(__internal.parseRetryAfterMs(null), null);
  assert.equal(__internal.parseRetryAfterMs("not a date"), null);
});
