<div align="center">

# 🩺 MediFast CareOps
### An AI Healthcare Operations Agent — *Uber + Zomato for medicines, powered by ServiceNow*

A patient sends one message. An autonomous agent understands it, finds the medicine,
locates real pharmacies, and opens a **tracked ServiceNow operation** — Case, Incident,
Task, Workflow — that it drives to resolution. Not a chatbot. An operations agent.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Atlas-47A248?logo=mongodb&logoColor=white)
![ServiceNow](https://img.shields.io/badge/ServiceNow-Live%20Table%20API-62D84E)
![Groq](https://img.shields.io/badge/Groq-LLM-F55036)
![Telegram](https://img.shields.io/badge/Telegram-Live-26A5E4?logo=telegram&logoColor=white)
![WhatsApp](https://img.shields.io/badge/WhatsApp-Cloud%20API-25D366?logo=whatsapp&logoColor=white)
![Tests](https://img.shields.io/badge/tests-396%20passing-22c55e)

</div>

> ⚕️ **Safety first.** MediFast helps people discover and obtain medicines. It is **not a doctor**
> and never invents dosage, frequency, prescriptions, or stock. Every AI answer is double-sanitized.

---

## 🎯 The 30-second pitch

> *"Finding a parent's medicine in India is a phone-tree scramble across chemists.
> MediFast turns one message into a tracked healthcare operation — it understands the
> medicine, finds real pharmacies near you, and if it's unavailable it opens a ServiceNow
> incident, finds alternatives, and escalates — all on a live operations dashboard with
> SLA and MTTR. It's not a chatbot; it owns the problem to resolution."*

---

## ⭐ The story (STAR)

### **S — Situation**
1.4 billion people. Millions of daily medicine searches. Yet finding the *right* medicine —
correct brand, correct salt, actually in stock, nearby — is still a manual, anxious scramble.
You hold a handwritten *parchi*, the chemist shrugs, you call the next shop, then the next.
When it's a parent's chronic medicine that has run out, that scramble becomes an emergency.

### **T — Task**
Build something that doesn't just *answer* a medicine question, but **takes operational
ownership** of getting the patient their medicine — the way an enterprise service desk owns
an incident from report to resolution. And prove it maps cleanly onto ServiceNow.

### **A — Action**
We built **MediFast CareOps**: a conversational agent on Telegram + WhatsApp that, on every
request, autonomously:
1. **Understands** — brand, generic, salt, Hinglish, or typo (`Dolo 650`, `bukhar ki tablet`, `prrgabakin`).
2. **Retrieves** — verified medicine catalog + contamination-safe RAG + **live Apollo Pharmacy** brand/price/stock.
3. **Discovers** — real nearby pharmacies (OpenStreetMap live) with chain badges, open status, call & navigate.
4. **Operates** — opens a **ServiceNow Case**, runs a **Workflow**, creates **Tasks**, raises **Incidents**, and **escalates** when a medicine is unavailable.
5. **Tracks** — every action on a live **operations dashboard** with SLA compliance, MTTR, and an autonomous agent-action audit trail.

### **R — Result**
- A medicine request becomes an **owned, tracked, resolved operation** with measurable SLA / MTTR.
- **Real ServiceNow incidents** post to a live instance (`dev401401.service-now.com`) through the Table API.
- **Real India pharmacy data** (Apollo: *Dolo-650 ₹32, in-stock; Viagra 50mg ₹492*).
- **396 automated tests passing**, including two fixed P0 reliability bugs (RAG contamination, context drift).
- Runs **fully offline** in mock mode — the demo never depends on conference Wi-Fi.

---

## ❌ Why existing solutions fail

| Approach | What it does | Why it falls short |
|---|---|---|
| **Search apps** | Return a list and stop | No location truth, no follow-through, no ownership |
| **Chatbots** | Answer one question | Lose context — "can my father take it?" becomes a new search |
| **E-pharmacies** | Sell their own SKUs | Don't coordinate your neighbourhood chemist or escalate shortages |
| **Generic LLMs** | Chat fluently | Hallucinate dosages — unacceptable for medicine |

There's plenty of *information retrieval*. There's no *operational ownership*. That's our wedge.

---

## 💡 What makes this different from a chatbot

A chatbot **talks**. MediFast CareOps **operates**:

- It creates **Cases, Tasks, Incidents, and Workflows** — first-class records, not chat logs.
- It enforces **SLAs**, computes **MTTR**, and **escalates** breaches autonomously.
- It writes an **Agent Action audit trail** — every decision with a stated reason.
- It **never drifts medicines** — ask "side effects?" and it stays locked to the active medicine (a fixed P0 bug most assistants still have).

---

## 🏗 Architecture

```
        ┌──────────────────────────────┐
        │   Telegram  /  WhatsApp        │   ← conversational channels
        └───────────────┬──────────────┘
                        ▼
        ┌──────────────────────────────┐
        │      MediFast AI Agent         │   entity + intent + context retention
        └───────────────┬──────────────┘
                        ▼
  ┌───────────────────────────────────────────────┐
  │  Medicine Intelligence · RAG · Family Memory     │
  │  Pharmacy Discovery (OSM) · Apollo Live Catalog  │
  └───────────────┬─────────────────────────────────┘
                        ▼
        ┌──────────────────────────────┐
        │        CareOps Layer           │   Cases · Tasks · Incidents
        │   (event-driven, autonomous)   │   Workflows · Agent Actions · SLA
        └───────────────┬──────────────┘
                        ▼
        ┌──────────────────────────────┐
        │   ServiceNow Table API         │   real Incidents/Cases/Tasks
        │   (live mode · mock fallback)  │
        └───────────────┬──────────────┘
                        ▼
        ┌──────────────────────────────┐
        │   Operations Dashboard         │   SLA · MTTR · resolution · reasoning
        └──────────────────────────────┘
```

**Deterministic-first principle:** the verified medicine catalog is the source of truth.
The LLM only writes the friendly explanation *around* verified facts, and is double-sanitized.

---

## 🧠 The six AI layers

| Layer | Role | Key modules |
|---|---|---|
| **1. Conversation AI** | Follow-ups, context retention, zero medicine drift | `conversationContextService`, `context/medicineContext` |
| **2. Medical understanding** | Entity + intent + Hinglish/typo normalization | `entityExtractor`, `intentEngine`, `medicineNormalizer` |
| **3. Medicine intelligence** | Catalog + RAG + relationships + **live Apollo** | `searchService`, `ragService`, `integrations/parse/apolloMedicineClient` |
| **4. Pharmacy discovery** | OSM live pharmacies, chain recognition, best-option ranking | `pharmacyRecommendationService`, `pharmacyRankingService` |
| **5. ServiceNow workflow AI** | Cases/Tasks/Incidents/Workflows + escalation + SLA | `careops/*`, `integrations/servicenow/*` |
| **6. Personalized recommendation** | Family memory, refill workflows, reorder | `familyService`, `memoryService`, `careops/workflowEngine` |

---

## 🟢 ServiceNow integration — *the heart of the submission*

MediFast doesn't *mention* ServiceNow — it **runs on ServiceNow's operational model**.

### The mapping (healthcare → ServiceNow)

| Healthcare event | ServiceNow concept | What happens |
|---|---|---|
| Medicine search | **Knowledge retrieval** | Verified catalog + RAG grounding |
| Medicine request | **Service Request → Workflow** | Medication Continuity workflow opens |
| Medicine **unavailable** | **Incident** | Priority + SLA clock + escalation |
| Family healthcare need | **Case** | Per-family-member case management |
| Follow-up question | **Agent Task** | Task on the active case |
| Refill reminder | **Workflow** | Scheduled refill automation |
| Medication continuity | **End-to-end Workflow** | request → intelligence → pharmacy → task → resolution |
| Agent decision | **Agent Action** | Audit trail entry *with stated reasoning* |

### How it actually works (live, not cosmetic)

- The `ServiceNowClient` posts to the **ServiceNow Table API**:
  `POST https://dev401401.service-now.com/api/now/table/{incident | sn_customerservice_case | task}`
- **Adapters** map CareOps records to ServiceNow fields (priority `1–4`, impact/urgency, `correlation_id`, `correlation_display = "MediFast CareOps"`).
- **Two modes, env-flagged:**
  - **Live** (`SERVICENOW_ENABLED=true` + instance creds) → real incidents land on the PDI. *Verified: `INC0010001`, `INC0010002` created.*
  - **Mock** (default) → realistic synthetic refs, so the demo runs with zero credentials.
- **`GET /api/careops/servicenow-preview`** returns the *exact* Table API payload that would POST — proving the integration is real even in mock mode.
- **Graceful degradation:** if ServiceNow is down, the local operation still completes and the bot keeps working. Secrets are **never logged**.

### What to show judges in ServiceNow
1. The bot raises an **Incident** in chat → refresh the ServiceNow **Incident list** → it's there, live.
2. The **Case** umbrella linking the Incident + Tasks for a family member.
3. The **SLA / priority** fields populated by our adapters.
4. The **payload-preview endpoint** — the literal REST call.

> **Why ServiceNow is critical here:** healthcare fulfillment *is* an operations problem —
> intake, prioritization, SLAs, escalation, resolution. ServiceNow is the world's operations
> platform. MediFast is the patient-facing agent that *feeds* and *drives* it.

---

## 🔍 How RAG works (and why it's safe)

1. Verified medicine records + curated notes are **chunked** (`identity`, `safety`, `relationships`) and embedded locally with `Xenova/all-MiniLM-L6-v2` (384-dim, in-process, no API).
2. Vectors persist in a local store (`data/chroma/`).
3. At query time: **hybrid retrieval** = vector (cosine) + keyword (Fuse.js), **scoped to the active medicine**, reranked with a medicine-identity signal.
4. An **evidence-integrity guard** drops any chunk that doesn't belong to the active medicine — so **Pregabalin never pulls Gabapentin evidence** (a real contamination bug we fixed).
5. Groq synthesizes a grounded answer from **validated evidence only**, sanitized to strip any dosage/stock/prescription claim.

RAG here isn't decoration — it's the **contamination-safe grounding layer** that lets follow-ups work without drifting medicines.

---

## 🎬 Demo flow (3 minutes)

```bash
npm install
npm run seed && npm run import-medicines   # pharmacies + medicine catalog
npm run demo:careops                        # pre-seed a believable operations board
npm start                                   # bot + server + dashboard
```

Open the dashboard at **`http://localhost:3001/careops`** on a second screen.

| Beat | In chat | On the dashboard / ServiceNow |
|---|---|---|
| 1 | `Dolo 650` | Continuity Workflow + Case appear; agent actions stream live |
| 2 | `side effects?` | Stays locked to Dolo 650 (no drift); a Task is created |
| 3 | `Papa ke liye Pregabalin` *(unavailable)* | **Family Case + Incident + escalation** — refresh ServiceNow, the incident is there |
| 4 | tap **📍 Nearby** → share location | Real pharmacies, chain badges, **Start Fulfillment** |
| 5 | `/careops` | Live **SLA / MTTR / resolution** KPIs in chat |

Full script: [`docs/WINNING_DEMO_SCRIPT.md`](docs/WINNING_DEMO_SCRIPT.md)

---

## ⚙️ Setup

**Prerequisites:** Node.js 18+, MongoDB, a Telegram bot token (BotFather), a Groq API key.

```bash
git clone <your-repo-url>
cd MediFastRX-Bot
npm install
cp .env.example .env          # Windows: Copy-Item .env.example .env
```

Minimum `.env`:
```env
TELEGRAM_BOT_TOKEN=your_botfather_token
MONGODB_URI=mongodb://localhost:27017/medifast
GROQ_API_KEY=your_groq_key
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
ENABLE_LLM_SYNTHESIS=true
LLM_PROVIDER=groq
```

Optional power-ups (all OFF by default, safe to leave blank):
```env
# Live ServiceNow (real incidents)
SERVICENOW_ENABLED=true
SERVICENOW_INSTANCE=dev401401
SERVICENOW_USER=admin
SERVICENOW_PASSWORD=********

# Live Apollo Pharmacy catalog (real prices/stock)
APOLLO_ENABLED=true
PARSE_API_KEY=pmx_********
```

```bash
npm start          # start the bot, API server, and dashboard
npm test           # 396 tests
```

---

## 🧪 Quality & reliability

- **396 automated tests** (`node --test`) covering the agent, CareOps, RAG, pharmacy, ServiceNow, WhatsApp, and the two P0 fixes.
- **Two P0 bugs fixed & regression-locked:** RAG cross-medicine contamination, and follow-up context drift.
- **Safety floor:** system prompt + code sanitizer strip any dosage/stock/prescription claim.
- **Graceful degradation everywhere:** ServiceNow, Apollo, WhatsApp, and Groq all fall back cleanly.

---

## 🛣 Future vision

- Bi-directional ServiceNow sync (status updates flow back to the patient).
- Apollo / 1mg / PharmEasy partner APIs for real-time inventory (adapter layer ready).
- Photo-of-prescription intake (OCR scaffold present, flagged off).
- Population-scale proactive refill automation and guardian alerts.

---

## 🏆 Why we can win

- **It's operations, not a chatbot** — Cases, Incidents, Tasks, Workflows, SLAs, MTTR, escalation, autonomous audit trail.
- **The ServiceNow integration is real and provable** — live Table API incidents + a payload-preview endpoint.
- **Real India data** — verified catalog + live Apollo prices + OpenStreetMap pharmacies.
- **It runs offline** — mock modes mean the demo never fails on Wi-Fi.
- **It's real software** — 396 passing tests, fixed P0 reliability bugs, clean architecture.

<div align="center">

*Built for ServiceNow HackOn. Healthcare, owned end to end.*

</div>
