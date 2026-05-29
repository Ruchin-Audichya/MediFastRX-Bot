# MediAtlas Context Readiness — MediFast AI

## Why MediAtlas

MediFast AI is the conversational layer; **MediAtlas** is the inventory / forecast / substitutes / pharmacy intelligence backend. The two systems are separate by design and communicate over HTTP. MediFast's deterministic medicine systems remain the **source of truth for medicine identity**; MediAtlas may cross-reference and enrich, but it never overrides identity.

This document captures how MediFast is **architecturally ready** to attach MediAtlas without redesign — even though the integration itself is currently deferred.

## The reserved enrichment slot

The canonical `MedicineContext` (in `src/context/medicineContext.js`) ships with a frozen reserved slot:

```js
enrichment: {
  inventory: null,
  forecast: null,
  substitutes: null,
  pharmacies: null,
}
```

When MediAtlas integration lands, the orchestrator will call `withEnrichment(ctx, partial)` to populate one or more of these four sections (with `updatedAt` bumped to the merge time). The shape is deliberately stable so all downstream consumers (`formatMedicineCard`, `evidenceCollector`, the deterministic card path, the analytics events) read from the same place.

## Normalized enrichment shape

`mediatlasMapper.js` (deferred) will normalize MediAtlas responses into this shape — each section status is one of `"ok" | "empty" | "degraded"`:

```js
enrichment = {
  inventory: { status, items: [{ pharmacyId, pharmacyName, distanceKm, inStock, quantity, price, confidence, lastUpdated }] } | null,
  forecast: { status, demandLevel, stockoutRisk, recommendedRestockUnits, city, horizonDays } | null,
  substitutes: { status, items: [{ name, generic, confidence, reason }] } | null,
  pharmacies: { status, items: [{ pharmacyId, name, distanceKm, phone, openStatus, directionsUrl }] } | null
}
```

`formatMedicineCard` already consumes `enrichment.pharmacies.items` / `enrichment.inventory.items` / `enrichment.forecast.demandLevel` and surfaces them in the SOLID Telegram card. It falls back to `evidence.pharmacyContext.pharmacies` (the OSM/Mongo-geo path) when enrichment is absent — guaranteeing every wired layer reaches the user.

## MediAtlas client contract (deferred)

When integration lands, the client will live at `src/integrations/mediatlas/mediatlasClient.js` and expose:

| Method | Endpoint | Purpose |
|---|---|---|
| `login(email, password)` | `POST /api/v1/auth/login` | JWT acquisition; cached in memory; refreshed on 401 |
| `getInventory({medicine, latitude, longitude, radiusKm})` | `GET /inventory` | Live stock + pharmacy + price + forecast risk |
| `getForecast({medicine, city, horizonDays})` | `GET /forecast` | Demand + shortage risk |
| `getSubstitutes({medicine, latitude, longitude})` | `GET /substitute` | Equivalent medicines scored by availability/price/distance/side-effect similarity |
| `getNearbyPharmacies({latitude, longitude, radiusKm, medicine})` | `GET /pharmacies/nearby` | Geospatial pharmacy search with distance + optional stock |
| `getAvailability({q, latitude, longitude, city, radiusKm})` | `GET /availability` | Composed: resolution + nearby inventory + substitutes + forecast in one call (preferred for the enrichment branch) |
| `resolveMedicine({q})` | `GET /medicine/resolve` | **Secondary** resolver — used to cross-reference / enrich, never to override MediFast identity |
| `subscribeToEvents({types, onEvent})` | SSE `GET /events/stream` or webhook `POST /webhooks/register` | Stock alerts, restock events, demand spikes |

### Production-hardening (required before flag-on)

- **Config from env**: `MEDIATLAS_BASE_URL`, `MEDIATLAS_EMAIL`, `MEDIATLAS_PASSWORD`, `MEDIATLAS_ENABLED` (default `false`), `MEDIATLAS_TIMEOUT_MS`. **No secrets logged.**
- **Timeouts** on every call (`AbortController`).
- **Retry with exponential backoff + jitter** for transient / 5xx / network errors, bounded by `maxRetries`.
- **Token caching + 401 refresh**: cache JWT in memory with expiry; on `401`, refresh once via `login()` and retry the original request.
- **Circuit breaker / graceful degrade**: after N consecutive failures, open the breaker for a cooldown; short-circuit to "degraded" so MediFast keeps working fully.
- **Response normalization**: every payload mapped into the documented enrichment shape; status field tagged on every section.

## Flag / degradation strategy

The integration ships **flag-OFF** (`MEDIATLAS_ENABLED=false`) by default. Behavior on each state:

| State | Result |
|---|---|
| Flag off | `getMediAtlasContext` returns `{ ok: false, disabled: true }`. `formatMedicineCard` reads `evidence.pharmacyContext.pharmacies` (OSM path). The deterministic-card fallback is unaffected. |
| Flag on, breaker open | All sections return `status: "degraded"`. `formatMedicineCard` skips forecast / enrichment-pharmacies and falls back to OSM evidence. The user still gets a complete card. |
| Flag on, partial response | Each section degrades independently (`ok` / `empty` / `degraded`). `formatMedicineCard` renders only the sections that arrived. |
| Flag on, success | Enrichment sections populated; `formatMedicineCard` surfaces forecast + enriched pharmacies. |

## How MediFast stays source-of-truth

- The deterministic resolver `normalizeMedicineQuery` in `src/medicine/medicineNormalizer.js` is the only authority on medicine identity.
- The frozen `MedicineContext` is the only object downstream stages may mutate (via `withEnrichment`, which returns a NEW frozen context).
- MediAtlas's `resolveMedicine` may be called for cross-reference but its output **must not** override `MedicineContext.medicineName` / `genericName` / `aliases` / `salts`.
- The evidence integrity guard (`src/orchestrator/evidenceIntegrity.js`) validates every chunk against the active `MedicineContext` regardless of whether it came from MediFast RAG or MediAtlas — preventing identity drift.

## Future work to enable MediAtlas

1. Implement `src/integrations/mediatlas/mediatlasClient.js` (login + 6 methods + circuit breaker + retry + token cache).
2. Implement `src/integrations/mediatlas/mediatlasMapper.js` (normalize responses to the enrichment shape).
3. Register `enrichWithMediAtlas` tool in `src/ai/toolRegistry.js`.
4. Wire enrichment step in `src/orchestrator/orchestrator.js` between `collectEvidence` and the provider call: when `MEDIATLAS_ENABLED && activeMedicine.confidence >= threshold`, call the tool, then `withEnrichment(ctx, partial)`.
5. Optional: add `src/integrations/mediatlas/mediatlasWebhookHandler.js` for stock alerts (auth + signature required).
6. Tests: mocked HTTP for client (auth/retry/refresh/breaker), mapper shape, orchestrator merge.
