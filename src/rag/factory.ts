import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { AppConfig } from '../config.js';
import {
  AzureHybridRagRetriever,
  AzureOpenAiComposer,
  createAzureGenerationClient,
  createAzureEmbedder,
  createAzureRagClients,
} from './generation/azure-openai.js';
import {
  DeterministicExtractComposer,
  LegalRagService,
  type RagComposer,
  type RagRetriever,
} from './rag-service.js';
import { CorpusIndexRetriever } from './retrieval/corpus-index-retriever.js';
import { HybridRetriever } from './retrieval/hybrid-retriever.js';
import { LegalSectionJsonRetriever } from './retrieval/legal-section-json-retriever.js';
import { ProvisionExpansionRetriever } from './retrieval/provision-expansion-retriever.js';
import { ProvisionGraph } from './retrieval/provision-graph.js';
import { HistoricalProvisionStore } from './temporal/historical-provision-store.js';
import { DeterministicClaimVerifier } from './verification/claim-verifier.js';

// When the bundled Companies Act section corpus was downloaded from its
// official source (see data/sections/SOURCE.md).
export const SECTIONS_RETRIEVED_AT = '2026-09-01T12:54:17.027Z';

/**
 * Wires the answer pipeline from configuration:
 *   retriever (+ connected-provision expansion) -> composer -> claim verifier,
 * with optional point-in-time history.
 */
export async function createRagService(config: AppConfig): Promise<LegalRagService> {
  const { rag } = config;
  const verifier =
    rag.verification === 'deterministic' ? new DeterministicClaimVerifier() : undefined;
  const history =
    rag.historyPath && existsSync(resolve(rag.historyPath))
      ? HistoricalProvisionStore.fromFileSync(resolve(rag.historyPath), {
          minimumDateEvidence: rag.historyMinimumDateEvidence,
        })
      : undefined;
  return new LegalRagService(
    await createRetriever(config),
    createComposer(config),
    rag.answerTimeoutMs,
    verifier,
    0.5,
    history,
    rag.confidenceThreshold,
  );
}

async function createRetriever(config: AppConfig): Promise<RagRetriever> {
  const { rag } = config;
  if (rag.retriever === 'sections') {
    const sectionsPath = resolve(rag.sectionsPath);
    // Definitions and cross-referenced sections are added within the same
    // evidence budget, so "what is a small company" also sees section 2(85).
    return new ProvisionExpansionRetriever(
      await LegalSectionJsonRetriever.open(sectionsPath, SECTIONS_RETRIEVED_AT),
      ProvisionGraph.fromFileSync(sectionsPath),
      SECTIONS_RETRIEVED_AT,
    );
  }
  if (rag.retriever === 'index') {
    const indexPath = resolve(rag.indexPath);
    if (!existsSync(indexPath))
      throw new Error(`Corpus index not found at ${indexPath}. Build it with: pnpm ingest`);
    const retriever = new CorpusIndexRetriever(indexPath, indexBuiltAt(indexPath));
    // Pre-read the index file so the first question is not slowed by a cold
    // disk read. Asynchronous: the server keeps answering meanwhile.
    void retriever.warmUp();
    if (!rag.hybrid) return retriever;
    return new HybridRetriever(
      retriever,
      indexPath,
      createAzureEmbedder({
        openAiEndpoint: rag.azure.openAiEndpoint!,
        embeddingDeployment: rag.azure.embeddingDeployment!,
        openAiApiVersion: rag.azure.openAiApiVersion,
      }),
    );
  }
  const azure = rag.azure;
  const clients = createAzureRagClients({
    searchEndpoint: azure.searchEndpoint!,
    searchIndexName: azure.searchIndexName!,
    openAiEndpoint: azure.openAiEndpoint!,
    embeddingDeployment: azure.embeddingDeployment!,
    generationDeployment: azure.generationDeployment!,
    openAiApiVersion: azure.openAiApiVersion,
  });
  return new AzureHybridRagRetriever(
    clients.search,
    clients.embeddings,
    azure.embeddingDeployment!,
  );
}

function createComposer(config: AppConfig): RagComposer {
  const { rag } = config;
  if (rag.composer !== 'azure_openai' && rag.retriever !== 'azure_search')
    return new DeterministicExtractComposer();
  return new AzureOpenAiComposer(
    createAzureGenerationClient({
      openAiEndpoint: rag.azure.openAiEndpoint!,
      generationDeployment: rag.azure.generationDeployment!,
      openAiApiVersion: rag.azure.openAiApiVersion,
      timeoutMs: rag.answerTimeoutMs,
    }),
    rag.azure.generationDeployment!,
  );
}

// The build time recorded by `pnpm ingest`, reported as the corpus date.
export function indexBuiltAt(indexPath: string): string {
  const database = new DatabaseSync(indexPath, { readOnly: true });
  try {
    const hasTable = database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'index_metadata'")
      .get();
    const row = hasTable
      ? (database.prepare("SELECT value FROM index_metadata WHERE key = 'built_at'").get() as
          { value: string } | undefined)
      : undefined;
    if (!row) throw new Error('The index has no build metadata; rebuild it with pnpm ingest');
    return row.value;
  } finally {
    database.close();
  }
}
