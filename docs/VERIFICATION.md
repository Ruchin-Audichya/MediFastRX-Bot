# Verification record — 22 October 2026

## Baseline and history

The new clone is `/home/ruchinaudichya/Desktop/MediFast-v2`, branch `feat/medifast-v2`, based on `main` at `d399ef3`. XDG resolves the Desktop to `/home/ruchinaudichya/Desktop`. Both remote branches were fetched; earlier Studio work and original history were preserved. No push, merge or external deployment occurred.

The original dependency install used `npm ci --ignore-scripts`. The original suite ran **353 tests: 324 passed, 29 failed**, approximately 60.8 seconds. Failures included context/evidence contamination and pharmacy formatting assertions. Original startup failed because `MONGODB_URI` was missing. Logs remain locally in `.local/baseline-install.log`, `.local/baseline-tests.log`, and `.local/baseline-start.log`.

Before replacing matching, the focused shared fixture set was run against the old matcher with semantic search disabled. Multiple results were interpreted as candidates because its return shape differed. **15/23 expectations passed before; 23/23 after.** This covers exact names, aliases, typos, similar names, strength/form differences, combinations, nonsense and ambiguity. It is not a general accuracy percentage. Evidence: [before](evidence/matching-before.json), [after](evidence/matching-after.json), [fixtures](../tests/fixtures/resolution.json).

Useful behavior was retained through the Studio refactor: normalized identity gates, bounded phonetic/edit-distance candidates, explicit conversation state, selected-record evidence and location/source handling. Full original Mongo/RAG/bot test counts are not directly comparable to the new suite. Tests for retired subsystems remain in Git history; valuable behavior was migrated into active service tests. The obsolete unauthenticated shop desk was also removed; its CSV identity, expiry, duplicate, revision and stock checks now exercise the authenticated importer.

## CI diagnosis

The previously inspected [Actions run 27542013954](https://github.com/Ruchin-Audichya/MediFastRX-Bot/actions/runs/27542013954) had a failing Node 18 job and a successful Node 20 job in its `[18,20]` matrix. Detailed log download returned HTTP 403, so the precise remote failing assertion was not established. Node 24 LTS is now aligned across package engines, `.nvmrc`, instructions and CI. CI performs clean install, backend tests, TypeScript check, production build and Chromium browser checks. No new GitHub run was triggered because this branch was not pushed.

## Current checks

- **100 backend/API tests passed** on Node 24.22.0. Includes identity/context/safety, provider absence and timeouts, pharmacy source mapping, private uploads, expiry, role/ownership controls, request transitions, idempotency, transactional last-pack reservation, inventory freshness, catalog identity changes and importer atomicity.
- **32 browser checks passed**, split across desktop 1440×1000 and phone emulation. Actual installed Chrome was used through Playwright. Browser actions exercised search → details → nearby, typo confirmation, shelf notes/reload/removal, context switching, denied geolocation/manual fallback, provider failure, keyboard access, reduced motion and stale-request cancellation.
- A separate production browser check also covers new operator sign-up → pending profile → admin approval → operator SSE refresh. See [approval evidence](evidence/approval.json).
- Platform browser checks used **two independently authenticated browser contexts** for customer/pharmacy review → confirmation → preparing → ready → completed. They also ran actual Tesseract OCR, edited candidates, selected two products, displayed the map, imported CSV stock, updated inventory and reviewed admin sources/audit/health.
- Clean `npm ci`, `npm run typecheck`, `npm run build`, and `git diff --check` passed. Install audit reported **zero dependency vulnerabilities**; this is not a security certification.
- Production-build browser smoke exercised real OCR and the customer/operator flow, with zero JavaScript page errors. Desktop and phone screenshots were inspected. Public discovery returned **12 listings, four published phone contacts**, without claiming inventory.
- Actual OSM tiles returned HTTP 200 and loaded; the list remains usable without tiles. An earlier screenshot captured the map before its tiles arrived, so a later loaded-map capture was checked separately.
- An actual PDF sample was rendered with Poppler and read by Tesseract in **2,324 ms**, returning both printed medicine candidates. The PDF was a synthetic local fixture. PNG production scan through the UI took **about 820 ms** in the recorded run. Neither is handwriting accuracy evidence.

The first browser pass had eight failures from selectors colliding with Next's route announcer, multiple status regions and a keyboard event sent before client rendering. Those assertions were scoped and synchronized; no failing behavior was hidden. A subsequent launch used a missing Playwright browser bundle; rerunning with the installed Chrome path resolved that environment issue.

## Measurements

See [performance.json](evidence/performance.json) and [production.json](evidence/production.json) for exact values and scope.

| Observation | Recorded result |
| --- | --- |
| Fresh API process, including new in-memory demo seed | 280.44 ms |
| Local medicine HTTP lookup, 40 sequential requests | median 1.62 ms, p95 3.21 ms; first 52.07 ms |
| Local sample pharmacy HTTP, 20 sequential requests | median 0.about 70 ms, p95 2.06 ms |
| Next production readiness reported by server | 129 ms |
| Confirm click → observed customer SSE-updated state | about 70 ms |
| Actual internet directory request through browser | about 2.1 seconds; 12 listings, four phone contacts |

These are single-machine observations, not load tests or guarantees. Lookup and sample pharmacy measurements use local data without AI/network services. The public directory result combines eight OSM listings with four dated official-page contacts; it does not mean all four numbers were fetched from OSM. A historical Overpass timeout remains recorded in `evidence/live-pharmacy.json`; the current provider is Photon/OSM enrichment and successful current results are in `production.json` and `market-live.json`.

## Limits of verification

No real pharmacy was enrolled or independently verified. No live Groq call was made; absent, malformed and slow provider behavior is fixture-tested. Browser voice fallback was tested; actual microphone recognition was not validated with human speech. PDF/image OCR covers printed English samples, not representative handwriting. Real inventory accuracy, clinical facts, legal compliance and commercial scaling were not established. Lists are bounded, not yet paginated. See [BUILD_REPORT](../BUILD_REPORT.md) and [deployment requirements](DEPLOYMENT.md).
