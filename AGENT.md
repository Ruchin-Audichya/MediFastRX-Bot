# AGENT.md — Repository Guide for AI Agents

This file gives an AI agent (or a new engineer) everything needed to work in this
repo safely and productively. Read it before making changes.

---

## 1. What this project is

**MediFast CareOps** — an AI Healthcare Operations Agent. A Telegram + WhatsApp
bot that resolves medicines, finds pharmacies, and turns every request into
ServiceNow-style operational records (Cases, Tasks, Incidents, Workflows) with
SLA/MTTR tracking and a live dashboard. Built for the ServiceNow hackathon.

**Core principle:** *deterministic-first*. The verified medicine catalog is the
source of truth. The LLM only writes friendly prose around verified facts and is
double-sanitized. Never let the LLM invent dosage, frequency, prescription, or stock.

---

## 2. Tech stack

- **Runtime:** Node.js 18+ (CommonJS, no build step)
- **Bot:** grammY (Telegram) + Meta WhatsApp Cloud API
- **DB:** MongoDB via Mongoose
- **LLM:** Groq (`meta-llama/llama-4-scout-17b-16e-instruct`)
- **Embeddings/RAG:** `@xenova/transformers` (MiniLM, local) + local JSON vector store + Fuse.js
- **Integrations:** ServiceNow Table API, Apollo Pharmacy (via parse.bot scraper)
- **Server:** Express (health, dashboard, webhooks)
- **Tests:** built-in `node --test` (81 test files, 396 tests)

---

## 3. Directory map (`src/`)

| Folder | Responsibility |
|---|---|
| `ai/` | entity extraction, router, tool registry |
| `bot/` | grammY bot, commands (`search`, `nearby`, `careops`, `sos`, `family`, `admin`) |
| `cache/` | per-user TTL response/medicine cache |
| `careops/` | **ServiceNow-style ops layer** — models, service, workflowEngine, listener, dashboard |
| `context/` | canonical `medicineContext` (the follow-up/anti-drift object) |
| `diagnostics/` | runtime trace + health helpers |
| `events/` | `eventBus` (EventEmitter) + listeners (analytics, careops, guardian, history) |
| `integrations/` | `servicenow/`, `whatsapp/`, `parse/` (Apollo), `mediatlas/`, `ocr/` |
| `medicine/` | normalizer, knowledge service, importer, relationships, **llmAugmentService** |
| `memory/` | semantic + conversation memory |
| `models/` | Mongoose schemas (MedicineKnowledge, Pharmacy, Inventory, SosRequest, …) |
| `orchestrator/` | workflow planner, tool executor, evidence collector + integrity guard |
| `pharmacy/` | discovery, ranking, location, availability, recommendation |
| `providers/` | LLM providers (groq, deterministic, llama) |
| `rag/` | retriever, hybridRetriever, reranker, chunker, embeddings, localVectorStore |
| `services/` | searchService, conversationContextService, intentEngine, family, history, memory, rag |
| `utils/` | logger (winston), **formatter** (all message rendering) |

Other top-level: `config/` (db, cities), `scripts/` (21 ops/seed/diagnostic scripts),
`knowledge-base/` (RAG markdown), `data/` (seeds + vector store), `docs/`, `tests/`.

---

## 4. The CareOps layer (most important new system)

- **Models** (`src/careops/models/`): `CareCase`, `CareTask`, `CareIncident`, `CareWorkflow`, `AgentAction`. Convention: mongoose + `timestamps:true` + enum `status` field.
- **`careOpsService.js`**: create/transition helpers, number generation (`CASE…`, `INC…`, `TASK…`, `WF…`), SLA stamping, escalation, `getDashboardSnapshot`, `computeOperationalMetrics`. Every state change writes an `AgentAction` with a `reasoning` line.
- **`workflowEngine.js`**: the healthcare workflows — `runMedicationContinuity`, `runMedicineShortage`, `runFamilyMedicationShortage` (flagship), `runFamilyCare`, `runFollowUpTask`, `runMedicationFulfillment`.
- **`careOpsListener.js`**: subscribes to events the bot **already emits** (`search.completed`, `medicine.lookup.failed`, `side_effect.query`, `nearby.completed`). **This is the entire integration surface — CareOps never modifies core medicine/pharmacy flows.**
- **`dashboard/`**: Express router (`/careops`, `/api/careops/*`) + single-file HTML view.

**Golden rule for CareOps:** it is *additive and event-driven*. To make the agent
do something new operationally, subscribe to an existing event — don't edit the
hot path. `eventBus.emitSafe` isolates listener errors from the user reply.

---

## 5. Integration modes (all env-flagged, default OFF/mock)

| Integration | Flag | Off behavior |
|---|---|---|
| ServiceNow | `SERVICENOW_ENABLED` | mock refs, realistic preview URL |
| Apollo (parse.bot) | `APOLLO_ENABLED` | `{ ok:false, disabled:true }`, falls back to Groq |
| WhatsApp | `WHATSAPP_ENABLED` | mock sender logs instead of calling Meta |
| Parse pharmacy locator | `PARSE_ENABLED` | disabled stub (no India location data exists) |

**Never hardcode secrets.** All creds come from `.env` (gitignored). Never log
tokens/passwords — log presence/mode only.

---

## 6. Conventions an agent MUST follow

1. **CommonJS** (`require`/`module.exports`), not ESM.
2. **All message rendering lives in `src/utils/formatter.js`.** Don't build HTML strings ad hoc in handlers.
3. **Tests pin formatter/keyboard structure.** Before changing `buildSearchActionKeyboard`, `buildNearbyActionKeyboard`, `formatMedicineCard`, or `formatSearchResults`, check `tests/` — several tests assert exact button text/positions. Prefer **adding new functions** (e.g. `formatConversationalMedicine`) over mutating tested ones.
4. **Safety floor is non-negotiable.** Keep the system prompt rules + `stripUnsafeLines` sanitizer. Never surface invented dosage/stock/prescription.
5. **Deterministic-first.** The catalog/`normalizeMedicineQuery` is the source of truth; the LLM only augments.
6. **Graceful degradation.** Every external call needs a timeout + try/catch that returns a safe fallback. Never let an integration throw into the user reply.
7. **Feature-flag new external deps** OFF by default so the demo runs offline.
8. **Conversational UX** is the default (`CONVERSATIONAL_MODE`, default ON): short, WhatsApp-like replies + quick-action buttons. Verbose cards only when explicitly requested.

---

## 7. Commands

```bash
npm start                 # bot + server + dashboard
npm test                  # full suite (node --test, 396 tests)
npm run seed              # seed pharmacies + inventory
npm run import-medicines  # load medicine catalog from data/medicine-sources
npm run ingest            # build RAG vectors
npm run demo:careops      # seed a believable CareOps operations board (for demos)
```

Diagnostics: `npm run diagnose-rag | diagnose-llm | diagnose-memory | diagnose-catalog | production-health`.

**Always run `npm test` after changes and keep it green (currently 396/396).**

---

## 8. Verifying changes

- After editing: `node --test <specific test file>` for fast feedback, then the full `npm test`.
- For HTTP/dashboard changes: start the bot and curl `/health`, `/api/careops/summary`, `/api/careops/servicenow-preview`.
- For ServiceNow live mode: confirm `GET /api/careops/health` reports `mode: live` and a real `INC…` is created.
- Note: requiring `src/bot/index.js` in a one-off `node -e` script will *not exit* (the bot keeps the event loop alive). That's expected, not a hang. Use the test runner to validate.

---

## 9. Repo hygiene (keep it clean)

- **Don't commit:** `.env`, `.env.*`, `data/chroma/` (huge vectors), `logs/`, `node_modules/`, `medifast-careops-repomix.md` — all gitignored.
- **Temp test-output files** (`*.txt` capture files) must be deleted after use — never leave them in the tree.
- Generated pack: `npx repomix` (config in `repomix.config.json`) → `medifast-careops-repomix.md` (gitignored).
- Docs live in `docs/`. Specs live in `.kiro/specs/`.

---

## 10. Known state & follow-ups

- **Green:** 396/396 tests. ServiceNow live (PDI `dev401401`), Apollo live, conversational UX, location distance-cap fix.
- **Security TODO:** the PDI password was exposed in chat during development — rotate it after the event.
- **Demo data:** `npm run demo:careops` backdates timestamps so MTTR/SLA read realistically (MTTR ~144 min, SLA ~50%, 1 escalation). Live conversation data is unaffected.
- **Open idea:** bi-directional ServiceNow status sync; partner inventory APIs; OCR prescription intake (scaffold present, flagged off).
