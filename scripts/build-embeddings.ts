import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { createAzureEmbedder } from '../src/rag/generation/azure-openai.js';
import { encodeVector } from '../src/rag/retrieval/hybrid-retriever.js';

// Adds embeddings for the hybrid retriever to an index built by `pnpm ingest`.
// Incremental: chunks that already have a vector are skipped. Billable.
//
//   AZURE_OPENAI_ENDPOINT=... AZURE_OPENAI_EMBEDDING_DEPLOYMENT=text-embedding-3-large \
//   pnpm exec tsx scripts/build-embeddings.ts -- --index data/index/legal-bot.sqlite
//
// Cost at list price: about USD 0.13 per million tokens for text-embedding-3-large.

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    index: { type: 'string', default: 'data/index/legal-bot.sqlite' },
    batch: { type: 'string', default: '16' },
    'pause-ms': { type: 'string', default: '0' },
    // Characters of chunk text embedded (the model accepts about 8,000 tokens).
    'max-chars': { type: 'string', default: '6000' },
  },
});
const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
const deployment = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;
if (!endpoint || !deployment)
  throw new Error('Set AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_EMBEDDING_DEPLOYMENT');

const embed = createAzureEmbedder({
  openAiEndpoint: endpoint,
  embeddingDeployment: deployment,
  openAiApiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2025-04-01-preview',
});
const database = new DatabaseSync(values.index);
database.exec(
  'CREATE TABLE IF NOT EXISTS chunk_embeddings (chunk_id TEXT PRIMARY KEY, vector BLOB NOT NULL)',
);
const pending = database
  .prepare(
    `SELECT chunk_id, title, text FROM corpus_chunks
     WHERE chunk_id NOT IN (SELECT chunk_id FROM chunk_embeddings) ORDER BY chunk_id`,
  )
  .all() as Array<{ chunk_id: string; title: string; text: string }>;
const insert = database.prepare('INSERT INTO chunk_embeddings (chunk_id, vector) VALUES (?, ?)');
const batch = Number(values.batch);
const maxChars = Number(values['max-chars']);
let characters = 0;
for (let start = 0; start < pending.length; start += batch) {
  const rows = pending.slice(start, start + batch);
  // The title gives each page its instrument context.
  const texts = rows.map((row) => `${row.title}\n${row.text}`.slice(0, maxChars));
  characters += texts.reduce((sum, text) => sum + text.length, 0);
  // Embedding is idempotent, so a rate-limited batch is retried after a pause
  // (bounded; other errors stop the run).
  let vectors: Float32Array[] | null = null;
  for (let attempt = 1; !vectors; attempt += 1) {
    try {
      vectors = await embed(texts);
    } catch (error) {
      if ((error as { status?: number }).status !== 429 || attempt >= 6) throw error;
      console.log(`rate limited; waiting 45 s (attempt ${attempt})`);
      await new Promise((done) => setTimeout(done, 45_000));
    }
  }
  database.exec('BEGIN');
  rows.forEach((row, index) => insert.run(row.chunk_id, encodeVector(vectors[index]!)));
  database.exec('COMMIT');
  console.log(`${Math.min(start + batch, pending.length)}/${pending.length}`);
  if (Number(values['pause-ms']) > 0)
    await new Promise((done) => setTimeout(done, Number(values['pause-ms'])));
}
database.exec('PRAGMA journal_mode = DELETE');
database.close();
// Roughly 4 characters per token for English legal text.
const tokens = Math.round(characters / 4);
console.log(
  `Embedded ${pending.length} chunks, about ${tokens} tokens (about USD ${((tokens / 1_000_000) * 0.13).toFixed(4)} at list price).`,
);
