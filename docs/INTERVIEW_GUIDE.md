# Interview guide

A short script for explaining Legal Bot, followed by the questions interviewers usually ask. All numbers are in [EVALUATION.md](EVALUATION.md); quote them with their conditions.

## 30-second pitch

> "Legal Bot answers questions about Indian law from official texts. I built the retrieval over 5,082 government PDFs with SQLite full-text search, then added what most RAG demos skip: a claim-level verifier that checks every sentence of the answer against the cited text (numbers, 'shall' vs 'shall not', section citations, quotes) and withholds the answer if anything is contradicted. I measured it with frozen held-out sets and a 1,500-item perturbation benchmark: 4.9 % of falsified claims get through, 0.8 % of true ones are rejected, and every out-of-scope question in the multi-Act sets is declined."

## 2-minute walkthrough

1. **Problem.** LLMs are fluent but unreliable on law: wrong section numbers, dropped provisos, outdated text. In this domain a wrong answer is worse than no answer.
2. **Ingestion.** PDFs are hashed (content-addressed ids), extracted page by page with pdf.js, chunked with page numbers, and indexed in SQLite FTS5. A manifest records the official source of every file; unofficial sources are refused by default.
3. **Retrieval.** BM25 plus legal-domain rules: detect the legal area (and decline if none), route to a named Act, look up definitions, keep only the newest consolidation of an Act, and rank pages whose section headings match the question.
4. **Answering.** An Azure OpenAI composer writes from the evidence only (or a free extract composer quotes it). The prompt treats evidence as untrusted data and requires exact quotations.
5. **Verification.** The answer is split into claims, and each is matched to the best evidence span and checked for numbers, negation, modality, citations and quotations. Contradictions withhold the answer.
6. **Evaluation.** Dev/test/held-out splits by topic family, blind first runs, recorded cost. I fixed the verifier on dev/test only, then measured on a new frozen held-out set.
7. **Engineering.** Fastify API with streaming progress, API keys, rate limits, CSP, no content in logs, Docker, and CI that builds a real index from PDFs and runs the evaluations.

## Likely questions

**Why BM25 and not embeddings?**
Legal questions hinge on exact tokens: "section 135", "designated partner", "thirty days". BM25 matches them exactly, runs in milliseconds with no GPU or vector store, and is easy to explain when a result is wrong. The code also includes an Azure AI Search hybrid (BM25 plus vector) retriever. The next step I'd measure is hybrid retrieval on the same held-out sets, because paraphrased questions are where BM25 misses.

**How does the verifier work, and why not use an LLM as the judge?**
Each claim is matched to its best-supporting sentence in the cited evidence by content-word overlap, then checked with targeted rules: numbers (normalised so "₹100 crore" equals "one hundred crore rupees" and "1st April" equals "1 April"), negation compared clause by clause, "shall/may", section citations bound to retrieved sections, and verbatim quotations. It's deterministic, free, takes milliseconds and can be unit-tested. An LLM judge costs money per answer, varies between runs, and can be fooled the same way the writer is. I measured the verifier instead of assuming it works.

**How did you measure the verifier?**
I took real statute sentences and produced false versions: flipped negations, changed numbers, "shall" to "may", wrong or invented section numbers, "without exception" against a proviso. The true sentences (verbatim, correctly cited, paraphrased) are the positives. On sections not used for tuning, 4.9 % of false claims were accepted (95 % CI 3.7–6.4 %) and 0.8 % of true claims were rejected. When I relaxed a rule to stop blocking good answers, I only kept the change if false acceptance stayed flat. One version let two falsified claims through, and I narrowed it.

**What was the hardest bug?**
The verifier withheld correct model answers. I logged every rejected claim across 3× runs and grouped them. Statute sentences mix clauses ("shall file …, and if he does not …"), so a correct positive claim looked negated. Numeric caps written as prohibitions ("no person shall … more than twenty") didn't match "up to 20". "1st April" wasn't read as "1 April". Fixing those general causes brought withheld answers on a new held-out set from 17 % to 5.6 %, and the falsified-claim benchmark didn't move.

**How do you avoid fooling yourself with evaluation?**
Frozen splits by topic family (a test enforces that no family crosses splits), expected facts checked verbatim against the source, the accepted documents computed mechanically, and look labels: a held-out set is blind only on its first run. I report the blind score (11/36 fully correct, with 12 runs lost to rate limits) next to the second look (21/36).

**How do you handle amendments?**
Consolidated Acts are grouped into version families by title and date, and only the newest is retrieved. For point-in-time questions, a history file stores dated versions of a provision with the Gazette source for each commencement date. The service answers from the version in force on that date, or declines if the date can't be proven. The default policy accepts only primary-source dates.

**Prompt injection?**
Evidence is sent as a JSON data packet, and the system prompt says instructions inside it must be ignored. The UI renders answers with `textContent` (no HTML), and citations only link to `https://` URLs. Even an injected answer must still pass the verifier against the evidence.

**What would you do next?**
Hybrid retrieval (BM25 plus embeddings) with a re-ranker, measured on the held-out sets; OCR for the scanned PDFs; answer caching; and lawyer review of the evaluation sets so the facts become legally verified, not just text-verified.

## Numbers to remember

| Claim                                        | Value                                                        |
| -------------------------------------------- | ------------------------------------------------------------ |
| Corpus used in development                   | 5,082 official PDFs (private); 4 bundled for reproducibility |
| Verifier false acceptance / false rejection  | 4.9 % / 0.8 % (held-out sections, n = 1,022 / 488)           |
| Out-of-scope refusals (multi-Act sets)       | 100 %                                                        |
| Right document cited, 5,082 corpus, no model | 89 % of 28 questions                                         |
| Withheld Azure answers, held-out set 2       | 17 % → 5.6 % after verifier fixes (second look)              |
| Cost per question with Azure OpenAI          | ₹0.04–0.11                                                   |
| Tests                                        | 133 automated tests; CI builds an index from real PDFs       |
