"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getMediAtlasContext, __internal } = require("../src/integrations/mediatlas/contextTool");
const { MediAtlasUpstreamError } = require("../src/integrations/mediatlas/mediatlasErrors");

const FIXTURE_PATH = path.join(__dirname, "contract", "mediatlas.context.fixture.json");
const fixture = () => JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

const stubClient = {
  getAIContext: async () => ({
    packet: fixture(),
    requestId: "req_test",
    status: 200,
    headers: new Headers(),
  }),
};

test("returns disabled envelope when ENABLE_MEDIATLAS is not true", async () => {
  __internal._resetClientForTests();
  const result = await getMediAtlasContext(
    { q: "Dolo 650" },
    { env: { ENABLE_MEDIATLAS: "false" } }
  );
  assert.equal(result.ok, false);
  assert.equal(result.disabled, true);
});

test("returns mapped value when enabled and call succeeds", async () => {
  __internal._resetClientForTests();
  const result = await getMediAtlasContext(
    { q: "Dolo 650" },
    {
      env: { ENABLE_MEDIATLAS: "true", MEDIATLAS_BASE_URL: "x", MEDIATLAS_API_KEY: "y" },
      client: stubClient,
    }
  );
  assert.equal(result.ok, true);
  assert.equal(result.value.source, "mediatlas");
  assert.equal(result.value.medicine.resolvedName, "Dolo 650");
  assert.equal(result.requestId, "req_test");
});

test("returns error envelope when client throws MediAtlasError", async () => {
  __internal._resetClientForTests();
  const failingClient = {
    getAIContext: async () => {
      throw new MediAtlasUpstreamError("backend down", { status: 502, requestId: "r1" });
    },
  };
  const result = await getMediAtlasContext(
    { q: "Dolo 650" },
    {
      env: { ENABLE_MEDIATLAS: "true", MEDIATLAS_BASE_URL: "x", MEDIATLAS_API_KEY: "y" },
      client: failingClient,
    }
  );
  assert.equal(result.ok, false);
  assert.equal(result.disabled, false);
  assert.equal(result.error.code, "UPSTREAM");
  assert.equal(result.error.status, 502);
  assert.equal(result.error.requestId, "r1");
});

test("returns CONFIG error envelope when client construction fails", async () => {
  __internal._resetClientForTests();
  const result = await getMediAtlasContext(
    { q: "Dolo 650" },
    { env: { ENABLE_MEDIATLAS: "true" } } // missing base url + key
  );
  assert.equal(result.ok, false);
  assert.equal(result.disabled, false);
  assert.equal(result.error.code, "CONFIG");
});
