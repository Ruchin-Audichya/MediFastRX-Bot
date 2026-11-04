# Deploying MediFast publicly

MediFast is one Node process with an SQLite file. It needs:

- **one always-on instance** (the bot receives webhooks and expires requests every 15 s),
- **a small persistent volume** for the SQLite file (or accept that the demo re-seeds on every deploy),
- **HTTPS**: required by Telegram for webhooks and Mini Apps. Both options below provide it.

## Option A: Fly.io (Mumbai region, persistent volume)

```bash
fly launch --no-deploy --copy-config
```

```bash
fly volumes create medifast_data --size 1 --region bom
```

```bash
fly secrets set TELEGRAM_BOT_TOKEN=... ADMIN_TELEGRAM_IDS=... TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24) PUBLIC_URL=https://<your-app>.fly.dev
```

```bash
fly deploy
```

## Option B: Render

1. New → Blueprint → select this repository (it reads `render.yaml`).
2. Fill in `PUBLIC_URL` (the `https://….onrender.com` address Render assigns), `TELEGRAM_BOT_TOKEN`, `ADMIN_TELEGRAM_IDS`, and optionally `ANTHROPIC_API_KEY`.
3. The blueprint uses a paid instance with a 1 GB disk. On the free plan, delete the `disk` block. The database then resets on each deploy and the fictional demo network seeds itself again. Free instances also sleep when idle, which delays the first Telegram message after a pause.

## After the first deploy

- Visit `https://<your-app>/healthz`. It should show `"live": true`.
- Open your bot in Telegram and send `/start`. The menu button opens the Mini App.
- `https://<your-app>/studio` keeps working for live demos (set `DEMO_MODE=false` to hide the fictional network in a real pilot).

## Going from demo to a real pilot

1. Set `DEMO_MODE=false` so only real, approved pharmacies receive requests.
2. Have each pharmacy send `/partner` to the bot. Verify the drug licence with the state drug controller before tapping **Approve**.
3. Review `data/catalog.src.tsv` against actual pack labels for the products your partners stock.
4. Publish a privacy notice that matches `/privacy` in the bot, and back up `/data/medifast.db` daily.
