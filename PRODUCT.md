# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

MediFast serves two primary users equally:

- A person with a medicine name or printed prescription who wants to identify the exact product, understand the available information, find nearby pharmacies, and ask a participating pharmacy to confirm availability before travelling.
- A participating pharmacy operator who wants to present accurate business details, maintain saleable stock for exact products, receive requests, review them as a pharmacist, and give customers a reliable response and pickup status.

An administrator reviews pharmacy submissions, source-review records, reports, access, requests, and audit history. The admin supports the two-sided service; it is not the public product's primary audience.

## Product Purpose

MediFast turns an uncertain medicine name into an explicit, confirmed product identity and a pharmacy conversation. A successful journey lets the customer select the intended strength and formulation, understand what the catalog actually says, submit an availability request to a participating pharmacy, and see that pharmacy's response. The operator can review the same request, report current stock, confirm or decline, and update pickup progress. The first version is an availability-request and pickup-confirmation experiment, not a dispensing, payment, or delivery service.

## Positioning

The distinguishing mechanism is the handoff from conservative medicine identification to a real pharmacy response. A nearby shop listing establishes location and available contact information; it does not establish stock. Partner-managed stock is shown with its source, exact product identity, and freshness, while the pharmacy's response is recorded separately. Demo records remain visibly fictional.

## Operating Context

The product is a responsive web application used on phones and desktops. A customer may have a package, medicine name, or printed prescription and can search manually, edit browser speech input where supported, or review local OCR output. Jaipur is the starting manual-search area; browser location is requested only on demand. Public pharmacy discovery depends on internet services. Customers can save a local-browser reference shelf and notes, and use independent authenticated sessions to follow requests.

Operators work from the pharmacy dashboard, update stock manually or preview a Marg-style CSV/TSV export before applying exact matches, and respond to requests. Admins approve submitted pharmacy profiles and inspect bounded operational records. The included demo mode supports a complete fictional customer–operator–admin walkthrough without paid credentials or real pharmacy partners. A live pilot would require separate data, genuine partner checks, and reviewed medicine content.

## Capabilities and Constraints

- Deterministic exact and alias matching comes first. Bounded fuzzy results, OCR candidates, and uncertain strengths or formulations require explicit confirmation. Unknown medicine facts must not be generated from model memory; ingredient overlap is not proof of interchangeability.
- Medicine details must distinguish catalog facts, sourced descriptions, missing information, and optional AI selection of supplied evidence. Core lookup does not depend on an AI provider.
- Public map listings and dated directory contacts are distinct from participating pharmacies and inventory. Missing or stale stock is unknown, not confirmed. Call, directions, source, distance, and conservative hours help the user contact a shop.
- Customer requests, partner inventory, prescription access, pharmacist review, status changes, and admin actions have server-side role and ownership checks. Request history is persistent; live status updates complement the stored record.
- OCR text is editable and never constitutes an approved prescription. Every availability confirmation requires recorded pharmacist review because reliable prescription classification is absent. No dosage recommendation, diagnosis, automatic substitute, or instruction to start, stop, or change medicine belongs in the application.
- The local demo uses fictional partner inventory and no callable fictional phone number. Real public locations must never silently inherit demo stock. No real pharmacy or regulatory approval is claimed.
- Local-first setup matters: one Next.js web application, one Express API, one SQLite database, Node 24, and no mandatory Telegram, MongoDB, ServiceNow, Groq, or paid map credentials. The shelf is local to the browser; account requests and partner data are in SQLite.
- Payments, delivery, direct POS/Marg integration, SMS/WhatsApp, independent licence verification, email verification, recovery, MFA, and a complete clinical catalog are not implemented. CSV export import is implemented; it is not a direct ERP connection.

## Brand Commitments

The product name is **MediFast** and its line is **“Medicine confusion, sorted.”** Its language should be casual, warm, clear, and useful without making medical or inventory claims it cannot substantiate. Existing copy includes “Let’s clear that up” and “Call before you head out.” Distinctions between demo, catalog, public listings, partner reports, and actual pharmacy responses must stay visible.

## Evidence on Hand

- Nine small demo medicine records with individual source links and deliberately missing review dates: `data/demo-medicines.json` and `data/README.md`. They are not a comprehensive or clinically reviewed Indian catalog.
- Dated Jaipur directory records with published contact details: `data/jaipur-directory.json`. They are not current inventory evidence.
- A clearly fictional sample prescription and stock sheet: `public/demo-prescription.png` and `public/sample-stock.csv`.
- Reproducible implementation evidence and screenshots: `BUILD_REPORT.md`, `docs/VERIFICATION.md`, `docs/evidence/`, and `docs/screenshots/`. These establish local demo behavior, not commercial readiness or a real partner network.
- No verified participating real pharmacy, real inventory feed, payment provider, delivery network, or direct Marg integration is available in this project yet.

## Product Principles

1. Confirm the exact medicine and formulation before presenting a request as actionable.
2. Keep location, reported stock, and pharmacy confirmation as separate facts.
3. Make the customer and operator journeys equally understandable and recoverable.
4. Let AI and OCR assist with interpretation and entry; require people to confirm identities and pharmacy decisions.
5. Keep the local experiment runnable and honest while leaving room for a verified partner pilot.

## Accessibility & Inclusion

Support keyboard use, responsive phone layouts, readable content, reduced-motion preferences, and graceful alternatives when browser location, voice input, maps, or network services are unavailable. Common English/Hinglish phrases are supported; full Hindi or handwriting recognition is not established.
