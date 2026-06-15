# `data/` — what lives here

| Path | What it is | Committed? | Regenerate with |
|---|---|---|---|
| `medicine-sources/*.json` | Curated India medicine seeds (brands, salts, aliases). Source for `npm run import-medicines` **and** the in-memory Mongo-outage fallback (`src/medicine/fallbackCatalog.js`). | ✅ Yes | hand-curated |
| `medicineAliases.json`, `medicineSynonyms.json` | Alias/synonym dictionaries used by query expansion + the phonetic matcher. | ✅ Yes | hand-curated |
| `chroma/` | Local JSON vector store (RAG embeddings) + ingestion progress. **Large, machine-local.** | ❌ Gitignored | `npm run ingest` |
| `test-chroma/` | Throwaway vector store for tests. | ❌ Gitignored | tests create it |

**Source of truth** for medicine identity is **MongoDB** (`MedicineKnowledge`),
populated via `npm run import-medicines`. The JSON seeds bootstrap Mongo and
back the fallback catalog; the vector store is derived (regenerable) data.
