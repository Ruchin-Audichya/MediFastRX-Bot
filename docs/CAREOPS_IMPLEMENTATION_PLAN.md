# CareOps Implementation Plan

MediFast → **MediFast CareOps Agent**: a thin ServiceNow-style operations layer
on top of the existing, verified MediFast intelligence. No core flow is
rewritten. CareOps **listens** to events MediFast already emits and turns them
into operational records (Cases, Tasks, Incidents, Workflows) with status
tracking, escalation, and a judge-facing dashboard.

## Audit — what already exists (reused as-is)

| Capability | Module | CareOps reuse |
|---|---|---|
| Event bus | `src/events/eventBus.js` (`emitSafe`, `on`) | Subscribe, never modify emitters |
| Search success | event `search.completed` | → open **Medication Continuity Workflow** + Task |
| Lookup failure | event `medicine.lookup.failed` | → open **Incident** + alternative search |
| Pharmacy discovery | event `nearby.completed` | → advance workflow, close fulfillment task |
| Follow-up | event `side_effect.query` | → **Agent Task** on active case |
| Family context | `familyService`, memory | → **Case** per family member |
| Models | mongoose + `timestamps` + enum `status` | Same convention for CareOps models |
| Listener pattern | `events/listeners/*` | New `careOpsListener` |
| HTTP server | `src/server.js` (Express) | Mount `/careops` dashboard + API |

## Design — thin layer, 5 domain objects

```
src/careops/
  models/        CareCase, CareTask, CareIncident, CareWorkflow, AgentAction
  careOpsService.js     repository + create/transition helpers (status, escalation)
  workflowEngine.js     3 workflows: continuity, shortage, familyCare
  careOpsListener.js    event-bus subscriber → drives the engine
  dashboard/            Express router + single-file HTML (judge view)
src/integrations/servicenow/
  serviceNowClient.js   mock | live (env-gated), retry, no-secret-logging
  incidentAdapter.js / caseAdapter.js / taskAdapter.js / workflowAdapter.js
```

**Status model (shared):** `open → in_progress → escalated? → resolved → closed`.
Every transition writes an `AgentAction` (the autonomous "agent did X" trace the
judges see). Escalation is a flag + timestamp on the record plus an
`AgentAction` of type `escalation`.

**ServiceNow mapping (already natural in MediFast):**
medicine search → Knowledge retrieval; request → Service Request (Workflow);
unavailable → **Incident**; refill → Workflow; family health → **Case**;
follow-up → **Task**; pharmacy coordination → Workflow Automation.

## Integration strategy

1. `careOpsListener` registered in `createBot()` alongside existing listeners.
   It is **purely additive** — if CareOps throws, `emitSafe` already isolates it
   and the bot is unaffected.
2. ServiceNow adapters run in **mock mode by default** (`SERVICENOW_ENABLED=false`)
   so the platform is deployable and demoable without credentials. Live mode
   posts real Incidents/Cases via REST when creds are present.
3. Dashboard at `GET /careops` (HTML) + `GET /api/careops/*` (JSON) for the demo.
4. Demo seed (`scripts/seedCareOps.js`) + Telegram `/careops` command + a
   one-shot `npm run demo:careops` so the full story runs in < 3 minutes.

## Build order (continuous, test after each)

1. Models (5) + service + workflow engine — unit tested.
2. Listener wired into bot — integration tested against fake event bus.
3. ServiceNow adapters (mock/live) — unit tested, no secrets logged.
4. Dashboard + JSON API — route tested.
5. WhatsApp Cloud API adapter (webhook + send) reusing `handleSearch`.
6. Demo seed + commands. Keep full suite green throughout.

## Non-goals

No ServiceNow clone. No rewrite of medicine/RAG/pharmacy/memory. No new DB
engine. No exposure of internal complexity in chat unless it adds user value.
