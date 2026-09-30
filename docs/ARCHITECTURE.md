# Architecture

Legal Bot has two halves: an **offline ingestion pipeline** that turns PDFs into a search index, and an **online answer pipeline** behind an HTTP API. Everything runs in one Node.js process; the only external service is optional (Azure OpenAI for written answers).

## 1. Ingestion (`pnpm ingest`, `src/rag/ingestion/`)

| Step         | Module                     | What it does                                                                                                                                            | Why                                                                                  |
| ------------ | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Manifest     | `manifest.ts`              | Validates `manifest.json` (zod): title, authority, legal area, dates, official URLs.                                                                    | Provenance is required: a document without a recorded source is never indexed.       |
| Source check | `manifest.ts`              | The source must be HTTPS on an allow-list of official hosts (indiacode.gov.in, cbic-gst.gov.in, ipindia.gov.in …), unless `--allow-unofficial`.         | Keeps unofficial copies out by default.                                              |
| Identity     | `ingest.ts`                | SHA-256 of the PDF bytes; the document id is `legal_` + first 24 hex characters.                                                                        | Content-addressed: re-running skips known files, and ids are stable across machines. |
| Extraction   | `pdfjs-local-extractor.ts` | pdf.js text extraction per page, with size, page, text and time limits.                                                                                 | Local and deterministic; no cloud OCR. Pages without text are marked `ocr_required`. |
| Chunking     | `page-chunker.ts`          | Page-aware chunks (up to 4,000 characters, 300 overlap, split at paragraph or sentence boundaries). Each chunk keeps page number, source hash and URLs. | Citations can point to an exact page of an exact file.                               |
| Index        | `ingest.ts`                | SQLite tables for documents and chunks, plus an FTS5 virtual table (BM25). One transaction per document.                                                | No search server to run; one file to ship; a crash never leaves half a document.     |

The Companies Act, 2013 is also bundled as a **section-level corpus** (`data/sections/`), parsed into sections, sub-sections and cross-references by `legal-section-chunker.ts`.

## 2. Answering (`POST /v1/ask`, `src/rag/rag-service.ts`)

```
question
  → scope checks          foreign law, unsupported areas, non-existent sections → decline
  → retrieve              up to 5 evidence passages
  → (sections mode)       add connected provisions: definitions and cross-referenced sections
  → (as-of date)          swap in the historical text in force on that date, or decline
  → compose               extract composer (no model) or Azure OpenAI
  → verify                claim verifier; withhold if any claim is contradicted
  → select                confidence below threshold: return sources instead of the answer
  → answer + citations + warnings
```

### Retrieval (`src/rag/retrieval/corpus-index-retriever.ts`)

1. **Out-of-area guard:** `legal-category.ts` maps the question to a legal area (GST, trade marks, LLP, SEBI, insolvency, FEMA, income tax, companies, case law). No area means no evidence, so the service declines without searching.
2. **Text-quality filter:** skips pages that are mostly Devanagari (for English questions), legacy-font garble ("Hkkx …"), or near-empty.
3. **Definition lookup:** "what does _X_ mean" questions first fetch pages that print `"X" means`.
4. **Named-instrument routing:** if the question names an Act, Rules or Regulations that exists in the index as its own document, that document fills up to half the evidence budget.
5. **BM25 search** (`fts-query.ts` builds a safe, quoted FTS5 query), filtered by legal area.
6. **Version families:** titles such as "CGST Act, 2017 as amended up to 01.01.2022" are parsed into a family and a date; only the newest version of each instrument is kept.
7. **Heading ranking:** pages whose section headings share words with the question ("7. Designated partners.—") come first; table-of-contents pages come last.

**Optional hybrid search** (`hybrid-retriever.ts`, `HYBRID_RETRIEVAL=true`): BM25 results and embedding (text-embedding-3-large) nearest neighbours are merged with Reciprocal Rank Fusion. The out-of-area guard still applies first. Measured on the sample corpus it did not beat BM25 (see EVALUATION.md), so it is off by default.

`legal-section-json-retriever.ts` does section-aware scoring for the Companies Act corpus, and `provision-expansion-retriever.ts` adds definitions (section 2) and cross-referenced sections within the same evidence budget.

### Composition

- `DeterministicExtractComposer` (in `rag-service.ts`): picks the evidence sentences that best match the question (IDF-weighted). Free and deterministic; used for tests, CI and the no-model benchmarks.
- `AzureOpenAiComposer` (`generation/azure-openai.ts`): sends the question and the evidence as an untrusted JSON packet with a system prompt that forbids outside facts, requires exact quotations, and defines an abstain marker. Entra ID authentication, a timeout equal to the answer deadline (60 s by default), no automatic retries, token usage recorded.

### Verification (`src/rag/verification/claim-verifier.ts`)

The answer is split into claims (sentences and list items, with the lead-in of each list). Each claim is matched to the best-supporting span of the cited evidence, then checked for:

| Check             | Example it catches                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Citation binding  | "Under section 999 …" when section 999 was never retrieved; "Under section 5, <text of section 4>" when another retrieved section states the claim word for word |
| Quotations        | quoted words that do not appear verbatim in the evidence                                                                                                         |
| Numbers and dates | "within 60 days" when the source says thirty; "1st April" and "1 April" compare equal                                                                            |
| Polarity          | "shall not" vs "shall", compared clause by clause; numeric caps ("no person shall … more than twenty") equal "up to 20"                                          |
| Modality          | "may" vs "shall"                                                                                                                                                 |
| Verbatim edits    | a sentence copied word for word except for its negation or modal words ("shall have effect" for "shall not have effect")                                         |
| Denied exceptions | "without exception" when the source has a proviso                                                                                                                |

Policy (`rag-service.ts`): any contradicted claim, fabricated citation or fabricated quotation, or fewer than half the claims supported, and the answer is **withheld**. A warning is added when the cited text has provisos the answer does not mention.

Selective answering (`answerConfidence` in `rag-service.ts`): a verified answer scores `supported-claim share × mean match score of supported claims`, halved if it hedges ("the evidence does not state ..."). Below `CONFIDENCE_THRESHOLD` (0.70 with the Azure composer, chosen on the dev set) the response keeps the citations but replaces the answer with a sources-only message. Every response carries `confidence`.

### Point-in-time answers (`src/rag/temporal/historical-provision-store.ts`)

`data/history/companies-act-2013.history.json` records dated versions of provisions (for example section 135(5), before and after the 2021 amendment), each with the source that proves its commencement date. For an `asOfDate`, the store returns the version in force (half-open intervals), or declines when the date is before commencement, in the future, or not covered. `HISTORY_MIN_DATE_EVIDENCE` controls whether secondary-corroborated dates may be used.

## 3. HTTP layer (`src/app.ts`, `src/server.ts`, `src/config.ts`)

- Fastify with JSON-schema validation of the request body (TypeBox).
- `Accept: application/x-ndjson` streams progress events ("retrieving sources", "drafting answer"), then the result.
- API keys (bearer, SHA-256 digests compared with `timingSafeEqual`), rate limits, Helmet with CSP, CORS allow-list, request ids, problem+json errors.
- Logs never contain questions, answers or headers (`observability/http-logging.ts`).
- `server.ts` validates configuration, builds the pipeline, and closes gracefully on SIGTERM.

## 4. Evaluation (`src/rag/evaluation/`, `scripts/`)

- `pipeline-eval.ts` runs each case through the real `LegalRagService.query` (scope checks, retrieval, composition, verification) and scores it: cited documents, expected facts (verbatim or near-verbatim with exact numbers), abstention, withheld answers, latency, model tokens and cost.
- `legal-eval-dataset.ts` enforces the dataset schema: frozen dev/test/held-out splits by topic family (no leakage), and provenance on every case.
- `scripts/evaluate-claim-verifier.ts` perturbs real statute sentences (negation, numbers, modality, wrong section, fabricated section, denied exception) and measures false acceptance and false rejection with Wilson confidence intervals.

## Design decisions

| Decision                  | Alternative         | Why                                                                                                                                                                         |
| ------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite FTS5 (BM25)        | Vector database     | Legal questions are keyword-heavy (section numbers, defined terms); BM25 is exact, explainable and free to run. Azure AI Search hybrid retrieval is available as an option. |
| Deterministic verifier    | LLM-as-judge        | Reproducible, free, fast (milliseconds) and testable; measured with a perturbation benchmark.                                                                               |
| Withhold on contradiction | Show with a warning | In legal information, a confident wrong answer is worse than no answer.                                                                                                     |
| Page-level citations      | Chunk ids           | Users can open the official PDF at the cited page.                                                                                                                          |
| Content-addressed ids     | Sequential ids      | Re-ingestion is idempotent and evaluation sets stay valid across machines.                                                                                                  |
