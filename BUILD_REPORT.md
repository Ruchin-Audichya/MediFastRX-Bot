# MediFast v2 — build report

Date: **4 November 2026**. Workspace: `/home/ruchinaudichya/Desktop/MediFast-v2`. Branch: **`feat/medifast-v2`**. Local frontend: **http://127.0.0.1:3000**. API: loopback port 3101. Release target: `feat/medifast-v2`; main and historical branches remain preserved. No external deployment.

## Completed application

- Signal Street responsive Next.js interface: medicine lookup, explicit identity confirmation, details/evidence, Hinglish follow-ups, editable voice input where supported, recent searches, local shelf and notes. The customer and pharmacy workspaces share bundled display/body fonts, blue navigation, coral emphasis, and legible status treatments.
- Public pharmacy discovery using Photon/OSM and dated official Jaipur directory contacts. Manual place choices, consent-based location, radius and phone filtering, source/address/distance/hours, call/directions links, optional Leaflet map and failure states. Public stock remains unknown.
- Persistent authentication with customer/pharmacy/admin roles. Password hashing, session revocation, HttpOnly cookies, server-side authorization, private request histories, ownership checks, rate limits and bounded input.
- Participating-pharmacy registration, entered license/pharmacist details, admin approval/suspension, manual stock and reviewed Marg-style CSV imports. Exact medicine identity snapshots, quantities, unit prices, source/timestamps, 24-hour freshness, expiry validation, optimistic revisions and atomic updates.
- Full availability-request lifecycle: submitted, reviewing, confirmed, preparing, ready, completed, cancelled, rejected, unavailable and expired. Idempotent creation, actor timelines, pharmacist-review gate, transactional reservations and quote snapshots. Two independent sessions receive live SSE updates.
- Secure image/PDF upload and **actual local OCR**, editable lines, explicit product/strength/form confirmation, multi-medicine partner comparison and attachment to an authorized pharmacy request. Seven-day deletion, owner deletion, assigned-pharmacy access, image byte/pixel checks, 5 MB limit, serialized processing and per-user document bounds. Shared demo account accepts only the fictional sample.
- Admin approval queue, user disabling, catalog-source review records, OCR/AI-selection report review, request monitoring, audit logs and real local health/counts. External provider capabilities are explicitly disabled.
- Demo customer/operator/admin accounts, fictional partner stock, actual local request notifications, sample image and CSV, reset command. Live public directory data is never blended with fictional inventory.
- One-command development, production build/start, minimal environment example, CI alignment on Node 24, database seed/import scripts, tests and documentation.

## Modules and architecture

| Area | Files |
| --- | --- |
| Next shell, build and API proxy | `pages/`, `next.config.js`, `scripts/dev.cjs` |
| Consumer design, catalog UI, shelf, public directory | `web/main.jsx`, `web/Pharmacies.jsx`, `web/style.css`, `web/signal.css`, `web/lib.js`, `DESIGN.md` |
| Authentication, requests, partner discovery, live state | `web/Platform.tsx`, `src/platform/core.cjs`, `src/platform/routes.cjs` |
| Scanner, operator/admin workspaces, map | `web/Workspaces.tsx`, `web/PartnerMap.tsx`, `web/platform.css` |
| OCR and stock parsing | `src/platform/ocr.cjs`, `src/platform/csv.cjs` |
| Medicine service and evidence | `src/service.cjs`, `src/medicine/`, `src/explain.cjs` |
| Internet pharmacy sources | `src/pharmacy/service.cjs`, `data/jaipur-directory.json` |
| Setup, seed, provenance and measurement | `.env.example`, `scripts/`, `data/README.md`, `docs/evidence/` |

One Express API and one SQLite database serve the whole local product. SQLite deliberately replaces the MongoDB service requirement: its indexed reads and transactions make an approachable single-machine demo with consistent stock updates. There is no second database implementation. Next provides the frontend/build/proxy; older useful JSX was retained while new platform views use TypeScript. No microservices, agent framework, vector model or hosted authentication dependency.

The medicine pipeline is normalize → exact/alias resolution → conservative candidate confirmation → selected catalog evidence → optional evidence selection. Small explicit context replaces repeated handler/orchestrator matching. OCR uses the same resolver. See [architecture](docs/ARCHITECTURE.md) for interfaces, trust boundaries and three interview decisions.

## Cleanup and preserved history

Both `main` and `careops-servicenow` were inspected. The earlier Studio refactor was reused rather than discarding working domain behavior. Exact/alias matching, edit-distance/phonetic candidate ideas, evidence isolation, context switching and location/source handling remain covered.

CareOps/ServiceNow workflows and fabricated operational metrics were never imported from the other branch. Retired from the main product: the old duplicated Telegram orchestration (now replaced by a shared-service adapter), old Mongo models, semantic/model download stack, unknown-medicine model-memory fallback, duplicated routing/context, misleading pharmacy availability rankings, public operational endpoints, SOS/family and unfinished integrations. The unused prior unauthenticated shop desk was removed after its useful parser/import checks were moved to the authenticated flow. Historical branches and tests remain available. The old Studio folder was not overwritten.

## Checks and actual results

| Check | Result |
| --- | --- |
| Original repository baseline | 353 tests: 324 passed, 29 failed; startup lacked `MONGODB_URI` |
| Shared compact matching fixtures | 15/23 before → 23/23 after; not general accuracy |
| Final backend/API suite | **118 passed, zero failed** |
| Desktop/phone browser suite | **34 passed, zero failed** |
| Clean dependency install | Passed; audit reported zero vulnerabilities |
| TypeScript and Next production build | Passed |
| Built application, two independent login sessions | Reviewed/confirmed request, quote and customer SSE update observed |
| Actual local OCR | PNG and PDF sample read both printed medicine lines; explicit multi-item selection verified |
| Real internet discovery | 12 listings, four published phone contacts; inventory unknown |
| Optional map | OSM tiles HTTP 200, markers/list rendered |
| Visual/runtime inspection | Desktop and phone screenshots inspected; no observed page errors or horizontal page overflow |

Screenshots: [desktop home](docs/screenshots/home-desktop.png), [phone home](docs/screenshots/home-phone.png), [medicine result](docs/screenshots/signal-medicine-desktop.png), [nearby on phone](docs/screenshots/signal-nearby-phone.png), [confirmed request](docs/screenshots/request-confirmed.png), [scanner](docs/screenshots/prescription-scan.png).

A live browser check also registered a second fictional pharmacy, submitted its profile, verified it stayed hidden while pending, then approved it from an independent admin session. The operator approval screen refreshed through SSE. Evidence: [approval flow](docs/evidence/approval.json).

Raw evidence: [verification details](docs/VERIFICATION.md), [timings](docs/evidence/performance.json), [production smoke](docs/evidence/production.json), and local `.local/*-v2.log` files. CI includes the Telegram middleware smoke check and all web checks. The final release pass requests feature-branch publication; see its GitHub Actions status after publication. Existing Node 18 CI failure was observed, but its detailed logs were inaccessible; no exact remote root cause is claimed.

Recorded local measurements: API ready after 280 ms including new demo seed; median catalog HTTP lookup 1.62 ms over 40 sequential requests; production confirm-to-customer-update about 70 ms; PNG scan about 820 ms; PDF OCR 2,324 ms; live directory about 2.1 seconds. These are single-machine observations, not promises or load-test results.

## Three-minute demonstration

**0:00–0:45:** Open the app. Search Dolo 650, inspect the exact strength, source disclosure and missing-information boundary. Save it with a note. Open Nearby to see public sources and phone links labeled “Call to confirm.”

**0:45–1:45:** Sign in with the demo customer button. Request Dolo from the fictional partner. In an incognito window, sign in as the demo pharmacy. Start review, enter the review note, confirm and mark ready. Watch the customer's timeline update without refreshing. Complete or cancel the sample request.

**1:45–2:30:** Open Scan as customer, use the clearly fictional image, consent and scan. Edit the lines, explicitly confirm Dolo and Cetirizine, and compare the two-product list against fictional partner stock.

**2:30–3:00:** Show the pharmacy CSV preview with a wrong-strength row being skipped. Open the demo admin's catalog review/audit and health views. Explain why public discovery, partner-reported stock and pharmacist confirmation are separate facts.

Demo buttons fill the public sample accounts; password is `DemoPass!2026`. Use separate browser contexts for roles. No hidden database edits are needed between steps. The README contains exact launch/reset commands.

## Known limitations and incomplete features

- Nine demonstration medicines only. Sources do not establish a complete clinically validated Indian product catalog or reliable prescription classifications. Every request therefore requires pharmacist review. No dosage advice, automatic substitutes or pharmacist alternative-proposal workflow is implemented.
- License/identity approval is a recorded human attestation based on submitted fields, not an integrated government verification or documentary evidence system. There are no real enrolled pharmacies or verified real inventory.
- OCR supports printed English images and the first three PDF pages; handwriting and mixed-script recognition remain unreliable. Voice depends on browser/vendor support and was only tested for graceful unsupported behavior, not live speech accuracy.
- Email verification, password recovery, MFA, encrypted storage/backups, full retention policy, abuse operations and independent security assessment remain. The local database and private files have filesystem protections but are not encrypted by this application.
- Request/audit records remain after account anonymization. Uploads expire after seven days. Demo-mode private accounts also disappear on demo reset; real patient data must not be used in a public demo.
- Bounded lists (100 records) are not paginated yet. The frontend uses screen state rather than shareable routes. Single-host SQLite/event delivery needs reevaluation before multiple app replicas.
- Map/OSM/Photon availability is external; phones may be absent or stale. Source hours are not interpreted as current opening status. Four Jaipur contacts are dated official-page records, not guaranteed live listings or inventory.
- No live Groq request was made. The optional selector is tested with provider fixtures and fallbacks; it never writes novel medical facts.
- Payments, delivery, SMS/WhatsApp, direct Marg/POS sync and external license verification are unavailable and explicitly disabled. CSV import is implemented; these integrations are not.

## Before a real commercial launch

Obtain licensed pharmacy participation, genuine license/identity checks, reviewed medicine data and prescription/restricted-product workflows. Arrange legal review of applicable Indian drug-sale and data-protection requirements, including current commencement dates and retention/consent obligations. Add secure account recovery/MFA, production privacy and security controls, backup/restore tests, load tests and monitoring. [Deployment notes](docs/DEPLOYMENT.md) link official sources and identify the operational work. This build does not claim regulatory compliance.

## Recommended next pass

1. Enroll one consenting Jaipur pharmacy, verify its licence and pharmacist registration outside the demo, import a reviewed catalog, and test a real operator-managed availability request. Keep public OSM listings separate from that verified partner.
2. Add email verification, recovery and admin MFA before external accounts or private documents. Decide retention and encrypted backup policy with legal and pharmacy advisers.
3. Add a CSV mapping/reconciliation screen for actual Marg exports from the pilot shop, including batch expiry and pack units. Only consider a direct POS connector after obtaining a supported integration agreement and sample exports.


## Final Telegram and release pass — 4 November 2026

- Added optional grammY private-chat assistant with exact catalog matching, explicit typo/variant choices, English/Hinglish conversation, follow-up buttons, plain-language facts and optional AI evidence summaries. All flows reuse the existing services.
- Added manual area choices and one-time location discovery, source/phone links, directions, conservative hours and stock labels. Public listings never gain sample inventory.
- Added 30-minute bounded context, stale-button nonces, private-chat guard, HTML escaping, per-user rate limits/serialization, duplicate-delivery suppression and safe error logging. No Telegram text or shared location is stored in the database.
- Added token-free `bot:demo`, connectivity-only `bot:check`, polling, combined `dev:all`, authenticated grammY Express webhook and explicit webhook-management commands. Web-only startup is independent of Telegram.
- Added confirmed-product and scanner web links. Request handoff prefills an exact basket and requires authentication and deliberate submission; no Telegram action bypasses pharmacist review.
- Clean `npm ci`: passed, zero reported vulnerabilities. Backend/API: 118 passed. Browser: 34 passed across desktop/phone. Typecheck and production build passed. Offline bot smoke passed. Production launch and final route checks are recorded in the release evidence.
- Live Jaipur provider check: 8 OSM listings and 4 dated directory records; 4 published contacts. Public stock unknown. This verifies discovery/contact retrieval, not inventory.
- Live Telegram and Groq acceptance were **not performed**: no token or AI key was available in the process or local project environment. Simulated Telegram transport and HTTP webhook tests are clearly distinguished from a real connected chat. `npm run bot:check` produces an actionable missing-token error.
- Telegram photos/PDFs and voice notes are intentionally routed to the authenticated web experience. In-memory Telegram context/deduplication is single-process and resets on restart. No account-linking, bot ordering, automatic substitution or dispensing flow is claimed.
- Local presentation artifacts under `major-project-presentation/` are preserved outside the release snapshot. No secrets, private database, uploads, caches or node_modules are included.

Setup and a complete Telegram walkthrough: [docs/TELEGRAM.md](docs/TELEGRAM.md). Run `npm run bot:demo` immediately, or configure the private token and run `npm run dev:all`.
