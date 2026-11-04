# MediFast: ask every chemist nearby, at once

**MediFast is a Telegram-first medicine availability network.** You send your medicine list to the bot. Every participating pharmacy around you gets it instantly, each pharmacist taps one answer per item, and you watch the answers arrive in a single, self-updating message. Then you reserve the best shop (or a two-shop split), get a pickup code, and pay at the counter.

![Demo Studio: the customer chat, a live map of answers, and the pharmacist chat, side by side](docs/screenshots/studio.png)

> 7th-semester major project. MediFast is not a pharmacy: it doesn't sell, prescribe or deliver medicines, and it isn't medical advice. The demo network's pharmacies are fictional and their replies are simulated.

## Why this, and not a stock database

Apps that list pharmacy inventory only work if shops keep a database up to date. Neighbourhood chemists can't, so the data goes stale and "in stock" stops meaning anything. MediFast asks the one source that is always current, **the pharmacist looking at the shelf**, and only when a real customer nearby needs something. Pharmacies do no data entry. They answer a question in about five seconds.

| | Customer | Pharmacist |
| --- | --- | --- |
| Where | Telegram chat + Mini App map | Telegram chat on the counter phone + desk Mini App |
| Effort | Type names or send a prescription photo | One tap per item |
| Gets | Live answers, pickup code, directions, one-tap refills | Walk-in customers with items already set aside, reliability stats |

## The journey

1. **Build a list.** Type `Dolo 650`, paste a list, or send a printed prescription photo. Every item is matched to an exact product (brand + strength + form) and **confirmed by a tap**. `Pan 20` never silently becomes Pan 40.
2. **Ask nearby.** Share your location or pick an area. The list goes to up to 12 approved, open pharmacies within 1, 2 or 5 km. They see the medicines and your distance, not who you are.
3. **Watch answers.** Pharmacists tap ✅ have · ⏳ by tomorrow · 🔁 alternative brand · ❌ no. Your board message edits itself: complete answers first, gaps spelled out, and a **two-shop split** when nobody has everything.
4. **Reserve and pick up.** One tap reserves. You get a 4-digit code; the pharmacist marks it ready and then collected. Other pharmacies are told you chose someone else.
5. **Refill.** Save the list once; next month it's `/meds` → *Refill all*.

| Live answer board (Mini App) | Pickup | Pharmacy desk |
| --- | --- | --- |
| ![](docs/screenshots/board-phone.png) | ![](docs/screenshots/pickup-phone.png) | ![](docs/screenshots/desk-phone.png) |

## Run it

Needs **Node 22.18+** (Node 24 recommended). No database server, no API keys.

```bash
npm ci
```

```bash
npm run build
```

```bash
npm start
```

Open <http://localhost:3000> for the landing page and <http://localhost:3000/studio> for **Demo Studio**. Demo Studio runs the *real* bot code against an in-process copy of the Telegram Bot API, with a customer, a pharmacist and an admin side by side, and the live map in the middle. No bot token needed.

To work on the web app with hot reload, run `npm run dev` (API on :3000, Vite on :5173).

### Connect a real Telegram bot

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Copy `.env.example` to `.env` and set `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_IDS` (your numeric id; [@userinfobot](https://t.me/userinfobot) tells you).
3. `npm start`. Locally the bot uses long polling, so it works immediately.
4. For the Mini App (live map, desk) Telegram needs HTTPS: deploy it (below) and set `PUBLIC_URL`. The server then switches to a webhook and registers the Mini App as the bot's menu button.

To list a real pharmacy, its owner sends `/partner` to the bot. An admin approves it from Telegram.

### Deploy publicly

The repo ships a `Dockerfile`, a `fly.toml` and a `render.yaml`. The app is one process with an SQLite file, so it needs a single always-on instance and a small persistent volume. See [docs/DEPLOY.md](docs/DEPLOY.md).

## Checks

```bash
npm test
```

```bash
npm run typecheck
```

There are 25 tests: catalog matching, the domain rules (broadcast radius, restricted medicines, authorization, split basket, reservation lifecycle, expiry), the full Telegram journeys driven through the studio transport, the HTTP API and its authorization boundaries, and Mini App signature verification. CI runs them on every push, then builds and smoke-tests the production server.

## How it's built

One Node process, one SQLite file, one bot codebase for every channel.

```
Telegram (live)  ─┐                         ┌─ Notifier ── edits/sends Telegram messages
Demo Studio fake ─┼─ grammY bot ─┐          │
Web / Mini App ───┴─ HTTP + SSE ─┼─ Domain ─┼─ Simulator (demo pharmacies)
                                 │ service  └─ SSE hub ─── web refetch
                       Catalog resolver ── SQLite (node:sqlite)
```

- **Domain service** (`src/domain/medifast.ts`) owns every rule: asks, per-item answers, the ranked board, split basket, reservations, expiry and authorization. Telegram, the web and the simulator all call it; none of them contain business logic.
- **Notifier** (`src/telegram/notifier.ts`) turns domain events into Telegram sends and edits, with per-message serialization and coalescing, so a change from any channel renders identically everywhere.
- **Demo Studio transport** (`src/studio/fakeTelegram.ts`) answers grammY's Bot API calls in-process. The studio is the production bot, not a mock-up of it.
- **Catalog** (`data/catalog.src.tsv`, `src/catalog/`): a 105-product starter catalog with exact strengths, forms and prescription schedules, and a conservative resolver.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Demo script and viva preparation: [docs/DEMO_AND_VIVA.md](docs/DEMO_AND_VIVA.md).

## Honest limits

- The catalog is a hand-curated **starter set** for the pilot, not a licensed drug database. Entries should be checked against pack labels before a real pilot.
- Pharmacy licences are entered by the owner and approved by an admin; MediFast doesn't verify them with a regulator automatically.
- Answers are what a pharmacist says at that moment. MediFast doesn't guarantee stock, and nothing is sold or paid for in the app.
- Local OCR handles printed prescriptions; handwriting needs the optional Claude vision reader (`ANTHROPIC_API_KEY`). Either way the output is only candidate text that the customer confirms.
- The demo network and its replies are fictional. Real performance numbers would come from a pilot with real pharmacies.
