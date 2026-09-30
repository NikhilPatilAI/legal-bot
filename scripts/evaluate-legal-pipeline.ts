import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  RecordingAnswerVerifier,
  runPipelineEvaluation,
  type PipelineEvalRun,
} from '../src/rag/evaluation/pipeline-eval.js';
import { loadLegalEvalDataset } from '../src/rag/evaluation/legal-eval-dataset.js';
import {
  DeterministicExtractComposer,
  LegalRagService,
  type RagComposer,
  type RagRetriever,
} from '../src/rag/rag-service.js';
import { LegalSectionJsonRetriever } from '../src/rag/retrieval/legal-section-json-retriever.js';
import { indexBuiltAt, SECTIONS_RETRIEVED_AT } from '../src/rag/factory.js';
import { CorpusIndexRetriever } from '../src/rag/retrieval/corpus-index-retriever.js';
import { HybridRetriever } from '../src/rag/retrieval/hybrid-retriever.js';
import { ProvisionExpansionRetriever } from '../src/rag/retrieval/provision-expansion-retriever.js';
import { ProvisionGraph } from '../src/rag/retrieval/provision-graph.js';
import { HistoricalProvisionStore } from '../src/rag/temporal/historical-provision-store.js';
import { DeterministicClaimVerifier } from '../src/rag/verification/claim-verifier.js';

// End-to-end legal evaluation through LegalRagService.query. Unlike
// rag:evaluate-legal (retriever-only), every case runs the real scope checks,
// retrieval, composition, verification and abstention path. The composer never
// sees reference facts.
//
// The default composer is the local deterministic extract composer. It is NOT a
// language model; results with it measure the pipeline's retrieval, citation,
// verification and abstention behaviour, not generated-answer quality. A model
// composer is used only when --composer azure is passed explicitly with the
// Azure OpenAI environment configured; that call is billable.
//
// Usage:
//   pnpm eval                                   # Companies Act sections, dev split
//   pnpm eval -- --split test --out reports/test.json
//   pnpm eval -- --corpus-mode index --dataset data/eval/full-corpus.eval.json --split dev
//   pnpm eval -- --composer azure --repeats 3 --pause-ms 9000   # billable
//
// Options: [--split dev|test|heldout|all] [--repeats N] [--composer deterministic|azure]
//   [--verification deterministic|off] [--budget N] [--corpus path] [--index path]
//   [--dataset path] [--history path] [--out path] [--only label,...] [--pause-ms N]

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    split: { type: 'string', default: 'dev' },
    repeats: { type: 'string', default: '1' },
    composer: { type: 'string', default: 'deterministic' },
    verification: { type: 'string', default: 'deterministic' },
    budget: { type: 'string', default: '6' },
    corpus: {
      type: 'string',
      default: 'data/sections/companies-act-2013.sections.json',
    },
    dataset: { type: 'string', default: 'data/eval/companies-act-2013.eval.json' },
    history: { type: 'string', default: 'data/history/companies-act-2013.history.json' },
    // "sections": parsed Companies Act sections, flat vs connected retrieval.
    // "index": the SQLite FTS5 index built by `pnpm ingest`.
    'corpus-mode': { type: 'string', default: 'sections' },
    index: { type: 'string', default: 'data/index/legal-bot.sqlite' },
    // Build time for an index made by another tool (no index_metadata table).
    'index-built-at': { type: 'string' },
    // Index mode: also run BM25 + embedding hybrid retrieval (label "index-hybrid").
    hybrid: { type: 'boolean', default: false },
    out: { type: 'string' },
    // Comma-separated configuration labels to run (default: all).
    only: { type: 'string' },
    // Milliseconds to wait between cases (not counted in latency), to stay
    // within the model deployment's tokens-per-minute quota.
    'pause-ms': { type: 'string', default: '0' },
    // Retail prices in INR per 1M tokens, used only to report cost. Defaults:
    // Azure retail price list, gpt-5.6-luna GlobalStandard East US, checked
    // 2026-09-29 (input 19.1093, cached input 1.9109, output 114.6555).
    'price-input': { type: 'string', default: '19.1093' },
    'price-cached': { type: 'string', default: '1.9109' },
    'price-output': { type: 'string', default: '114.6555' },
  },
});

const corpusPath = resolve(process.cwd(), values.corpus);
const datasetPath = resolve(process.cwd(), values.dataset);
const historyPath = resolve(process.cwd(), values.history);
const repeats = positiveInteger(values.repeats, 'repeats');
const resultLimit = positiveInteger(values.budget, 'budget');
const splits = values.split === 'all' ? null : [values.split];
if (!['deterministic', 'azure'].includes(values.composer)) throw new Error('Unknown composer');
if (!['deterministic', 'off'].includes(values.verification))
  throw new Error('Unknown verification mode');
const retrievedAt = SECTIONS_RETRIEVED_AT;
const corpusMode = values['corpus-mode'];
if (!['sections', 'index'].includes(corpusMode)) throw new Error('Unknown corpus mode');
const indexPath = resolve(process.cwd(), values.index);

const dataset = await loadLegalEvalDataset(datasetPath);
const graph = await ProvisionGraph.fromFile(corpusPath);
const history = await HistoricalProvisionStore.fromFile(historyPath);
// Records provider failures (the service maps them to a generic 503) so a
// report can distinguish rate limits, timeouts and network errors.
const composerErrors: Array<{ question: string; error: string }> = [];
const composer = withErrorLog(await createComposer(values.composer));

// The index retriever is warmed first, as the server does at startup, so
// latency reflects a running service rather than one cold read.
const indexRetriever =
  corpusMode === 'index' ? new CorpusIndexRetriever(indexPath, builtAt()) : null;
const warmUpMs = (await indexRetriever?.warmUp()) ?? 0;
const configurations: Array<{ label: string; retriever: RagRetriever }> =
  corpusMode === 'index'
    ? [
        { label: 'index', retriever: indexRetriever! },
        ...(values.hybrid ? [{ label: 'index-hybrid', retriever: await hybridRetriever() }] : []),
      ]
    : [
        {
          label: 'flat',
          retriever: await LegalSectionJsonRetriever.open(corpusPath, retrievedAt),
        },
        {
          label: 'connected',
          retriever: new ProvisionExpansionRetriever(
            await LegalSectionJsonRetriever.open(corpusPath, retrievedAt),
            graph,
            retrievedAt,
          ),
        },
      ];

const only = values.only?.split(',').map((item) => item.trim());
const runs: PipelineEvalRun[] = [];
const usageByRun: Record<string, ReturnType<typeof usageDelta>> = {};
for (const configuration of configurations) {
  if (only && !only.includes(configuration.label)) continue;
  const before = snapshotUsage(composer);
  const recorder =
    values.verification === 'deterministic'
      ? new RecordingAnswerVerifier(new DeterministicClaimVerifier())
      : undefined;
  const service = new LegalRagService(
    configuration.retriever,
    composer,
    30_000,
    recorder,
    0.5,
    history,
  );
  runs.push(
    await runPipelineEvaluation(service, dataset, {
      label: configuration.label,
      resultLimit,
      repeats,
      ...(splits ? { splits } : {}),
      ...(recorder ? { recorder } : {}),
      pauseBetweenCasesMs: Number(values['pause-ms']),
    }),
  );
  usageByRun[configuration.label] = usageDelta(before, snapshotUsage(composer));
}

const report = {
  generatedAt: new Date().toISOString(),
  evidenceClass:
    composer.mode === 'deterministic_extract'
      ? `local end-to-end LegalRagService run over ${corpusMode === 'index' ? 'the SQLite corpus index' : 'parsed Companies Act sections'} with the deterministic extract composer (no language model); measures retrieval, citation, verification and abstention behaviour, not generated-answer quality; not Azure Search; not lawyer-reviewed`
      : `local end-to-end LegalRagService run with the Azure OpenAI composer (${process.env.AZURE_OPENAI_GENERATION_DEPLOYMENT ?? 'unknown deployment'}) over ${corpusMode === 'index' ? 'the SQLite corpus index' : 'parsed Companies Act sections'} (local retrieval, not Azure Search); not lawyer-reviewed`,
  codeRevision: gitRevision(),
  workingTreeDirty: gitDirty(),
  composer: composer.mode,
  verification: values.verification,
  resultLimit,
  repeats,
  indexWarmUpMs: Math.round(warmUpMs),
  splits: splits ?? ['all'],
  dataset: {
    path: relativePath(datasetPath),
    sha256: await sha256File(datasetPath),
    reviewStatus: dataset.reviewStatus,
  },
  corpus:
    corpusMode === 'index'
      ? { mode: 'index', path: relativePath(indexPath), builtAt: builtAt() }
      : { mode: 'sections', path: relativePath(corpusPath), sha256: await sha256File(corpusPath) },
  history: { path: relativePath(historyPath), sha256: await sha256File(historyPath) },
  modelUsage: composer.mode === 'azure_openai' ? usageByRun : null,
  composerErrors,
  runs,
};

const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (values.out) await writeFile(resolve(process.cwd(), values.out), serialized, 'utf8');
process.stdout.write(`${summaryTable(runs)}\n`);
if (composer.mode === 'azure_openai')
  for (const [label, usage] of Object.entries(usageByRun))
    process.stdout.write(
      `${label} model usage: ${usage.calls} calls, ${usage.promptTokens} input (${usage.cachedPromptTokens} cached), ${usage.completionTokens} output (${usage.reasoningTokens} reasoning) tokens, cost INR ${usage.costInr.toFixed(4)}\n`,
    );
if (!values.out) process.stdout.write(serialized);

function withErrorLog(inner: RagComposer): RagComposer {
  return Object.assign(Object.create(inner) as RagComposer, {
    mode: inner.mode,
    async compose(
      question: string,
      evidence: Parameters<RagComposer['compose']>[1],
      signal?: AbortSignal,
    ) {
      try {
        return await inner.compose(question, evidence, signal);
      } catch (error) {
        const detail = error as { name?: string; status?: number; code?: string; message?: string };
        composerErrors.push({
          question,
          error: `${detail.name ?? 'Error'} status=${detail.status ?? 'n/a'} code=${detail.code ?? 'n/a'} ${String(detail.message ?? '').slice(0, 200)}`,
        });
        throw error;
      }
    },
  });
}

interface UsageSnapshot {
  calls: number;
  promptTokens: number;
  cachedPromptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
}

function snapshotUsage(item: RagComposer): UsageSnapshot {
  const usage =
    (Object.getPrototypeOf(item) as RagComposer & { usage?: UsageSnapshot }).usage ??
    (item as RagComposer & { usage?: UsageSnapshot }).usage;
  return usage
    ? { ...usage }
    : { calls: 0, promptTokens: 0, cachedPromptTokens: 0, completionTokens: 0, reasoningTokens: 0 };
}

function usageDelta(before: UsageSnapshot, after: UsageSnapshot) {
  const delta = {
    calls: after.calls - before.calls,
    promptTokens: after.promptTokens - before.promptTokens,
    cachedPromptTokens: after.cachedPromptTokens - before.cachedPromptTokens,
    completionTokens: after.completionTokens - before.completionTokens,
    reasoningTokens: after.reasoningTokens - before.reasoningTokens,
  };
  // Reasoning tokens are billed as output and are included in completion tokens.
  const costInr =
    ((delta.promptTokens - delta.cachedPromptTokens) * Number(values['price-input']) +
      delta.cachedPromptTokens * Number(values['price-cached']) +
      delta.completionTokens * Number(values['price-output'])) /
    1_000_000;
  return { ...delta, costInr };
}

async function createComposer(mode: string): Promise<RagComposer> {
  if (mode === 'deterministic') return new DeterministicExtractComposer();
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.AZURE_OPENAI_GENERATION_DEPLOYMENT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION;
  if (!endpoint || !deployment || !apiVersion)
    throw new Error(
      'The azure composer requires AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_GENERATION_DEPLOYMENT and AZURE_OPENAI_API_VERSION',
    );
  const { createAzureGenerationClient, AzureOpenAiComposer } =
    await import('../src/rag/generation/azure-openai.js');
  return new AzureOpenAiComposer(
    createAzureGenerationClient({
      openAiEndpoint: endpoint,
      generationDeployment: deployment,
      openAiApiVersion: apiVersion,
    }),
    deployment,
  );
}

function summaryTable(items: readonly PipelineEvalRun[]): string {
  const keys = [
    'caseCount',
    'correctAbstentionRate',
    'missedAbstentionRate',
    'unnecessaryAbstentionRate',
    'withheldByVerifierRate',
    'citedProvisionRecall',
    'connectedProvisionRecall',
    'acceptableDocumentHitRate',
    'answerFactCoverage',
    'verifierUnsupportedClaimRate',
    'temporalVersionAccuracy',
    'errorRate',
    'latencyMsP50',
    'latencyMsP95',
  ] as const;
  const header = 'metric'.padEnd(30) + items.map((item) => item.label.padEnd(12)).join('');
  const rows = keys.map(
    (key) =>
      key.padEnd(30) +
      items
        .map((item) => {
          const value = item.metrics[key];
          return (value === null ? 'n/a' : Number(value).toFixed(3)).padEnd(12);
        })
        .join(''),
  );
  const failures = items.map(
    (item) => `${item.label} failures: ${JSON.stringify(item.metrics.failureCounts)}`,
  );
  return [header, ...rows, ...failures].join('\n');
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100)
    throw new Error(`--${name} must be an integer from 1 to 100`);
  return parsed;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function gitRevision(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function gitDirty(): boolean | null {
  try {
    return (
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim().length > 0
    );
  } catch {
    return null;
  }
}

function builtAt(): string {
  return values['index-built-at'] ?? indexBuiltAt(indexPath);
}

// Paths are recorded relative to the project so reports do not reveal local
// folder or user names; files outside the project are named only by file name.
function relativePath(path: string): string {
  const inside = relative(process.cwd(), path);
  return inside.startsWith('..') || isAbsolute(inside)
    ? `(outside project)/${path.split(/[\\/]/u).at(-1)}`
    : inside.replaceAll('\\', '/');
}

async function hybridRetriever(): Promise<RagRetriever> {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
  if (!endpoint || !deployment)
    throw new Error('--hybrid needs AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_EMBEDDING_DEPLOYMENT');
  const { createAzureEmbedder } = await import('../src/rag/generation/azure-openai.js');
  return new HybridRetriever(
    indexRetriever!,
    indexPath,
    createAzureEmbedder({
      openAiEndpoint: endpoint,
      embeddingDeployment: deployment,
      openAiApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2025-04-01-preview',
    }),
  );
}
