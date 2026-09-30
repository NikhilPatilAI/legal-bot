# Interview guide

A short script for explaining Legal Bot, followed by the questions interviewers usually ask. All numbers are in [EVALUATION.md](EVALUATION.md); quote them with their conditions.

## 30-second pitch

> "Legal Bot answers questions about Indian law from official texts. I built retrieval over 5,082 government PDFs with SQLite full-text search, and added what most RAG demos skip: a claim-level verifier that checks every sentence of the answer against the cited text (numbers, 'shall' vs 'shall not', section citations, quotes) and withholds the answer if anything is contradicted. On laws it was never tuned on, it lets through 0.8% of falsified claims and rejects 1.7% of true ones. Each answer also gets a confidence score, and below a threshold I tuned on a dev set it shows the official sources instead of answering. On a new randomly sampled test set that I froze before running, it was fully correct on 89% of the answers it gave, and it declined every out-of-scope question."

## 2-minute walkthrough

1. **Problem.** LLMs are fluent but unreliable on law: wrong section numbers, dropped provisos, outdated text. In this domain a wrong answer is worse than no answer.
2. **Ingestion.** PDFs are hashed (content-addressed ids), extracted page by page with pdf.js, chunked with page numbers, and indexed in SQLite FTS5. A manifest records the official source of every file; unofficial sources are refused by default.
3. **Retrieval.** BM25 plus legal-domain rules: detect the legal area (and decline if none), route to a named Act, look up definitions, keep only the newest consolidation of an Act, and rank pages whose section headings match the question.
4. **Answering.** An Azure OpenAI composer writes from the evidence only (or a free extract composer quotes it). The prompt treats evidence as untrusted data and requires exact quotations.
5. **Verification.** The answer is split into claims, and each is matched to the best evidence span and checked for numbers, negation, modality, citations and quotations. Contradictions withhold the answer.
6. **Selective answering.** Confidence = share of claims supported × how closely they match the evidence, halved if the answer hedges. Below 0.70 the user gets sources instead of an answer. The threshold was picked on the dev set's risk-coverage curve.
7. **Evaluation.** Dev/test/held-out splits by topic family, blind first runs, recorded cost. I fixed the verifier on dev/test only, then measured on a new frozen held-out set.
8. **Engineering.** Fastify API with streaming progress, API keys, rate limits, CSP, no content in logs, Docker, and CI that builds a real index from PDFs and runs the evaluations.

## Likely questions

**Why BM25 and not embeddings?**
Legal questions hinge on exact tokens: "section 135", "designated partner", "thirty days". BM25 matches them exactly, runs in milliseconds with no GPU or vector store, and is easy to explain when a result is wrong. The code also includes an Azure AI Search hybrid (BM25 plus vector) retriever. The next step I'd measure is hybrid retrieval on the same held-out sets, because paraphrased questions are where BM25 misses.

**How does the verifier work, and why not use an LLM as the judge?**
Each claim is matched to its best-supporting sentence in the cited evidence by content-word overlap, then checked with targeted rules: numbers (normalised so "₹100 crore" equals "one hundred crore rupees" and "1st April" equals "1 April"), negation compared clause by clause, "shall/may", section citations bound to retrieved sections, and verbatim quotations. It's deterministic, free, takes milliseconds and can be unit-tested. An LLM judge costs money per answer, varies between runs, and can be fooled the same way the writer is. I measured the verifier instead of assuming it works.

**How do you know the numbers aren't cherry-picked?**
Test questions come from a seeded random sample of provisions, with fixed exclusion rules written in advance. The test set is frozen by hash before it runs, and all tuning uses a second random sample (the dev set). Because I wrote the test questions myself, I also removed any router vocabulary that appears only in the test questions. The random-sample numbers are lower than on hand-picked questions, and that is the point.

**How did you measure the verifier?**
I took real statute sentences and produced false versions: flipped negations, changed numbers, "shall" to "may", wrong or invented section numbers, "without exception" against a proviso. The true sentences (verbatim, correctly cited, paraphrased) are the positives. Then I looked at why the falsified claims got through. Most were sentences copied word for word except for "not" or "shall/may", or a correct sentence attributed to the neighbouring section. I added two general rules for those, which took false acceptance on the Companies Act from 4.9% to 0.6%. Because I had tuned on that Act, I froze a new benchmark from four other Acts before running it: 0.8% false acceptance and 1.7% false rejection, blind. When I relaxed a rule to stop blocking good answers, I only kept the change if false acceptance stayed flat.

**What was the hardest bug?**
The verifier withheld correct model answers. I logged every rejected claim across 3× runs and grouped them. Statute sentences mix clauses ("shall file …, and if he does not …"), so a correct positive claim looked negated. Numeric caps written as prohibitions ("no person shall … more than twenty") didn't match "up to 20". "1st April" wasn't read as "1 April". Fixing those general causes brought withheld answers on a new held-out set from 17 % to 5.6 %, and the falsified-claim benchmark didn't move.

**How do you avoid fooling yourself with evaluation?**
Frozen splits by topic family (a test enforces that no family crosses splits), expected facts checked verbatim against the source, the accepted documents computed mechanically, and look labels: a held-out set is blind only on its first run. I report the blind score (11/36 fully correct, with 12 runs lost to rate limits) next to the second look (21/36).

**How do you handle amendments?**
Consolidated Acts are grouped into version families by title and date, and only the newest is retrieved. For point-in-time questions, a history file stores dated versions of a provision with the Gazette source for each commencement date. The service answers from the version in force on that date, or declines if the date can't be proven. The default policy accepts only primary-source dates.

**Prompt injection?**
Evidence is sent as a JSON data packet, and the system prompt says instructions inside it must be ignored. The UI renders answers with `textContent` (no HTML), and citations only link to `https://` URLs. Even an injected answer must still pass the verifier against the evidence.

**How did you choose the confidence threshold, and did it hold up?**
I ran the dev set once with selection off and recorded every answer's confidence, then drew precision against coverage offline. The rule, fixed in advance, was the lowest threshold with at least 95% precision on dev. That was 0.70, which gave 100% on dev, but that was only 15 answers. On the blind test set it gave 89% (41/46), up from 83% with selection off. So the effect was real, and the dev estimate was optimistic, as a small dev set usually is. The cost is coverage: it answered 49% of in-scope questions. For the rest it returned sources, and 13 of those 17 source lists contained the right document.

**Why not 100%?**
Four of the five misses had every fact right but cited another consolidation of the same law, or a newer amendment, that my automatic scorer didn't group with the sampled version. One was genuinely wrong. I report the strict 89% as the headline and the audited 96% separately as a second look. I don't merge the two.

**What would you do next?**
Hybrid retrieval (BM25 plus embeddings) with a re-ranker, measured on the held-out sets; OCR for the scanned PDFs; answer caching; and lawyer review of the evaluation sets so the facts become legally verified, not just text-verified.

## Numbers to remember

| Claim                                               | Value                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Corpus used in development                          | 5,082 official PDFs (private); 4 bundled for reproducibility            |
| **Verifier on laws it was never tuned on (blind)**  | **0.8%** false acceptance (6/706) · **1.7%** false rejection (6/362)    |
| Verifier on the Companies Act (tuning data)         | 4.9% → 0.6% false acceptance; 0.8% → 0.4% false rejection               |
| **Precision, new blind random set (94 questions)**  | **89%** (41/46, CI 77–95%); 96% after auditing the misses (second look) |
| Selective answering (threshold 0.70, chosen on dev) | precision 83% → 89%; coverage 49%; 0 timeouts (was 13 of 89)            |
| Previous blind set, earlier system                  | 86% (38/44)                                                             |
| Out-of-scope refusals                               | 15/15 on the random set; 100% on every multi-Act set                    |
| No-model retrieval, 89 random questions             | right document 61% → 69% after dev-set tuning                           |
| Hybrid BM25 + embeddings                            | measured: no gain on the sample corpus, so off by default               |
| Cost per question with Azure OpenAI                 | ₹0.04–0.11                                                              |
| Tests                                               | 150 automated tests; CI builds an index from real PDFs                  |

## If asked "what is the overall accuracy?"

> "It's a precision-versus-coverage choice, and I measured both. On a new blind set of 94 random questions, it answered 46 and 41 of those were fully correct: 89% precision. That's 44% of all questions. If I turn selective answering off, the same run answers 63 and gets 52 right, which is 83% precision and 55% overall. For legal questions I chose precision, and the unanswered ones still get the official sources. What limits coverage now is the legal-area router and the verifier, not timeouts or wrong answers, so that's what I'd improve next."
