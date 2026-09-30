# Evaluation

The goal is to measure the whole answer pipeline honestly, not a demo. Every number below comes from a file in [`docs/results/`](results), and every free run can be reproduced with one command.

## Protocol

**End-to-end.** Each case runs through the real `LegalRagService.query`: scope checks, retrieval, composition, verification and abstention. The composer never sees the expected facts.

**Random sampling, not hand-picking.** The main sets are built from a **seeded random sample of provisions** in the 5,082-PDF corpus (`scripts/sample-provisions.ts`): up to 12 provisions per legal area (8 areas) from primary instruments. Sentences are excluded only by fixed rules written before the questions:

| Rule | Excluded when the sampled sentence …                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------ |
| E1   | is an amendment instruction (substituted, inserted, omitted, rescinded) or an amendment's commencement |
| E2   | is cut by footnote text or garbled                                                                     |
| E3   | cannot stand alone as a question (table or form fragment, "abovementioned")                            |
| E4   | duplicates a provision already selected                                                                |

A question is written for each provision, and its expected facts must occur **verbatim** in the sampled page (`scripts/build-heldout-3.ts` fails otherwise). The accepted documents are computed mechanically: every version of the same instrument containing the facts.

**Development vs frozen test.**

- `full-corpus-dev-3.eval.json` (seed 7; 31 answerable + 10 refusals) is used for all tuning, including the confidence threshold.
- `full-corpus-heldout-3.eval.json` (seed 20260929; 89 answerable + 15 refusals) was **frozen before any run** (sha256 `ba414588…`, [`heldout-3-freeze.json`](results/heldout-3-freeze.json)). It is run only for a baseline and for the final system, and only its aggregate numbers were read in between.
- `full-corpus-heldout-4.eval.json` (seed 20260930; 94 answerable + 15 refusals) was sampled, written and **frozen** (sha256 `eb48f568…`, [`heldout-4-freeze.json`](results/heldout-4-freeze.json)) after the timeout fix and before selective answering was tuned. The system has been run on it exactly once. It uses the first 18 eligible provisions per area (an earlier draw of 12 per area left too few after exclusions and was discarded unrun). Provisions already in dev-3 or held-out-3 were excluded.
- Provisions identical to held-out items were removed from dev.

**Author caveat.** The author wrote the held-out questions. To keep that knowledge out of the system, vocabulary added to the legal-area router was limited to terms from the development sets and general statute or regulator names. Terms that appear only in test questions were deliberately removed.

**Look labels.** A result is _blind_ only on its first run on a frozen set. Any later run is a _second look_.

**Scoring.**

- _Right document:_ an accepted document is cited.
- _Facts:_ the expected fact appears verbatim, or at least 80% of its content words match with every number exact.
- _Fully correct:_ both of the above.
- _Withheld:_ the verifier blocked the draft.
- _Refusal correct:_ an out-of-scope question (foreign law, other fields, non-existent sections) was declined.

No case is lawyer-reviewed; the facts describe the indexed text, not verified current law.

## 1. Claim verifier

`pnpm eval:verifier -- --partitions dev,test,unseen`. Real statute sentences are perturbed into false claims:

- negation flipped;
- a number changed;
- "shall" changed to "may";
- a wrong or invented section cited;
- "without exception" added against a proviso.

Verbatim sentences, correctly cited sentences and hand-written paraphrases are the true claims.

### Blind: laws the verifier was never tuned on (headline)

Sections of the LLP Act, Trade Marks Act, FEMA and CGST Act (`data/eval/unseen-laws.sections.json`, built by `scripts/build-unseen-sections.ts`) plus 24 hand-written paraphrases. The items were frozen by hash before the verifier changes and scored once ([`verifier-unseen-freeze.json`](results/verifier-unseen-freeze.json); the report's item hash matches).

| Measure                                                                   | Result                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------ |
| False acceptance                                                          | **0.8%** (6 of 706 falsified claims; 95% Wilson CI 0.4–1.8%) |
| False rejection                                                           | **1.7%** (6 of 362 true claims; CI 0.8–3.6%)                 |
| Negation, modality, invented-section and denied-exception claims accepted | **0 of 512**                                                 |
| Hand-written paraphrases accepted                                         | 21 of 24 (the verifier is strictest on loose rewording)      |

A second look after later, unrelated fixes gave identical numbers.

### Companies Act (the data the verifier was tuned on)

|                   | False acceptance   | False rejection  |
| ----------------- | ------------------ | ---------------- |
| Before this round | 4.9% (50/1,022)    | 0.8% (4/488)     |
| After             | **0.6%** (6/1,022) | **0.4%** (2/488) |

Files: [`claim-verifier-benchmark.json`](results/claim-verifier-benchmark.json), [`claim-verifier-benchmark-before-fixes.json`](results/claim-verifier-benchmark-before-fixes.json).

The rules added in this round, each with a regression test:

- **Verbatim edit:** a claim that copies the source except for its negation or modal words is a contradiction.
- **Wrong citation:** the claim cites one section while another retrieved section states it almost word for word.
- **Invented section numbers** are read even when they have four digits.
- **Instrument dates** are accepted from the passage header or title.
- **Quotations** may omit amendment insertions but may not add words.

## 2. Selective answering on a new blind test set (headline)

Two changes, both motivated by the held-out-3 result below:

- **Timeouts.** The answer deadline and the model call now share one 60-second budget (it was 30 s). Held-out-3 had lost 13 of 89 answers to the old deadline.
- **Confidence-based selective answering.** Each verified answer gets a confidence score:
  `supported-claim share × mean evidence-match score of the supported claims`, halved when the answer hedges ("the evidence does not state …"). Below a threshold, the service returns the most relevant official sources instead of the answer. The score is deterministic, and every factor is visible in the verification report.

**Threshold, chosen on dev-3 only.** Dev-3 was run once with selection off, and the risk-coverage curve was drawn offline (`scripts/risk-coverage.ts`, [`dev-3-azure-confidence.json`](results/dev-3-azure-confidence.json)). The rule was: the lowest threshold with at least 95% precision on dev. That gave **0.70** (dev: 15 of 15 shown answers correct; 83% precision with selection off). Twenty-three dev answers are a small sample, so a lower held-out score was expected.

**Held-out-4, blind, one run** ([`heldout-4-final-azure.json`](results/heldout-4-final-azure.json), 94 answerable + 15 refusals, ₹7.57):

| Measure                                                    | Result                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Precision when answering** (automatic, strict)           | **89%**: 41 of 46 answers fully correct (95% Wilson CI 77–95%)                                               |
| Coverage                                                   | 46 of 94 answered (49%). 17 returned sources only (low confidence), 10 withheld by the verifier, 21 declined |
| Sources-only replies                                       | 13 of 17 listed an accepted document for the question                                                        |
| Timeouts                                                   | **0** (held-out-3: 13). Latency over all 109 cases: p50 4.3 s, p95 7.2 s, max 34 s                           |
| Out-of-scope refusals                                      | **15/15**                                                                                                    |
| Same run, if the threshold were 0 (replayed from the run)  | 52 of 63 fully correct (83% precision), 52/94 overall                                                        |
| Precision at other thresholds (same run, not used to tune) | 0.85 → 94% (32 answers); 0.90 → 96% (26); 0.95 → 100% (12)                                                   |

**Error audit (second look, by the author).** In 4 of the 5 answers scored wrong, every expected fact is present:

- 3 cite a different consolidation of the same law (CGST Rules "as amended up to 01.01.2022", CGST Act "as amended up to 01.01.2022", and the CGST Rules that absorbed the 2017 return rules). The mechanical version-family rule did not group these titles with the sampled one.
- 1 quotes the newest amendment of the Voluntary Liquidation Regulations (eight years for electronic copies, three for physical), whose wording differs from the older sampled version.
- 1 is wrong: it states the right period but cites a different IBBI guideline.

Counting the three same-law consolidations as correct gives **44 of 46 (96%, CI 85–99%)**. That figure is a second look and is reported beside the strict blind score, not instead of it.

**By kind of document** (title rule: _Rules/Regulations_ in the title; else _Act_ or _Code_; else circular, guidance or form):

| Held-out-4            | Questions | Answered | Fully correct   |
| --------------------- | --------- | -------- | --------------- |
| Acts and Codes        | 11        | 6        | 5               |
| Rules and Regulations | 68        | 37       | 33              |
| Circulars, guidance   | 15        | 3        | 3               |
| **Held-out-3 (old)**  |           |          |                 |
| Acts and Codes        | 10        | 6        | 6               |
| Rules and Regulations | 60        | 33       | 28 (9 timeouts) |
| Circulars, guidance   | 19        | 5        | 4 (4 timeouts)  |

**What limits coverage now.** The remaining losses are declines (21), withholds (10) and low-confidence suppressions (17), not timeouts or wrong answers. Circulars are rarely answered because their questions often do not name a legal area the router recognises. The next step is a wider legal-area router tuned on dev, measured on a new frozen sample.

## 3. Random-sample questions on the 5,082-PDF corpus (earlier system)

Retrieval improvements, all tuned on dev-3 only:

- legal-area vocabulary taken from the dev sets;
- standard abbreviations expanded (NCLT, CIRP, LODR, PIT, FEMA);
- `nclt` moved from case law to company law.

| Set                                    | System              | Right document | Facts     | Fully correct              | Refusals  |
| -------------------------------------- | ------------------- | -------------- | --------- | -------------------------- | --------- |
| Held-out-3, **blind baseline**         | BM25, no model      | 61%            | 46%       | 36/89 (40%)                | 15/15     |
| Held-out-3, **final**                  | BM25, no model      | **69%**        | **52%**   | **41/89 (46%)**            | **15/15** |
| Held-out-3, **final, blind** (one run) | BM25 + Azure OpenAI | 45%            | 48%       | **38/89 (43%)**            | **15/15** |
| Dev-3 (tuning)                         | BM25, no model      | 68% → 81%      | 48% → 58% | 13/31 → 16/31              | 10/10     |
| Dev-3 (tuning)                         | BM25 + Azure OpenAI | —              | —         | 17/31 and 19/31 (two runs) | 10/10     |

Files: [`heldout-3-baseline-bm25-extract.json`](results/heldout-3-baseline-bm25-extract.json), [`heldout-3-final-bm25-extract.json`](results/heldout-3-final-bm25-extract.json), [`heldout-3-final-azure.json`](results/heldout-3-final-azure.json), [`dev-3-final-bm25-extract.json`](results/dev-3-final-bm25-extract.json).

**Reading the blind Azure result.** The Azure run is _below_ the no-model run overall. The reason is coverage, not accuracy:

- **Timeouts:** 13 of 89 answers hit the service's 30-second deadline (measured latencies 30.0–65.4 s) and returned errors.
- **Declines and withholds:** 22 answerable questions were declined (mostly the out-of-area router, as without a model), and 10 answers were withheld by the verifier.

On the 76 questions that did not time out, Azure was fully correct on **38** versus **32** for the extract composer. When Legal Bot with Azure gave an answer, it was fully correct **38 of 44 times (86% precision)**, against 41 of 68 (60%) without a model; otherwise it declined instead of guessing. Cost: ₹5.87 for the run, about ₹0.10 per answered question.

The timeouts were then fixed and selective answering was added; both were measured on a new frozen sample (section 2). The declines remain.

These random-sample numbers are lower than the earlier hand-picked sets (88–92% right document), and that is expected. A random sample includes circulars, forms and rules as well as well-known sections of major Acts, so it measures the whole corpus rather than the easy middle of it. Remaining failures:

- the no-model extract composer picks the wrong sentence even when the document is right;
- the router declines questions whose legal area it does not recognise;
- the answering page is not in the top five.

## 4. Hybrid retrieval (a negative result)

`src/rag/retrieval/hybrid-retriever.ts` merges BM25 with text-embedding-3-large nearest neighbours (Reciprocal Rank Fusion). Measured on the 4-Act sample corpus ([`sample-index-bm25-vs-hybrid.json`](results/sample-index-bm25-vs-hybrid.json)):

|        | Right document | Fully correct | Median latency |
| ------ | -------------- | ------------- | -------------- |
| BM25   | **14/14**      | **7/14**      | **31 ms**      |
| Hybrid | 13/14          | 6/14          | 326 ms         |

With 4 documents, BM25 already finds the right one every time, so semantic search adds latency but no accuracy. Hybrid retrieval is therefore off by default (`HYBRID_RETRIEVAL=true` enables it). Testing it where it could help, on the full corpus, means embedding 92,658 chunks (about 42 million tokens: about ₹470 and about 23 hours at the current 30K tokens-per-minute quota); that has not been done.

## 5. Earlier sets (hand-written questions)

| Set                                                                            | Result                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Companies Act sections, 32 cases ([file](results/companies-act-sections.json)) | connected-provision recall 0 → **1.0** with graph expansion; temporal version accuracy 1.0 (with secondary-corroborated dates allowed; the server defaults to primary-source dates only); refusals 8/10 |
| Full-corpus set 1, 16 answerable ([file](results/full-index-set1.json))        | right document 88%, refusals 8/8 (no model)                                                                                                                                                             |
| Full-corpus set 2, 12 answerable ([file](results/full-index-set2.json))        | right document 92%, refusals 3/3 (no model)                                                                                                                                                             |
| Sample corpus, 14 answerable ([file](results/sample-index.json))               | right document 14/14, refusals 11/11 (no model)                                                                                                                                                         |
| Azure runs from 2026-09-29 (`azure-*.json`)                                    | second held-out set: withheld 17% → 5.6% after verifier fixes (second look), 21/36 fully correct; earlier retrieval code                                                                                |

## Cost

- **Azure OpenAI answers:** about ₹0.04–0.11 per question at list price (input ₹19.11, cached input ₹1.91, output ₹114.66 per million tokens). Recorded per run in each report's `modelUsage`.
- **Embeddings for the 4-Act sample corpus:** about USD 0.03.

## Reproduce

```bash
pnpm install && pnpm ingest
pnpm eval:verifier -- --partitions dev,test,unseen
pnpm eval -- --split all
pnpm eval -- --corpus-mode index --dataset data/eval/sample-corpus.eval.json --split all
```

Risk-coverage curve from any report run with `--min-confidence 0`:

```bash
pnpm exec tsx scripts/risk-coverage.ts -- --report docs/results/dev-3-azure-confidence.json
```

The dev-3 and held-out runs need the full 5,082-PDF index (`--index <path> --index-built-at <iso>`); Azure runs add `--composer azure` with `AZURE_OPENAI_*` set.
