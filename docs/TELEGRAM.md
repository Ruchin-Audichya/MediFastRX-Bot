# MediFast on Telegram

The optional grammY adapter uses the same catalog resolver, conversation service, evidence selector, and pharmacy discovery service as the web app. It does not run a second matching or medicine-generation pipeline. The web app remains the main place for authenticated requests, prescription files, inventory, and pharmacist review.

## Try it without a token

```bash
npm ci
npm run bot:demo
# Repeatable, noninteractive terminal smoke check:
npm run bot:demo -- --smoke
```

This terminal simulation executes the real Telegram middleware with a simulated outgoing API. It clearly labels the included demo catalog and fictional pharmacy results. It makes no Telegram, map-provider or AI requests. Choose the displayed inline actions with `#1`, `#2`, etc.; `/quit` exits.

## Connect your bot locally

Use Node 24. Create a bot with Telegram's **@BotFather**. Put its token in an **untracked** `.env`, using `.env.example` as the template:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_MODE=polling
PHARMACY_MODE=live
```

Fill the empty token value privately. Never paste it into a GitHub issue, tracked file, screenshot, URL or shell history. The older `BOT_TOKEN` variable is also accepted for migration.

```bash
npm run bot:check   # Calls getMe, prints only the bot username; sends no chat messages
npm run bot         # Long polling, no public server or tunnel required
# Or run web + API + Telegram together:
npm run dev:all
```

Only one polling process should use a token. Stop it with Ctrl+C. Web-only development is still `npm run dev`; a missing Telegram key does not stop that mode. AI is optional: `GROQ_API_KEY` selects supplied catalog sentences, with a four-second fallback. Search itself never waits for AI. See [grammY polling/webhook guidance](https://grammy.dev/guide/deployment-types).

## A complete conversation

1. `/start`, then send **Mujhe Dolo 650 chahiye**.
2. Inspect the matched name, strength, formulation, ingredient and linked source.
3. Tap **Side effects**, ask **iska generic**, or choose **AI evidence summary**. Optional AI output is explicitly labeled; off/slow/invalid AI returns supplied catalog text.
4. Search **Paracetmol**. Choose a candidate explicitly. Wrong strengths never silently resolve to another strength. Buttons from an older medicine cannot change the current context.
5. Ask **mere aas paas kaha milegi?**. Choose a one-time location pin after the disclosure, or type **Jaipur**. `/nearby Mansarovar, Jaipur` also works.
6. Read sourced phone numbers, addresses, straight-line distances, listed hours, directions and source links. Missing contact details stay missing; public listings always say **Stock unknown. Call to confirm.**
7. Continue into the web application to save a reference, scan a prescription, or submit an authenticated availability request. Confirming and dispensing remain a participating pharmacist's responsibility.
8. `/reset` clears the context; `/privacy` explains retention.

Commands: `/start`, `/search name`, `/nearby area`, `/explain`, `/ai`, `/reset`, `/web`, `/help`, `/privacy`. English and common Hinglish phrasing work. Photos/PDFs and voice notes in Telegram receive an honest explanation and a link to the web scanner where configured. They are not secretly processed or stored.

## Web handoff

Set `TELEGRAM_APP_URL` to the public **HTTPS** frontend origin when you have an authorized hosted app. A confirmed medicine link opens `?medicine=<catalog-id>`; a partner link also uses `screen=partners` and puts that exact medicine in a request basket. It never submits a request automatically. The scanner link opens the private workspace and still requires authentication.

A Telegram button cannot make a computer's loopback server reachable from someone else's phone. When no public app URL is configured, `/web` explains the local address instead of presenting a broken button. This repository does not create a tunnel or deploy anything automatically.

## Optional webhook hosting

Polling is the local default. For an existing HTTPS host running the API:

```dotenv
TELEGRAM_MODE=webhook
TELEGRAM_BOT_TOKEN=
TELEGRAM_APP_URL=https://your-domain.example
TELEGRAM_WEBHOOK_URL=https://your-domain.example/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=
```

Fill both secrets privately. Generate a webhook secret with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"` and save it only in the environment. Start the web/API, then explicitly register:

```bash
npm run bot:webhook -- --set
# To remove it while preserving pending updates:
npm run bot:webhook -- --delete
```

The API mounts **grammY's Express `webhookCallback`**, with constant-time secret-header verification, validated/bounded JSON, duplicate-update suppression and per-user serialization. The management script sets one webhook connection. It never runs long polling concurrently with a webhook. HTTPS must route `/api/telegram/webhook` to the API and allow up to 60 seconds for bounded provider calls and replies. This is a single-process adapter; do not scale it across replicas or deploy it to short-lived serverless handlers without a durable queue/session design. Context and retry suppression are intentionally in memory and reset at process restart; this bot performs no ordering or inventory mutations.

## Privacy and operational limits

Private chats only. Context expires after 30 minutes and is bounded to 1,000 sessions. No chat text or shared coordinates are logged or persisted. Pending area candidates contain public area centers; a user's shared location is used for one provider search and is not retained in the session. `/reset` removes that user's context. Telegram itself retains messages according to its policies. Share only information you are comfortable sending through Telegram.

The bot limits incoming messages, AI summaries and nearby searches per user. It processes a bounded number of pending updates per user and replies with recovery guidance on failures. Provider caches are the same bounded caches used by the web service. Source hours are unverified text, never a computed “open now” claim. Do not use this experiment as a prescribing or emergency service.

Automated coverage uses simulated Telegram API responses and local HTTP webhook delivery, not a claimed live Telegram conversation. A real bot token and opt-in chat are required for the final live acceptance check. Run `/start` → Dolo 650 → Side effects → nearby → location/area → web handoff once after configuring them.
