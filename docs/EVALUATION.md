# Evaluation

The goal is to measure the whole answer pipeline honestly, not a demo. Every number below comes from a file in [`docs/results/`](results) and every free run can be reproduced with one command.

## Method

**End-to-end.** Each case goes through the real `LegalRagService.query`: scope checks, retrieval, composition, verification and abstention. The composer never sees the expected facts.

**Datasets** (`data/eval/`). Questions and expected facts were drafted with an AI assistant and each fact was **checked verbatim** against the source text. For the multi-Act sets, the accepted documents were computed mechanically: every version of the named instrument whose text contains the facts. No case is lawyer-reviewed; facts describe the indexed text, not verified current law.

| File                              | Cases                                                                             | Corpus                 |
| --------------------------------- | --------------------------------------------------------------------------------- | ---------------------- |
| `companies-act-2013.eval.json`    | 32 (direct lookups, multi-provision, exceptions, non-existent sections, temporal) | Companies Act sections |
| `full-corpus.eval.json`           | 24 (dev 6 · test 9 · held-out 9)                                                  | 5,082-PDF corpus       |
| `full-corpus-heldout-2.eval.json` | 15 (held-out)                                                                     | 5,082-PDF corpus       |
| `sample-corpus.eval.json`         | 25, derived from the two above                                                    | the 4 bundled Acts     |

**Splits and leakage.** Cases are grouped into topic families, and a family belongs to exactly one split (enforced by a test). Tuning happens on dev and test; held-out sets are frozen before their first run.

**Look labels.** A held-out result is only "blind" on its first run. Any result obtained after changes informed by that set's failures is labelled a _second look_.

**Scoring.** _Right document_: an accepted document is cited. _Facts_: the expected fact appears verbatim, or at least 80 % of its content words match with every number exact. _Fully correct_: both. _Withheld_: the verifier blocked the draft.

## Results

### Claim verifier: perturbation benchmark

`pnpm eval:verifier` → [`claim-verifier-benchmark.json`](results/claim-verifier-benchmark.json). Real statute sentences are perturbed in ways that make them false (negation, changed numbers, modality flips, wrong or fabricated section citations, denied exceptions); verbatim, correctly cited and paraphrased sentences are the positives. Sections used to design the verifier (dev) are excluded from the test partition.

| Partition                | False acceptance                               | False rejection                 |
| ------------------------ | ---------------------------------------------- | ------------------------------- |
| Test (held-out sections) | **4.9 %** (50/1,022; 95 % Wilson CI 3.7–6.4 %) | **0.8 %** (4/488; CI 0.3–2.1 %) |
| Dev                      | 3.6 % (1/28)                                   | 0 % (0/13)                      |

The test partition has been measured repeatedly during development, so it is a regression benchmark rather than a blind score. Each verifier change was kept only if false acceptance did not rise.

### Companies Act: connected provisions and history (no model)

`pnpm eval -- --split all` → [`companies-act-sections.json`](results/companies-act-sections.json), 32 cases.

| Metric                     | Flat retrieval | + connected provisions |
| -------------------------- | -------------- | ---------------------- |
| Connected-provision recall | 0.00           | **1.00**               |
| Cited-provision recall     | 0.864          | 0.886                  |
| Temporal version accuracy  | 1.00           | 1.00                   |
| Correct abstention         | 8/10           | 8/10                   |
| Expected facts present     | 0.73           | 0.73                   |

The evaluation loads the history with the default policy of the store (`secondary_corroborated`); the server defaults to `primary_source_verified` and declines dates that only secondary sources confirm.

### 5,082-PDF corpus, no model

Run against the author's private index of 5,082 official PDFs (not distributed; see [DATA.md](DATA.md)) with the extract composer. Before and after adding heading ranking to general search:

| Set                                  | Right document  | Facts           | Withheld       | Refusals |
| ------------------------------------ | --------------- | --------------- | -------------- | -------- |
| Set 1 (16 answerable) before → after | 81 % → **88 %** | 41 % → **50 %** | 19 % → **6 %** | 8/8      |
| Set 2 (12 answerable) before → after | 75 % → **92 %** | 33 % → 33 %     | 17 % → **0 %** | 3/3      |

Files: [`full-index-set1.json`](results/full-index-set1.json), [`full-index-set2.json`](results/full-index-set2.json) and the `-before-heading-ranking` versions. These sets had been used during development (the second set's cases were read before this change), so this is a second-look comparison.

### Sample corpus, no model (reproducible by anyone)

`pnpm ingest && pnpm eval -- --corpus-mode index --dataset data/eval/sample-corpus.eval.json --split all` → [`sample-index.json`](results/sample-index.json).

| Refusals  | Right document | Facts | Withheld | Median latency |
| --------- | -------------- | ----- | -------- | -------------- |
| **11/11** | 12/14 (86 %)   | 36 %  | 14 %     | 26 ms          |

The heading-ranking change cost one fact on this set (the LLP annual-return answer cites the right Act but a different page).

### Azure OpenAI answers (5,082-PDF corpus)

Measured on 2026-09-29 with deployment `gpt-5.6-luna`, 3 repeats per question, **before** the heading-ranking change. Files `azure-*.json`.

| Set                           | Look                                  | Withheld    | Fully correct | Refusals | Cost  |
| ----------------------------- | ------------------------------------- | ----------- | ------------- | -------- | ----- |
| Dev (3 answerable ×3)         | tuning, before → after verifier fixes | 22 % → 11 % | 7/9 → 8/9     | 9/9      | ₹1.29 |
| Test (6 answerable ×3)        | tuning, before → after                | 33 % → 28 % | 8/18 → 8/18   | 9/9      | ₹2.15 |
| Held-out 2 (12 answerable ×3) | 1st, blind                            | 17 %        | 11/36         | 9/9      | ₹1.65 |
| Held-out 2                    | 2nd look, after fixes                 | **5.6 %**   | **21/36**     | 9/9      | ₹1.13 |

In the blind run, 12 of 45 results were Azure `429` rate-limit errors (30K tokens/minute quota); `--pause-ms 9000` reduced this to 1. Cost is about **₹0.04–0.11 per question** at list price (input ₹19.11, cached input ₹1.91, output ₹114.66 per million tokens).

## What the numbers say

- **Refusals are reliable:** every out-of-scope question on the multi-Act sets was declined, before any model call.
- **The verifier is precise:** about 1 in 20 deliberately falsified claims gets through, and fewer than 1 in 100 true claims is rejected.
- **Retrieval is the main limit:** most remaining misses are questions whose answering page is not in the top five (for example SEBI's UPSI definition, LODR regulation 17(2)).
- **Samples are small:** 12–16 answerable questions per set; treat percentages as indicative.

## Reproduce

```bash
pnpm install && pnpm ingest
pnpm eval:verifier -- --out reports/verifier.json
pnpm eval -- --split all --out reports/sections.json
pnpm eval -- --corpus-mode index --dataset data/eval/sample-corpus.eval.json --split all
# Azure (billable): add --composer azure --repeats 3 --pause-ms 9000 with AZURE_OPENAI_* set
```
