# Going live: from demo to a real Telegram bot

About 30 minutes, start to finish. You need a Telegram account on your phone and a laptop with Node.js.

## Step 1 · Create the bot (2 minutes, on your phone)

1. In Telegram, open **@BotFather** (blue tick) and tap **Start**.
2. Send `/newbot`.
3. **Name** (shown to users): `MediFast`
4. **Username** (must end in `bot` and be unique). Ours is **`MediFast2_bot`** → https://t.me/MediFast2_bot
5. BotFather replies with a **token** like `7123456789:AAH...`. Treat it like a password: never post it in a chat or on GitHub.
6. Optional, but it looks finished:
   - `/setdescription` → `Ask every chemist nearby at once. Send your medicine list; see who has it; reserve and pick up.`
   - `/setabouttext` → `Medicine availability, answered by pharmacists. Not a pharmacy; no payments or delivery.`
   - `/setuserpic` → upload `docs/logo.svg` exported as a PNG.

## Step 2 · Find your Telegram user id (1 minute)

Open **@userinfobot** and tap **Start**. It replies with your numeric **Id**. This makes you the admin who approves pharmacies.

## Step 3 · Run it on your laptop (5 minutes)

In the project folder, copy `.env.example` to `.env` and fill in:

```
TELEGRAM_BOT_TOKEN=7123456789:AAH...your token...
ADMIN_TELEGRAM_IDS=123456789
```

Check the token:

```bash
npm run bot:check
```

You should see `✔ Token works: @MediFast2_bot`. Then start everything:

```bash
npm run demo
```

The launcher reads `.env`, so the **real bot** now runs alongside Demo Studio. Open your bot in Telegram and send `/start`. Try `Dolo 650` → **Add to list** → **Ask pharmacies nearby** → **Vaishali Nagar** → **Send**. The fictional demo pharmacies answer within seconds.

> While running on your laptop, the bot works only while the laptop is on. The **Live map** button needs HTTPS, so it appears after Step 4.

## Step 4 · Put it on the internet (15 minutes)

Follow [DEPLOY.md](DEPLOY.md) (Fly.io or Render). Set these secrets there, not in Git:

| Secret | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | from BotFather |
| `ADMIN_TELEGRAM_IDS` | from @userinfobot |
| `PUBLIC_URL` | the `https://…` address your host gives you |
| `TELEGRAM_WEBHOOK_SECRET` | any long random text |
| `STUDIO_PASSWORD` | a password for Demo Studio, so strangers can't reset your demo |

On start-up the server registers the webhook and adds a **MediFast** menu button that opens the Mini App. Check with `https://<your-app>/healthz`; it should say `"live": true`.

## Step 5 · Onboard a real pharmacy

See [PILOT_KIT.md](PILOT_KIT.md): what to say, what the pharmacist does, and what to measure. In short, the pharmacist sends `/partner` to your bot. You get an **Approve** card after checking their drug licence, and they're live.

When you run a real pilot, set `DEMO_MODE=false` so customers only reach real pharmacies.

## Retake the README screenshots (optional, 2 minutes)

The screenshots in `docs/screenshots/` show a grey map because they were captured where map tiles were blocked. On your laptop: run `npm run demo`, do one request in Demo Studio, and replace `studio.png`, `board-phone.png` and `pickup-phone.png` with your own screenshots (browser zoom 100%, window about 1440 px wide; use your browser's mobile view for the phone ones).

## If something goes wrong

| Symptom | Fix |
| --- | --- |
| `bot:check` says *Unauthorized* | Token copied wrongly. In BotFather: `/mybots` → your bot → **API Token**. |
| `bot:check` can't reach Telegram | Check the internet connection; some college networks block Telegram, so try a phone hotspot. |
| Bot doesn't reply | Only one copy of the bot may run at a time. Stop other running copies (or the deployed one) when testing locally. |
| Pharmacy never gets requests | It must be **approved** and **open** (`/open`), and within the customer's radius. |
| Nobody can approve pharmacies | `ADMIN_TELEGRAM_IDS` is missing or wrong. |
