# Parse MCP Investigation — Findings & Decision (REVISED)

**Endpoint:** `https://api.parse.bot/mcp`
**Auth:** `x-api-key: <key>` header.
**Probed live**, then **built and tested a real Apollo scraper**.

## What Parse is

Parse (YC) turns any website into a typed REST API. The MCP exposes meta-tools
(`create_api`, `get_api`, `marketplace_search`, …). The *marketplace* has no
India pharmacy data — BUT `create_api` can **build one on demand**, and it works.

## We built a working Apollo Pharmacy API

```
scraper_id: 8ba876fe-8b97-44f7-a437-41cdaa0708e8
POST https://api.parse.bot/scraper/8ba876fe-8b97-44f7-a437-41cdaa0708e8/search_medicines
headers: X-API-Key: <key>
body: { "query": "dolo 650", "pincode": "302001" }
```

**Live test returned REAL data** (20 products for "dolo 650"):

| name | price | mrp | manufacturer | availability | rx |
|---|---|---|---|---|---|
| Dolo-650 Tablet 15's | 32.0 | 32.0 | Micro Labs Ltd | in-stock | false |
| Paracip-650 Tablet 10's | 15.91 | 21.5 (26% off) | — | in-stock | false |
| Crocin 650 Tablet 15's | 32.0 | 32.0 | — | in-stock | false |

Fields: `name, sku, price, mrp, discount_percentage, manufacturer,
availability, pack_size, is_prescription_required, tags[]`.

## Decision: INTEGRATE — feature-flagged, as enrichment

This is a genuine differentiator: real Indian-market brands, prices, discounts,
and stock — exactly the "feels like it knows every medicine" experience the demo
wants. Integration rules:

1. **Feature-flagged** `APOLLO_ENABLED` (default OFF) so the demo still runs
   offline if the network is flaky.
2. **Enrichment only** — used as a fallback/augment when the local catalog has
   no match, and to show real prices/brands. Safety fields (dosage, Rx) remain
   governed by the deterministic catalog + sanitized LLM layer; Apollo's
   `is_prescription_required` is surfaced as supporting info, not the sole
   source of truth.
3. **Strict timeout + graceful fallback** — any failure → existing behavior,
   never blocks the reply.
4. **Drives CareOps** — an Apollo-sourced medicine still emits the same events,
   so workflows/cases/tasks fire identically.

## Risk note for finals

The scraper depends on apollopharmacy.in remaining reachable and stable. Keep
`APOLLO_ENABLED=true` for the live wow-moment, but the deterministic catalog +
Groq fallback guarantees the bot answers even if Apollo is down.
