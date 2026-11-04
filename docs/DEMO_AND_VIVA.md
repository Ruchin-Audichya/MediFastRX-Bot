# Demo script and viva preparation

## The 5-minute demo

**Setup:** open `/studio` on the projector (desktop, full screen). If a real bot is connected, keep a phone with Telegram open as the "pharmacist's counter phone".

1. **The problem (30 s).** "One prescription, four shops, one missing strip. Inventory apps go stale because small chemists can't maintain a database. So we don't track stock. We ask the pharmacist."
2. **Build a list (60 s).** As Aarav, tap **📷 Sample prescription**. Point out that OCR gives *candidates*: Dolo 650 matches exactly; "Cetirizine 10 mg" is an ingredient, so MediFast asks which brand. Then type `pan 20` to show it **refuses to swap strengths** ("I only know Pan 40").
3. **Broadcast (30 s).** **Ask pharmacies nearby** → **Vaishali Nagar** → **Send**. The map shows the radius and pins pulsing.
4. **Pharmacist side (60 s).** On Ravi's phone (right), tap ✅/⏳/🔁 per item, add a price, **Send answer**. Meanwhile the simulated shops answer. Point at the customer's board message **editing itself** and the pins turning colour.
5. **Split and reserve (45 s).** If nobody has everything, show the **two-shop split**. Reserve. Ravi gets the code; the other pharmacies get "customer chose another pharmacy".
6. **Close the loop (30 s).** Ravi taps **Ready** → Aarav is notified → **Collected** → **Save for one-tap refills**. Open **Mini App board** and **Pharmacy desk** to show the same data on the web.
7. **Onboarding (optional, 45 s).** In a real Telegram chat send `/partner`, go through the four steps, and approve it from the Admin tab.

## What's real vs. simulated

| Real | Simulated / fictional |
| --- | --- |
| The bot code, every message and button | The 12 Jaipur pharmacies |
| Matching, broadcast, ranking, split, reservations, expiry | Replies from 11 of them (deterministic per shop, product and day) |
| SQLite persistence, authorization, Mini App auth | Phone numbers and addresses |
| Local OCR on the sample prescription | |

## Likely viva questions

**Why not show inventory like 1mg/PharmEasy?** Inventory listings need constant data entry that neighbourhood chemists don't do, so they go stale. Asking at request time is always current and costs the pharmacy one tap. It's a different trade-off: answers take seconds to minutes instead of being instant, in exchange for being true.

**Why Telegram and not an app?** Zero install for both sides, free push notifications, and an editable message works as a live board. The domain layer has no Telegram code; WhatsApp would be another adapter (like the studio transport already is).

**What stops a pharmacy from lying or ignoring requests?** Reliability is measured per pharmacy (answer rate, median reply time, reservations collected vs. declined) and visible on their desk and to admins. The next step would be ranking by reliability and suspending shops that repeatedly decline holds.

**How do you avoid wrong medicines?** Identity is matched on name *and* strength, form and release. Anything fuzzy is a suggestion that needs a tap. Asks store immutable snapshots. Alternatives are only ever *flagged* by the pharmacist; nothing is substituted.

**Prescription medicines?** They're marked ℞ everywhere and the pharmacist checks the prescription at handover, as today. MediFast doesn't sell or deliver, so it stays an information and reservation service. Habit-forming products can't be broadcast at all.

**Where is AI used?** Only to read a prescription photo into text (local Tesseract, or Claude vision for handwriting when configured). Its output goes through the same deterministic resolver and needs the customer's confirmation. No AI makes medical or availability claims.

**How does the live board stay consistent?** All state changes happen in SQLite transactions in one domain service, which emits events. One notifier renders events to Telegram with per-message serialization and coalescing (so rapid taps never render out of order and edits respect Telegram's rate limits). The web uses SSE that carries ids only and refetches through authorized endpoints.

**How would it scale?** Move SQLite to Postgres and the in-process event bus to a queue (Redis/NATS), then run several instances behind the webhook. The domain API stays the same. Geo queries would move to PostGIS.

**How did you test it?** 25 automated tests, including complete Telegram conversations driven through the studio transport (the same bot code that runs in production), HTTP authorization boundaries, and Mini App signature verification. CI also boots the production server and smoke-tests it.

**What would a real pilot need?** One or two willing pharmacies in one area, licence verification, a reviewed catalog for what they stock, and a privacy notice. Then measure: answer rate, time to first answer, and pickups per request.
