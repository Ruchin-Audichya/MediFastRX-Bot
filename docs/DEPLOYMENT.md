# Local operation and a future participating-pharmacy pilot

Nothing has been deployed. The default is a local demo. Use `npm run dev`; for local production use `npm run build` then `npm start`. Both Next and Express bind to loopback. Keep one application process pair per database.

## Live configuration

Create a separate SQLite file and private upload directory owned by the service account. The default `.local/` directory is ignored by Git. Do not reuse a public demo database for patient information. Back up the database consistently while stopped (or use SQLite's online backup tooling); protect backups like originals. Do not copy only the main file while WAL writes are active.

```dotenv
APP_MODE=live
PHARMACY_MODE=live
CATALOG_FILE=.local/live.sqlite
API_PORT=3101
WEB_PORT=3000
HOST=127.0.0.1
APP_ORIGIN=https://your-domain.example
```

Supply `ADMIN_EMAIL` and `ADMIN_PASSWORD` privately for the one-time `npm run seed`. The password must be at least 16 characters and is hashed. Never put credentials in tracked files, commands committed to Git, frontend variables, screenshots or support logs. Registration cannot create admin accounts. Remove the bootstrap password after creation. In live mode, demo logins/partners are excluded.

Build using the same `API_PORT` as runtime because Next's rewrite is built configuration. Use a process supervisor and HTTPS reverse proxy to Next; do not expose Express directly. Preserve the browser origin, disable response buffering on `/api/platform/events`, and allow long-lived SSE connections. Configure upload limits slightly above 5 MB and timeouts above the bounded OCR duration. Keep a single host initially. Enforce firewall restrictions and trusted proxy configuration deliberately before relying on per-client rate limits behind any proxy.

Use a current patched Node 24 runtime, `npm ci`, `npm test`, `npm run typecheck`, `npm run build`, and browser checks before release. Review `npm audit` advisories; a clean audit is not an application security certification.

## External providers

Photon geocoding and OpenStreetMap discovery/contact enrichment are public services with no availability guarantee. The UI provides source attribution, timeouts, cache bounds and retry/manual fallbacks. Maps load OSM tiles only when requested. Review [Photon API documentation](https://github.com/komoot/photon/blob/master/docs/api-v1.md), [OSM API](https://wiki.openstreetmap.org/wiki/API_v0.6) and [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) before public traffic; use a suitable provider or self-host if scale requires it. Provider calls disclose the requested location to that provider.

Optional Groq receives supplied catalog evidence, not prescriptions or patient queries. Browser speech recognition may use the browser vendor's online service; it is opt-in and produces editable text. Local OCR processes files on this application's host. PDF support needs Poppler. English printed text is the supported OCR baseline, not handwriting recognition.

Payments, delivery, SMS/WhatsApp and direct POS integrations are **disabled**, with no fabricated adapters. The stock importer consumes reviewed CSV exports; it is not connected to Marg ERP. Integrate such services only when credentials, contracts and a tested operational workflow exist.

## Before real patients or commercial operation

The software controls are a starting point, not a compliance claim. Arrange qualified legal and pharmacy review covering licensed premises, pharmacist credentials, prescription handling and retention, product classifications, restricted products, dispensing and advertising. Relevant official starting points: [CDSCO Drugs Rules](https://www.cdsco.gov.in/opencms/opencms/en/Acts-and-rules/Drugs-Rules/) and [MeitY DPDP Rules notification](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf). Confirm applicable commencement dates and duties for the actual service.

Human admin approval currently records an attestation after reviewing entered license and pharmacist details. It does not verify a government registry or retain documentary verification evidence. Add a real verification procedure and appropriate restricted-product rules before a pilot. All current confirmations require pharmacist review because reliable prescription classification is absent.

Also needed: email verification, secure password recovery, admin MFA, vulnerability/security assessment, abuse monitoring, encrypted storage/backups, explicit retention/deletion policy for request/audit records, tested restoration, incident response and privacy notices. Uploads currently expire after seven days; request/audit retention is not automatically purged. Customer deletion anonymizes the account but retains operational history. Pharmacist review notes must not contain unnecessary patient details.

Admin lists and request history show at most 100 records. Catalog import is capped at 20,000 records. Add pagination, database migrations and load testing as actual pilot needs arise. Avoid claiming this single-machine experiment is production-ready at commercial scale.
