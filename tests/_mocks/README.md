# `tests/_mocks/` — Deterministic mocks for the medicine-context-integrity test suite

This folder hosts the deterministic fakes used by the bugfix's exploration,
preservation, integration, and property tests. Together they let the suite
run with no real Mongo, no real Chroma, no Groq calls, no MediAtlas calls,
and no OSM calls. Tests are reproducible from a fixed seed on any machine.

## Files

| File | Purpose |
| --- | --- |
| `installShims.js` | `stubModule(relPath, exportsValue)` and `stubManyModules([...])` — pre-populate `require.cache` BEFORE the consuming production modules are required, so they pick up the fake exports. |
| `fakeKnowledgeBase.js` | In-memory mixed-medicine chunk corpus (Pregabalin / Gabapentin / Alprazolam / Dolo650 / Telmisartan / neutral) plus `fakeRetrieveKnowledge` and `fakeSearchMedicineKnowledge`. Used by the exploration test and several integration tests. |

Generators (deterministic, seed-stable) live alongside in
[`tests/_gen/index.js`](../_gen/index.js): xorshift32 PRNG, fixed medicine
table, foreign-chunk table, follow-up template list, and helpers
(`generateMedicineRecords`, `generateChunks`, `generateFollowUpSequence`,
`generateDistinctMedicinePair`).

## Which suite shims which seam

- **`tests/explore/medicineContext.bug.test.js`** — shims `src/ai/toolRegistry.js`
  so `toolExecutor` reaches `fakeRetrieveKnowledge` / `fakeSearchMedicineKnowledge`
  instead of real Mongo / Chroma / Groq.
- **`tests/integration/rag/contamination.test.js`** — shims `src/rag/hybridRetriever.js`
  and `src/rag/evaluator.js` so `ragService.retrieveKnowledge` flows through
  controlled chunks via the **real** `src/rag/reranker.js`.
- **`tests/integration/orchestrator/synthesis.test.js`** — shims `workflowPlanner`,
  `toolExecutor`, `responseMerger`, `conversationContextService` and replaces
  `globalThis.fetch` per subtest to drive the orchestrator's deterministic
  fallback decision tree.
- **`tests/integration/orchestrator/latency.test.js`** — additionally shims
  `toolRegistry` with sleep-controllable tools to assert parallelism, cache
  hit/miss, and budget bounds.
- **`tests/unit/services/conversationContextService.test.js`** — shims
  `src/medicine/medicineNormalizer.js` so the resolver returns a
  programmable response (no Mongo).
- **`tests/property/p1.contamination.test.js`** — drives the real
  `src/orchestrator/evidenceIntegrity.js` directly with chunks from the
  generator.
- **`tests/property/p2.retention.test.js`** — shims `medicineNormalizer`
  to return `{ type: "unknown" }` so follow-ups never trigger a switch.
- **`tests/property/p3.switch.test.js`** — shims `medicineNormalizer` with a
  programmable resolution so we can drive a deterministic switch signal.
- **`tests/property/p4.preservation.test.js`** — uses the real reranker /
  `knowledgeFilter` / integrity guard with no scope (preservation).
- **`tests/property/p5.degrade.test.js`** — same shims as
  `synthesis.test.js`, parameterized over (seed, failure-mode, medicine).
- **`tests/property/p6.idempotency.test.js`** — drives the real factory.

## Mongo / network / LLM policy

- **No real Mongo.** Production modules that import Mongoose models
  (notably `src/medicine/medicineNormalizer.js`) are stubbed at the module
  seam, or invoked only on the no-active-context preservation path which
  exits before the resolver runs (see the long comment in
  `src/services/conversationContextService.js`).
- **No real Groq.** `globalThis.fetch` is replaced per subtest in suites
  that exercise the LLM path. The original is restored on `t.after`.
- **No real OSM.** `tests/integration/pharmacy/osmPath.test.js` is a smoke
  test only; the production OSM client is not invoked.
- **No real MediAtlas.** Phase 7 ships behind `ENABLE_MEDIATLAS` (default
  `false`); `getMediAtlasContext` returns `{ ok:false, disabled:true }` on
  the disabled path so tests never reach the network. Existing
  `tests/mediatlasClient.test.js` and `tests/mediatlasContextTool.test.js`
  cover the contract using injected `client` and `env` overrides.

## Running

The `package.json` `test` script runs the full suite with Node's built-in
test runner:

```
npm test
```

This invokes `node --test`, which on Node 20+ recursively discovers all
`*.test.{js,cjs,mjs}` files under the current working directory (including
`tests/property/` and `tests/_mocks/` if they ever contain tests). To run a
single file:

```
node --test tests/explore/medicineContext.bug.test.js
node --test tests/preserve/medicineContext.preservation.test.js
node --test tests/property/p1.contamination.test.js
```

To refresh inline JSON snapshots intentionally:

- `tests/preserve/__snapshots__/` — set `UPDATE_PRESERVATION_SNAPSHOTS=1`.
- `tests/unit/utils/__snapshots__/` — set `UPDATE_FORMATTER_CARD_SNAPSHOTS=1`.
