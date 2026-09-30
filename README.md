# Legal Bot

**Retrieval-augmented question answering over Indian statutes. Every answer is built only from official legal texts, cites the exact document and page, and is checked claim by claim before it is shown. If the check fails, the answer is withheld instead of guessed.**

![CI](https://github.com/NikhilPatilAI/legal-bot/actions/workflows/ci.yml/badge.svg)
TypeScript · Node 22 · Fastify · SQLite FTS5 (BM25) · pdf.js · Azure OpenAI · Docker · Vitest

---

## Why this project

General chatbots answer legal questions fluently, but they invent section numbers, change "shall" to "may", and quote law that was amended years ago. Legal Bot is built around the opposite rule: **no evidence, no answer**.

- **Grounded:** retrieval over a corpus of official PDFs (India Code, CBIC, IP India, MCA, SEBI, IBBI, RBI …). The model only sees retrieved passages.
- **Cited:** every answer lists its sources with title, page and the official URL.
- **Selective:** each verified answer gets a confidence score; below a threshold tuned on the dev set, the user gets the official sources instead of a possibly wrong answer.
- **Verified:** a deterministic claim verifier splits the drafted answer into claims and checks each one against the cited text: numbers, negation, "shall/may", section citations and quotations. Contradicted answers are withheld.
- **Honest about scope:** out-of-area questions (passports, criminal law, foreign law) are declined before any search or model call.
- **Measured:** random-sample test sets frozen before they are run, a blind verifier benchmark on laws it was never tuned on, and recorded model cost.

## What it looks like

```text
$ pnpm ask "How many designated partners must a limited liability partnership have?"

## Summary
- Designated partners.— (1) Every limited liability partnership shall have at least two
  designated partners who are individuals and at least one of them shall be a resident in India:
- Provided that in case of a limited liability partnership in which all the partners are
  bodies corporate ... [trimmed]

  [1] The Limited Liability Partnership Act, 2008, Page 25  https://indiacode.gov.in/...
  [2] The Limited Liability Partnership Act, 2008, Page 7   https://indiacode.gov.in/...
  ...
  note: Answer verification (deterministic, lexical screen, not legal review):
        3 of 3 statements were matched to retrieved sources.
```

Output of the free extract composer (no language model), which quotes the retrieved text; with `COMPOSER=azure_openai` the same evidence is written up as a short answer and verified the same way.

```text
$ pnpm ask "How do I get a passport?"
[declined] The available official evidence is insufficient to answer this question.
```

## Architecture

```mermaid
flowchart LR
  subgraph Ingestion [pnpm ingest]
    M[manifest.json<br/>official URLs] --> H[SHA-256<br/>content-addressed id]
    P[PDFs] --> H --> X[pdf.js text<br/>extraction] --> C[page chunks] --> I[(SQLite FTS5<br/>BM25 index)]
  end
  subgraph Answering [POST /v1/ask]
    Q[question] --> S{scope guard<br/>legal area?}
    S -- no --> D[decline]
    S -- yes --> R[retrieve<br/>BM25 + instrument routing<br/>+ heading ranking + newest version]
    I --> R
    R --> E[connected provisions<br/>definitions, cross-references<br/>(Companies Act sections)]
    E --> G[compose<br/>extract or Azure OpenAI]
    G --> V{claim verifier<br/>numbers · polarity · modality<br/>citations · quotations}
    V -- contradicted --> W[withhold]
    V -- supported --> K{confidence<br/>≥ threshold?}
    K -- no --> O[sources only]
    K -- yes --> A[answer + citations + checks]
  end
```

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Results

Every number comes from a file in [`docs/results/`](docs/results); the method is in [docs/EVALUATION.md](docs/EVALUATION.md). The main test sets are **seeded random samples** of provisions from the 5,082-PDF corpus, frozen before they were run. Expected facts were checked verbatim against the source; they are not lawyer-reviewed.

| What was measured                                                                                       | Result                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claim verifier on laws it was never tuned on** (blind, frozen: LLP Act, Trade Marks Act, FEMA, CGST)  | **0.8%** of falsified claims accepted (6/706, 95% CI 0.4–1.8%) · **1.7%** of true claims rejected (6/362)                                                                                      |
| Claim verifier on the Companies Act (tuning data)                                                       | false acceptance **4.9% → 0.6%**, false rejection **0.8% → 0.4%** (n = 1,022 / 488)                                                                                                            |
| **New blind random set: 94 questions, final system with Azure OpenAI** (frozen before the run, one run) | **89% precision** (41 of 46 answers fully correct, CI 77–95%; 96% after an audit of the misses). Low-confidence answers are replaced by their sources. 0 timeouts; 15/15 out-of-scope refusals |
| Confidence threshold chosen on the dev set only (risk-coverage curve)                                   | 0.70: precision 83% → 89% on the blind set, at 49% coverage                                                                                                                                    |
| Previous blind set, 89 questions, earlier system                                                        | 86% precision (38/44), 13 answers lost to a 30 s timeout; no-model retrieval: right document 61% → 69%                                                                                         |
| Out-of-scope questions declined (foreign law, other fields, non-existent sections)                      | **15/15** on both random sets, 100% on every multi-Act set; Companies Act set 8/10                                                                                                             |
| Connected-provision recall, Companies Act (flat → graph expansion)                                      | **0 → 100%**                                                                                                                                                                                   |
| Hybrid BM25 + embeddings (RRF) vs BM25 on the sample corpus                                             | no gain (13/14 vs 14/14 right document, 10× latency): measured and kept off by default                                                                                                         |
| Cost with Azure OpenAI                                                                                  | about **₹0.04–0.11 per question** at list price                                                                                                                                                |

Limitations are part of the result. Samples are small (94 and 89 answerable questions), and answering only when confident trades coverage for precision: the final system answers about half of in-scope questions and returns sources for the rest. Random provisions include circulars and forms, so the scores are lower than on hand-picked questions. Most unanswered questions are declined by the legal-area router or held back by the verifier; widening the router (tuned on dev, measured on a new frozen set) is the next step.

## Quick start

Requirements: Node.js 22.13+ and pnpm (`corepack enable`).

```bash
pnpm install
pnpm ingest          # builds data/index/legal-bot.sqlite from the 4 bundled official Acts (~3 s)
pnpm dev             # http://127.0.0.1:3000
```

Ask from the command line:

```bash
pnpm ask "What is the maximum rate of central tax under the CGST Act?"
pnpm ask "What does section 188 cover?" --retriever sections
pnpm ask "Under Section 135, what must the Board do if the company fails to spend its CSR amount?" \
  --retriever sections --as-of 2021-06-01
```

Or with Docker:

```bash
docker compose up --build   # http://localhost:3000
```

### Use your own PDFs

Put PDFs in a folder with a `manifest.json` listing each file's title, legal area and official source URL, then:

```bash
pnpm ingest -- --manifest path/to/manifest.json --index data/index/legal-bot.sqlite
```

The project was developed against a private corpus of 5,082 official PDFs; see [docs/DATA.md](docs/DATA.md).

### Written answers with Azure OpenAI

```bash
az login
COMPOSER=azure_openai AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/ \
AZURE_OPENAI_GENERATION_DEPLOYMENT=<deployment> pnpm dev
```

Authentication uses Microsoft Entra ID (`DefaultAzureCredential`); no API key is stored.

## API

| Method | Path         | Purpose                                                                                                                                                          |
| ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`    | Liveness                                                                                                                                                         |
| `GET`  | `/ready`     | Readiness (corpus loaded)                                                                                                                                        |
| `GET`  | `/v1/status` | Corpus coverage and limitations                                                                                                                                  |
| `POST` | `/v1/ask`    | `{ "question": "...", "asOfDate?": "YYYY-MM-DD", "legalCategory?": "gst" }` → answer, citations, checks. Send `Accept: application/x-ndjson` to stream progress. |
| `GET`  | `/`          | Web UI                                                                                                                                                           |

```bash
curl -s localhost:3000/v1/ask -H 'content-type: application/json' \
  -d '{"question":"For how long is a trade mark registration valid?"}'
```

Errors are RFC 9457 problem documents (`application/problem+json`) with a request id.

## Production readiness

- **Configuration** validated at start-up with zod; the process refuses to start when misconfigured (for example production without API keys).
- **Security:** bearer API keys compared in constant time on their SHA-256 digests; per-route rate limits; Helmet headers with a strict content security policy; CORS allow-list; 16 KB body limit; the UI renders answers with `textContent` only.
- **Privacy:** request logs contain method, status and request id, never questions, answers or headers.
- **Reliability:** answer deadline with cancellation when the client disconnects; `/health` and `/ready` probes; graceful shutdown on SIGTERM; model calls are not retried blindly.
- **Supply chain:** pinned dependencies and lockfile; non-root, read-only container with a health check.
- **CI:** typecheck, lint, format, 150 tests, index build from real PDFs, both free evaluations, and a Docker smoke test that asks a real question.

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Project structure

```text
src/
  server.ts, app.ts, config.ts       HTTP API, configuration
  rag/rag-service.ts                 the answer pipeline (scope → retrieve → compose → verify)
  rag/retrieval/                     index retriever, Companies Act section retriever, provision graph
  rag/verification/claim-verifier.ts claim-level answer verification
  rag/temporal/                      point-in-time answers from amendment history
  rag/generation/azure-openai.ts     Azure OpenAI composer and Azure AI Search retriever
  rag/ingestion/                     manifest, PDF extraction, chunking, index writer
  rag/evaluation/                    evaluation harness and dataset schema
scripts/   ingest, ask, evaluate pipeline, evaluate verifier
web/       browser UI (no build step)
data/      sample PDFs, Companies Act sections, amendment history, evaluation sets
docs/      architecture, evaluation, data, deployment, interview guide, results
```

## Disclaimer

Legal Bot provides legal information, not legal advice. Indexed texts carry `legalStatus: unknown`: they are official publications but are not verified as the current consolidated law.

## License

Code: [MIT](LICENSE). Bundled statutes are official Government of India publications; see [docs/DATA.md](docs/DATA.md).
