# Architecture

```text
Next.js / React browser application
    └── same-origin /api rewrite → Express API
            ├── Medicine service → indexed SQLite catalog
            ├── Platform service → same SQLite database
            ├── Public discovery → Photon + OpenStreetMap + dated directory
            ├── Local OCR → Sharp / Poppler → Tesseract → explicit selection
            └── Optional evidence selector → Groq with bounded fallback

Telegram private chat → grammY adapter → the same medicine / pharmacy / evidence services
    └── exact-product HTTPS link → signed-in web request / prescription workspace
```

## One database, explicit services

`src/medicine/catalog.cjs` owns the SQLite connection and schema for medicine facts and normalized names. `src/platform/core.cjs` uses that same connection for users, sessions, partners, inventory, prescriptions, requests, status events, review reports and audit logs. SQLite removes the MongoDB service requirement and gives a single-process local experiment atomic stock updates without another storage adapter. Node 24 supplies SQLite; no database daemon is required. This is not a multi-instance architecture.

`src/server.cjs` composes Express, validation, rate limits, security headers and APIs. `src/platform/routes.cjs` authenticates and authorizes every protected operation. `web/Platform.tsx` contains session state, SSE invalidation, requests and partner discovery; `web/Workspaces.tsx` contains scanner/operator/admin views. `web/main.jsx` retains the focused medicine and shelf UI. Next provides the build, shell and same-origin API proxy; mature CSS implements the design without another component framework.

## Medicine identity before language generation

Normalize input → indexed exact name/alias lookup → explicit variant filtering → bounded fuzzy candidates → user confirmation → selected catalog evidence. `src/service.cjs` is the single medicine application service. The client sends only the last confirmed medicine ID and current intent; follow-ups, switches and reset have deterministic behavior.

Exact strength/formulation/release/combination differences cannot be silently replaced. Fuzzy matches always ask for confirmation. Generic overlap is not interchangeability. Semantic retrieval was removed because the compact regression set demonstrated better behavior with deterministic gates and selected-record evidence. No model loads at startup or first search. Optional AI only selects already supplied sentences; it cannot invent unknown medicine facts.

## Requests and stock consistency

A request snapshots the confirmed medicine name, ingredients, strength and form. Inventory snapshots the same identity. Replacing the catalog with a different product at an existing ID invalidates old stock. Availability is unknown after 24 hours or the supplied batch expiry (India time), and zero quantity is explicitly out of stock. Manual stock updates are new saleable-stock attestations; operators must exclude reserved packs. Operator reports, fictional demo inventory and public listings are separate sources.

Creation validates catalog IDs, pack quantities, partner approval and prescription ownership. An idempotency key is unique per customer and hashes the payload. Reusing it with changed content fails. Request revisions prevent stale writes; a repeated already-applied transition returns the current request.

```text
submitted → reviewing → confirmed → preparing → ready → completed
     ↘ rejected / unavailable
active requests → cancelled (authorized customer/operator)
active requests → expired after 24 hours
```

Confirmation requires recorded pharmacist review, fresh stock and matching identities. A SQLite transaction checks and reserves every item together; two requests cannot reserve the last pack twice. Cancellation/expiry releases reservations only into matching product identities. Completed requests retain history and their quote. Prices are per operator-declared pack, not inferred dosage or a payment charge. No alternative product is substituted.

## Real-time, with recoverable state

Authenticated SSE sends invalidation events to the customer, owning pharmacy and admin. Clients refetch authorized data. Events contain no prescription text. Reconnect refetches current state, so a lost event does not lose the request. Session checks terminate expired streams; stream counts are bounded. SQLite is the durable source of truth; the in-process event emitter is not the request store.

## Security and privacy boundaries

- Salted scrypt passwords, opaque random session tokens stored as hashes, eight-hour sessions, HttpOnly/SameSite=Strict cookies; Secure in live production.
- Role and ownership checks on requests, stock imports, pharmacy edits, admin operations and prescription files. Frontend visibility is not authorization.
- Mutation header plus origin checks, rate limits, input limits, revision checks and transaction boundaries. Private files stay outside public assets with random names and restricted filesystem permissions.
- Actual image bytes are decoded and re-encoded; SVG/animated types are rejected, files max 5 MB and images max 16 MP. PDF rendering is bounded to three pages. Local OCR is serialized and time-limited.
- Uploads expire after seven days, can be deleted immediately, and are accessible only to the owner and explicitly assigned pharmacy. Admin role alone cannot read them. Shared demo login accepts only the bundled fictional image.
- Account deletion cancels active requests, revokes sessions, removes uploads and anonymizes identity; minimal request/audit records remain. No public medical query analytics. Shelf notes remain in that browser until removed.

The local database/files are not encrypted at rest. Secure deployment, retention policies, identity verification, backups and legal review remain operator responsibilities; see deployment notes.

## Useful interview decisions

1. **Identity snapshots, not ingredient similarity:** catalog edits cannot quietly convert existing stock or reservations into another strength/product.
2. **Transactional confirmation plus SSE:** a durable request and stock transaction is authoritative; lightweight notifications make two independent sessions feel live without Redis or another service.
3. **OCR as an editable proposal:** scanned text must pass the same deterministic resolver and explicit selection as typed search. This lets a useful AI-adjacent feature improve data entry without treating model confidence as clinical approval.

## Optional Telegram boundary

`src/telegram/adapter.cjs` presents the shared medicine service through grammY. It owns only transport formatting, bounded/expiring per-user context, candidate-button nonces, duplicate delivery suppression, serialization and short abuse counters. It does not write pharmacy inventory or create orders. Polling (`npm run bot`) and the authenticated Express webhook are alternative delivery methods using identical middleware. Shared location pins live only for one provider call. AI receives catalog evidence, never Telegram chat text.

A confirmed product can move into the web UI through an ID-based HTTPS link. The web UI resolves that catalog ID again, preserves its strength and formulation, and can prefill a request basket. Login and deliberate request submission are still required. This avoids a second account/linking system or a shortcut around pharmacist review. `npm run bot:demo` exercises the real middleware with a simulated transport and no credentials.
