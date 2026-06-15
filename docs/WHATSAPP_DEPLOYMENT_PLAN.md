# WhatsApp Deployment Plan — MediFast CareOps

The WhatsApp channel reuses the **exact** MediFast intelligence (search,
context/follow-up, family memory, pharmacy discovery) and emits the **same
events**, so CareOps workflows fire identically on WhatsApp and Telegram. It
ships in **mock mode** (no Meta credentials) so it is fully testable today, and
flips to live with three env vars.

## Code shipped

| File | Role |
|---|---|
| `src/integrations/whatsapp/whatsappClient.js` | Cloud API sender (`sendText`, `requestLocation`); mock when `WHATSAPP_ENABLED!=true` |
| `src/integrations/whatsapp/messageProcessor.js` | Channel-agnostic core: text + location → reuses `searchMedicine`, `resolveContextualQuery`, `recommendNearbyPharmacies`; emits `search.completed` / `medicine.lookup.failed` / `nearby.completed` |
| `src/integrations/whatsapp/router.js` | Webhook: `GET/POST /webhook/whatsapp` (verification + inbound) |
| Mounted in `src/server.js` | `app.use(createWhatsAppRouter())` |

Identity is namespaced as `wa:<phone>` so WhatsApp users never collide with
Telegram ids in the shared context store.

## Meta setup (one-time)

1. **Meta for Developers** → create an app (type: Business) → add **WhatsApp**.
2. Note the **Phone Number ID** and a **temporary access token** (Graph API).
   For production, create a **System User** + permanent token.
3. **Configure webhook**:
   - Callback URL: `https://<your-domain>/webhook/whatsapp`
   - Verify token: must equal `WHATSAPP_VERIFY_TOKEN` (default `medifast-careops-verify`)
   - Subscribe to the **messages** field.
4. Add a recipient test number (sandbox) or complete business verification.

## Environment

```env
WHATSAPP_ENABLED=true
WHATSAPP_TOKEN=<permanent or temp token>
WHATSAPP_PHONE_NUMBER_ID=<from Meta dashboard>
WHATSAPP_API_VERSION=v21.0
WHATSAPP_VERIFY_TOKEN=medifast-careops-verify
```

## Deploy

1. Host the Express server with a public HTTPS domain (Render/Railway/Fly/VPS).
   The same process already serves Telegram + the CareOps dashboard.
2. Set the env vars above; restart.
3. In the Meta dashboard, click **Verify and Save** on the webhook — the
   `GET /webhook/whatsapp` handler answers the `hub.challenge`.

## Testing

- **Local, no Meta:** unit tests cover payload parsing and the mock sender:
  `node --test tests/careops.whatsapp.test.js`.
- **Verification handshake:**
  `GET /webhook/whatsapp?hub.mode=subscribe&hub.verify_token=medifast-careops-verify&hub.challenge=123`
  → returns `123`.
- **Inbound simulation (mock send):**
  `POST /webhook/whatsapp` with a Cloud API text payload → 200, reply logged.
- **End to end:** message the test number "Dolo 650" → medicine card reply; the
  CareOps dashboard (`/careops`) shows a new Medication Continuity workflow.

## Monitoring

- `GET /api/whatsapp/health` → `{ mode, enabled, phoneNumberIdConfigured }`.
- Inbound/outbound are logged via the shared winston logger (no tokens logged).
- Failures degrade gracefully: a send error never throws into the webhook,
  which always returns 200 quickly (Meta best practice).

## Production hardening checklist

- [ ] Permanent System-User token (not the 24h temp token).
- [ ] Optional: verify `X-Hub-Signature-256` against the app secret on inbound.
- [ ] Rate limiting already applies to `/api`; add it to `/webhook/whatsapp` if abused.
- [ ] Message templates approved if you need to initiate conversations (>24h window).
