# MediFast as a business

**One line:** type a medicine and a pincode, then choose where to buy it. You can ask the chemists
nearby to check their shelf, call a pharmacy from the map, or open an online pharmacy. MediFast
never invents stock, prices or delivery times.

## Who it is for

| Who | Pain | What MediFast gives them |
|---|---|---|
| Patient or caregiver | They have the exact strength the doctor wrote but don't know which shop has it, so they find out at the counter | One search that shows three honest options. Participating chemists confirm in minutes |
| Neighbourhood chemist | Online pharmacies and quick-commerce apps take their walk-ins. Stock-listing apps want a database they can't keep up to date | Real local demand on the counter phone, one tap per request, customers who walk in already reserved |
| Distributor / brand | They can't see which strengths go unmet where, until the sales are already lost | Aggregated, anonymised unmet-demand signals by area (later stage) |

## Why this shape (and not a stock database or a scraper)

- **Stock data for small chemists does not exist.** Every "nearby stock" app has to ask shops to
  keep a database up to date, and they don't. Asking the pharmacist *when a customer needs
  something* is the only stock signal that stays fresh. That is the network tier.
- **Online platforms have no public search API.** Blinkit, 1mg, PharmEasy, Apollo and Netmeds
  publish no partner API for availability by pincode.
  - The community Blinkit MCP server (`roeintheglasses/blinkit-mcp`) calls a reverse-engineered
    endpoint from a logged-in account.
  - Its browser fallback hard-codes `in_stock: true` for every result.
  - Paid scraping APIs resell the same endpoints and come with no service-level agreement.
  - So MediFast **links out** to each platform's own search for the exact product. The platform
    shows the price and stock itself, and the page labels the link "Not checked by MediFast".
- **The map tier is free and honest.** OpenStreetMap (Overpass) lists real pharmacies with their
  phone numbers and opening hours. It is labelled "Stock unknown: call before you go".

## Revenue

We are careful about the order in which revenue arrives. None of it can change what a user sees
about availability.

1. **Disclosed affiliate links (day one).** Set `AFFILIATE_<PLATFORM>` to the platform's partner
   parameter.
   - Each link that carries the parameter is marked "affiliate link", and a disclosure appears
     under the online tier.
   - The order of options is fixed. A platform can't pay to move up.
   - Commission rates vary by programme and change often. Treat them as upside, not the plan.
2. **Pharmacy Pro, about ₹299–499 per month per shop (after the pilot).**
   - Answering requests stays free forever. A network only works if it is free to join.
   - The paid tier adds things that make a shop better, not more visible:
     - a weekly "missed demand" report (medicines customers asked for that the shop didn't
       have, with counts);
     - reply-speed analytics;
     - extra counter staff on the account;
     - a branded pickup page.
3. **Demand insights for distributors (scale stage).**
   - The product is aggregated, anonymised counts: which molecule and strength went unmet, in
     which pincode cluster, in which week.
   - It never includes a person, a prescription or a single request.
   - It is sold only above a minimum aggregation threshold.

**What we will never sell:** placement or ranking, customer data, or a "verified" badge that
isn't backed by a pharmacist's answer.

## Unit economics (pilot, one city)

| Item | Monthly cost |
|---|---|
| One small VM (Fly.io, Railway or a ₹500 VPS) with SQLite | ₹0–800 |
| Telegram Bot API | Free |
| OpenStreetMap Nominatim and Overpass (cached for 7 days and 24 hours) | Free, within the usage policy |
| India Post pincode directory (data.gov.in, OGD licence) | Free, imported once |
| Optional Claude vision for handwritten prescriptions | Pay per use. Local OCR is the default |

At 40 paying shops on Pro, the business covers its costs several times over. Break-even comes
before any affiliate or data revenue.

## Go-to-market

1. **Supply first, in one area.** Sign up 15–25 chemists within 2 km of each other (Vaishali Nagar,
   Jaipur in the pilot kit). Use `docs/PILOT_KIT.md` and the printed pharmacist guide.
2. **Demand where the gap hurts.** Reach people through hospital and clinic discharge desks, RWA
   groups and caregivers of chronic patients: thyroid, diabetes and cardiac strengths that are
   often out of stock.
3. **Search as the front door.** The `/find` page works with no network at all, because the map
   and online tiers cover every pincode in India. Each search in a new area tells us where to
   recruit next.

## Metrics that matter

- Answer rate within 10 minutes. The target is at least 70% in pilot areas.
- The share of asks where at least one shop says "have".
- Reservations collected, and pickup codes used.
- Searches by pincode with no participating pharmacy, which is the recruitment map.
- Pro conversion among active shops.

## Risks and how the design handles them

| Risk | Mitigation |
|---|---|
| Regulation of online pharmacy | MediFast doesn't sell, dispense or deliver. The pharmacist checks the prescription at the counter. Habit-forming medicines are never broadcast and never linked out |
| Wrong medicine | Exact matching on strength, form and release. Anything fuzzy needs the user to tap a choice |
| Platform terms (scraping) | No scraping. We only link to the platforms' public search pages |
| Cold start | The map and online tiers make search useful from day one. The network then grows area by area |
