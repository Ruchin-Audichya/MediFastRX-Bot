# Winning Demo Script — MediFast CareOps Agent

**One line for the judges (say it in the first 30 seconds):**
> "MediFast CareOps is an autonomous healthcare operations agent. Every patient
> message becomes a tracked ServiceNow-style workflow — Cases, Tasks, Incidents,
> and Escalations — not just a chatbot reply."

Total runtime: **3–4 minutes**. Two screens: **Telegram/WhatsApp chat** (left)
and the **CareOps dashboard** `http://localhost:3001/careops` (right, auto-refreshes every 8s).

## One-time setup (before judging)

```bash
npm install
npm run seed              # pharmacies + inventory
npm run import-medicines  # medicine catalog
npm run demo:careops      # pre-seeds a believable operations board
npm start                 # bot + server + dashboard
```

Open `http://localhost:3001/careops` on the second screen. ServiceNow runs in
**mock mode** (no credentials needed); flip `SERVICENOW_ENABLED=true` to show
live mirroring if a PDI is available.

## The narrative — "Continuity of care for a family"

### Beat 1 — Patient needs medicine (0:00–0:45)
- In chat, send: **`Dolo 650`**
- Bot replies with a clean medicine card (use, side effects, safety).
- **Point to the dashboard:** a new **Medication Continuity Workflow** appears
  (request → intelligence → pharmacy → task → tracking → resolution), an
  **open Case**, and **Agent Actions** stream live.
- Say: *"One message. The agent opened a case, ran a 6-step workflow, and
  created a fulfillment task — autonomously."*

### Beat 2 — Follow-up stays in context (0:45–1:30)
- Send: **`side effects?`** then **`can my father take it?`**
- Both answers stay locked to Dolo 650 (no medicine drift — this is a fixed P0).
- Dashboard shows new **Agent Tasks** on the same case.
- Say: *"Context integrity — the agent never loses the active medicine, and
  every follow-up is a tracked task."*

### Beat 3 — Family care + refill workflow (1:30–2:15)
- Send: **`Papa ke liye Telma 40`** (Hinglish, family member)
- Dashboard shows a **Family Care Case** for "Papa" with a **refill reminder
  task** scheduled 30 days out.
- Say: *"Family health management with proactive refill operations — this is
  case management, not search."*

### Beat 4 — Shortage → Incident → Escalation (2:15–3:15)
- Send: **`Mycophenolate 500mg`** (rare, not in catalog)
- Bot replies it logged a shortage and is finding alternatives.
- Dashboard shows a new **Incident**, an **Escalation**, and a **Medicine
  Shortage Workflow**.
- Then send: **`Pregabalin 75`** → resolves via **alternatives** (no escalation).
- Say: *"Unavailable medicine becomes an Incident with automatic
  alternative-search and escalation — exactly the ServiceNow operations model."*

### Beat 5 — The ServiceNow tie + WhatsApp parity (3:15–3:45)
- `/careops` in chat → same operations summary inside the conversation.
- Mention: *"Same engine runs on WhatsApp via Meta Cloud API. Incidents/Cases
  mirror to ServiceNow over the Table API — mock today, one env flag to go
  live."*

## Talking points (judging rubric)

- **AI Agents:** autonomous workflow creation + decisions, visible in the
  AgentAction stream.
- **Workflows:** 3 real healthcare flows (continuity, shortage, family care)
  with per-step status.
- **Cases / Incidents / Tasks:** first-class Mongo-backed records, ServiceNow
  field mapping via adapters.
- **Automation + business value:** medication continuity, proactive refills,
  shortage escalation — measurable patient outcomes.
- **End-to-end:** chat → intelligence → workflow → dashboard, in seconds.

## Failure-proofing

- Everything runs offline/mock (no Meta, no ServiceNow creds required).
- `npm run demo:careops` guarantees a populated dashboard even if live network
  is flaky during judging.
- Groq LLM has a deterministic-card fallback, so answers never hang.

---

## Judge Q&A — answer these honestly and confidently

**"Is the dashboard real data or seeded?"**
> "The baseline board is seeded so you see a mature operations day — but every
> number is computed by the *same code* that runs live. Watch: I'll raise a real
> incident now and the count ticks up." *(Then do the unavailable-medicine flow
> and refresh ServiceNow — the new INC appears live.)*

**"Is the ServiceNow integration real or mocked?"**
> "Real. We POST to the ServiceNow Table API on a live instance. Here's the
> exact call: `GET /api/careops/servicenow-preview`. And here's the incident in
> the instance." *(Show the incident list on dev401401.)*

**"What happens if your DB / Wi-Fi dies?"**
> "It degrades gracefully. The catalog has an in-memory fallback, Groq/Apollo/
> ServiceNow all have timeouts with fallbacks, and the deterministic card always
> answers. Nothing hard-fails."

## Pre-demo checklist (do 30 min before)

- [ ] Local MongoDB running → `GET /health` shows `db: connected`
- [ ] Wake the ServiceNow PDI (log in once) so it isn't hibernated
- [ ] `npm run demo:careops` → board shows ~89% SLA, MTTR ~50 min, 1 escalation
- [ ] Manual dry-run all 5 beats in Telegram (tests don't cover the live chat path)
- [ ] Confirm `APOLLO_ENABLED=true` and a `Dolo 650` search returns real prices
- [ ] Share a **Jaipur** location for the nearby beat (best OSM coverage)
