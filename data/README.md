# Catalog records and provenance

`demo-medicines.json` is a small hand-assembled demonstration catalog, created on 18 October 2026. It is not a comprehensive or clinically validated medicine database. The record's `demo` flag is applied by SQLite seeding, and the interface keeps the label visible.

The demo uses nine explicit product/form records: Dolo 650 mg tablet, Crocin Advance 500 mg tablet, paracetamol 500 mg tablet and 120 mg/5 ml suspension, cetirizine 10 mg tablet, omeprazole 20 mg capsule and tablet, amoxicillin 500 mg capsule, and Augmentin (amoxicillin 500 mg + clavulanic acid 125 mg) tablet. These identities are examples, not substitutions.

Ingredient summaries are short paraphrases of the linked NHS medicine pages. Crocin's manufacturer page supports its product identity; Micro Labs supports the Dolo brand. Some identity examples are adapted from the original repository's seed/matching fixtures. A generic ingredient reference does not verify every marketed product, brand package, or strength. Confirm the package label. The suspension record deliberately has no clinical summary to demonstrate missing information. `reviewedAt` is null throughout the demo because no clinical review date was established. The assembly date is not a review date.

Primary references linked inside records:

- [NHS paracetamol for adults](https://www.nhs.uk/medicines/paracetamol-for-adults/)
- [NHS paracetamol for children](https://www.nhs.uk/medicines/paracetamol-for-children/)
- [NHS cetirizine](https://www.nhs.uk/medicines/cetirizine/)
- [NHS omeprazole](https://www.nhs.uk/medicines/omeprazole/)
- [NHS amoxicillin](https://www.nhs.uk/medicines/amoxicillin/)
- [NHS co-amoxiclav](https://www.nhs.uk/medicines/co-amoxiclav/)
- [Haleon Crocin Advance](https://www.crocin.com/crocin-products-for-adult/crocin-advance-tablets/)
- [Micro Labs](https://www.microlabsltd.com/)

## Import format

Supply a JSON array of objects with these fields. Use the demo file as a structural example, not as a medical review process.

| Field         | Requirement                                                                              |
| ------------- | ---------------------------------------------------------------------------------------- |
| `id`          | Required unique lowercase letters, digits, hyphens; maximum 64 characters                |
| `name`        | Required brand or generic product name                                                   |
| `generic`     | Required full active ingredient identity; preserve combination ingredients               |
| `strength`    | String such as `500 mg` or `500 mg + 125 mg`, or null                                    |
| `form`        | Explicit formulation such as `tablet`, `capsule`, `suspension`, `tablet sr`, or null     |
| `aliases`     | Optional array of genuine name variants; not symptoms, categories, or alternate products |
| `description` | Optional source-backed description                                                       |
| `simple`      | Optional source-backed plain-language description                                        |
| `sideEffects` | Optional array of sourced statements                                                     |
| `precautions` | Optional array of sourced statements                                                     |
| `sources`     | Required nonempty array of `{ "label": "Source name", "url": "https://..." }`            |
| `reviewedAt`  | Optional real source/clinical review date, not an import timestamp                       |

Each strength/form combination needs a distinct ID. Do not place unrelated brands or single-ingredient and combination products in one record. Imported facts should be reviewed by a knowledgeable person; JSON validation cannot establish medical accuracy. Matching supports conservative English/Latin-script identities and does not convert equivalent units or interpret arbitrary formulations.

Place private or large JSON files in `data/imports/` (ignored by Git). SQLite, WAL files, caches, screenshots, and local runtime files also remain untracked. Imports replace the current catalog in a transaction; invalid input leaves it unchanged. Back up valuable catalogs before a valid replacement.
