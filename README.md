# MediFast AI

Finding the right medicine in India is harder than it should be. You walk into a pharmacy with a parchi, the chemist shrugs, you call the next shop, then the next, and you still aren't sure if what you're buying is the right brand or the right salt. Most of us end up Googling on the way and trusting whichever blog ranks first that day.

MediFast AI is a Telegram bot that turns that messy hunt into a quick conversation. You type a medicine, a symptom, or even a typo in Hinglish, and the bot pulls together what it knows from a verified Indian medicine catalog, a small RAG library of trusted notes, and a careful AI layer on top. Then it shows you nearby pharmacies, the kind where you can tap to call or open Google Maps. It tries to feel less like a search engine and more like asking a friend who happens to be a chemist.

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Database-47A248?logo=mongodb&logoColor=white)
![Groq](https://img.shields.io/badge/Groq-LLM%20Provider-F55036)
![Chroma](https://img.shields.io/badge/Chroma-Vector%20DB-5B5BD6)
![Telegram](https://img.shields.io/badge/Telegram-Bot-26A5E4?logo=telegram&logoColor=white)

> A small but important note: MediFast helps you understand and discover medicines. It is not a doctor and never tries to act like one.

## What it can actually do for you

You can type a brand like `Dolo 650`, a generic like `Paracetamol`, a salt like `Pantoprazole`, a typo like `Prrgabakin`, or a Hinglish phrase like `bukhar ki tablet` or `gas ki dawa`. The bot will figure out which medicine you mean, give you a short conversational answer about what it is for, the common side effects to watch for, and a few alternatives. If your message is a follow-up like _"can my father take it"_ or _"what does it do"_, it remembers what you were just talking about and answers in context.

If you share your location once, the bot turns into something closer to Zomato for medicines. It pulls live pharmacies near you from OpenStreetMap, lays them out by distance, shows whether they are open, and gives you tap-to-call and tap-to-navigate buttons. No fake numbers, no random listings.

The bot also has a soft fallback that came in this last release. When you ask about a medicine that is not yet in our verified catalog, it does not give up. It quietly asks the AI for a brief, sanitized summary, marks it clearly as compiled from general knowledge, and tells you to confirm with a pharmacist before using it. That answer is also logged in the background so an admin can promote good ones into the verified catalog over time. The bot literally gets smarter as people use it.

## How it stays safe

This part matters, especially for medicine. The AI never invents dosages, frequencies, durations, prescription advice, or stock claims. There is a system prompt that forbids it, and there is a second sanitizer in code that strips any `500 mg twice daily` or `take for 5 days` line if a model ever slips. The verified catalog stays the source of truth. The AI is allowed to write the friendly explanation around it, not the medical facts inside it.

## Getting it running on your machine

You need Node.js 18 or newer, a local MongoDB, a Telegram bot token from BotFather, and a Groq API key. With those four things, the rest is three commands.

```bash
git clone https://github.com/Ruchin-Audichya/MediFastRX-Bot.git
cd MediFastRX-Bot
npm install
```

Copy the example environment file and fill in the four values that matter — your Telegram token, your Mongo URI, your Groq key, and the model name. Everything else has sensible defaults.

```bash
cp .env.example .env
# on Windows PowerShell, use:  Copy-Item .env.example .env
```

Open `.env` and set at least these:

```env
TELEGRAM_BOT_TOKEN=your_botfather_token
MONGODB_URI=mongodb://localhost:27017/medifast
GROQ_API_KEY=your_groq_key
GROQ_MODEL=meta-llama/llama-4-scout-17b-16e-instruct
ENABLE_LLM_SYNTHESIS=true
LLM_PROVIDER=groq
```

Make sure MongoDB is running locally (`mongod`, or your service manager). Then start the bot:

```bash
npm start
```

You should see three lines in the console — Mongo connecting, the Express server coming up on port 3001, and the bot saying it is in polling mode. Open Telegram, search for your bot's username, send `/start`, and you are in.

If you want to develop on it with auto-reload, use `npm run dev` instead.

## Try it like a user would

Once the bot is running, this is the easiest tour:

```
You: Pregabalin
Bot: 💊 Pregabalin
     A short conversational answer with what it is used for and one safety note,
     followed by primary use, side effects and alternatives, and a row of buttons.

You: side effects
Bot: continues from Pregabalin without you having to repeat the name.

You: can my father take it
Bot: same context, scoped to that medicine.

You: bukhar ki tablet
Bot: switches to a symptom-style suggestion path.

You: Dolo 650 near me
Bot: asks for your location once. Tap "Share Location" and it returns a clean list
     of nearby pharmacies with distance, open status, and call/navigate buttons.
```

If you type a brand it does not know yet, it will quietly fetch a short AI-written summary, mark it as general-knowledge, and remember it for follow-ups. That is the new fallback in action.

## What is in the box

```
src/
  ai/                deterministic entity extraction, routing, safety guard
  bot/               Telegram handlers and commands
  cache/             per-user response cache + medicine cache
  context/           the canonical MedicineContext that flows end-to-end
  diagnostics/       production health and runtime tracing
  events/            event bus and analytics listeners
  integrations/      MediAtlas client (off by default until keys are configured)
  medicine/          catalog, importer, normalizer, graph, LLM augment service
  memory/            semantic memory and summarization
  models/            MongoDB schemas
  orchestrator/      planner, tool executor, evidence collector, integrity guard
  pharmacy/          nearby search, ranking, OSM hydration
  providers/         Groq, local Llama, deterministic fallback
  rag/               loaders, chunking, embeddings, retrieval, reranker
  services/          search, conversation context, RAG service, intent engine
  utils/             formatters and helpers

knowledge-base/      curated RAG documents (medicines, side effects, symptoms)
data/medicine-sources Indian medicine catalog drops
scripts/             import, diagnostics, runtime trace, health checks
tests/               exploration, preservation, unit, integration, property-based
docs/                architecture and integration notes
```

## Useful commands

Day to day, you will mostly need three:

```bash
npm start                  # run the bot
npm run dev                # run with auto-reload during development
npm test                   # run the full test suite (270+ tests)
```

When something feels off, the diagnostics scripts are the fastest way to understand why:

```bash
npm run diagnose-medicines     # is the catalog loaded and resolving correctly?
npm run diagnose-rag           # is the vector store happy?
npm run diagnose-llm           # is Groq reachable, what is the latency?
npm run diagnose-pharmacies    # do nearby queries return real results?
npm run diagnose-memory        # is family memory persisting?
npm run production-health      # one-shot health rollup
npm run runtime -- "Dolo near me"   # trace a single message through every layer
```

For data setup:

```bash
npm run import-medicines       # import the medicine catalog from data/medicine-sources
npm run import-pharmacies      # import seed pharmacies (OSM hydration runs live too)
npm run ingest                 # re-ingest the RAG knowledge base
npm run activate-data          # activate the catalog for the in-memory matcher
```

## How a message flows

When you send a message, the bot quietly walks through these stages.

1. The text is normalized and an intent is extracted. The bot decides if you said a medicine, a symptom, mentioned a family member, or asked something else.
2. The router decides which tools to call — medicine knowledge, RAG, semantic memory, nearby pharmacies, family profile.
3. Independent tools run in parallel. There is a small per-user cache so repeated lookups about the same medicine reuse the previous results within a short window.
4. An evidence collector packs everything into a single shape. An integrity guard then validates that every chunk actually belongs to the medicine you asked about, so RAG cannot leak Gabapentin into a Pregabalin answer.
5. Groq writes a short, friendly narrative on top of that evidence, scoped only to the active medicine. If Groq fails, times out, or is disabled, the bot falls back to a deterministic card that still carries every layer through.
6. The formatter renders a clean Telegram card and sends it. While the heavy work is happening, you see a quick "Looking up X…" message that gets edited in place when the real card arrives. That is what makes it feel near-instant.

## What changed in the last release

The bot used to feel like a templated search engine that occasionally lost track of what you were just talking about. After a few days of testing it, three things were broken — the bot mixed up medicines mid-conversation, it gave up on anything not in the catalog, and the message style felt robotic and slow.

This release rebuilt the core. There is now a single canonical `MedicineContext` that flows through every layer end-to-end, so follow-ups stay on the right medicine. RAG retrieval is medicine-aware and an integrity guard drops chunks that do not belong. The card got cleaner — no more confidence percentages or aliases blockquotes — and the AI line goes on top so it reads like a friend explaining, not a database dump. Replies feel much faster because of two-stage send and a per-user cache. And when you ask about a brand the catalog does not know yet, the bot fills in a sanitized AI summary, marks it honestly, and logs it for admin promotion later. The safety floor — never invent dosage, prescription advice, or stock — is enforced both in the system prompt and in a code-level sanitizer.

## Roadmap

- Pharmacy live stock checks via partner integrations or MediAtlas going GA.
- WhatsApp adapter that mirrors the Telegram experience.
- Voice notes — "Dolo near me" spoken into Telegram.
- A small admin dashboard for catalog health, top searches, and promoting AI-augmented answers into the verified catalog.
- Open-source LLM deployment path so private inference becomes cheap.

## Built by

Ruchin Audichya, as an India-first healthcare assistant MVP.
