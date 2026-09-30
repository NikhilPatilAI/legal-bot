import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, describe, expect, it } from 'vitest';

import type { RagEvidence, RagQueryInput, RagRetriever } from '../../src/rag/rag-service.js';
import {
  HybridRetriever,
  cosine,
  encodeVector,
  type Embedder,
} from '../../src/rag/retrieval/hybrid-retriever.js';

// Synthetic engineering fixture: three pages, each with a hand-made 3-d
// "embedding", and a fake embedder that maps questions to directions.
const directory = mkdtempSync(join(tmpdir(), 'legal-bot-hybrid-'));
const databasePath = join(directory, 'index.sqlite');
{
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE corpus_chunks (chunk_id TEXT PRIMARY KEY, document_id TEXT, title TEXT, authority TEXT,
      legal_category TEXT, page_start INTEGER, page_end INTEGER, text TEXT, effective_date TEXT,
      final_pdf_url TEXT, official_landing_url TEXT, source_sha256 TEXT);
    CREATE TABLE chunk_embeddings (chunk_id TEXT PRIMARY KEY, vector BLOB NOT NULL);
  `);
  const insert = db.prepare(
    "INSERT INTO corpus_chunks VALUES (?, 'doc-1', 'Synthetic Act', 'Fixture', 'llp', ?, ?, ?, NULL, 'https://indiacode.gov.in/x.pdf', NULL, ?)",
  );
  const vector = db.prepare('INSERT INTO chunk_embeddings VALUES (?, ?)');
  const pages: Array<[string, number, string, number[]]> = [
    ['keyword-page', 1, 'Designated partners must file the annual statement.', [1, 0, 0]],
    ['semantic-page', 2, 'Every partnership needs at least two nominated individuals.', [0, 1, 0]],
    ['other-page', 3, 'Unrelated provision about seals.', [0, 0, 1]],
  ];
  for (const [id, page, text, embedding] of pages) {
    insert.run(id, page, page, text, 'a'.repeat(64));
    vector.run(id, encodeVector(Float32Array.from(embedding)));
  }
  db.close();
}
afterAll(() => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows may hold SQLite handles briefly.
  }
});

function evidence(chunkId: string, page: number): RagEvidence {
  return {
    chunkId,
    documentId: 'doc-1',
    title: 'Synthetic Act',
    authority: 'Fixture',
    sectionIdentifier: `Page ${page}`,
    sectionHeading: null,
    pageStart: page,
    pageEnd: page,
    officialSourceUrl: null,
    effectiveDate: null,
    retrievalDate: '2026-09-29T00:00:00.000Z',
    sha256: 'a'.repeat(64),
    legalStatus: 'unknown',
    text: '',
    score: 1,
  };
}

const keyword = (results: RagEvidence[]): RagRetriever => ({
  status: async () => ({
    state: 'ready',
    indexSchemaVersion: 'fixture',
    lastSuccessfulIngestionAt: null,
    categories: [],
    limitations: [],
  }),
  search: async () => results,
});
const input: RagQueryInput = {
  question: 'How many designated partners does an LLP need?',
  legalCategory: 'all',
  jurisdiction: 'India',
  resultLimit: 2,
};
const towardsSemanticPage: Embedder = async (texts) =>
  texts.map(() => Float32Array.from([0, 1, 0]));

describe('HybridRetriever', () => {
  it('adds a page found only by semantic search, with a page citation', async () => {
    const retriever = new HybridRetriever(
      keyword([evidence('keyword-page', 1)]),
      databasePath,
      towardsSemanticPage,
    );
    const results = await retriever.search(input);
    expect(results.map((item) => item.chunkId)).toEqual(['keyword-page', 'semantic-page']);
    expect(results[1]).toMatchObject({
      sectionIdentifier: 'Page 2',
      officialSourceUrl: 'https://indiacode.gov.in/x.pdf',
    });
  });

  it('ranks a page found by both searches first (reciprocal rank fusion)', async () => {
    const retriever = new HybridRetriever(
      keyword([evidence('other-page', 3), evidence('semantic-page', 2)]),
      databasePath,
      towardsSemanticPage,
    );
    expect((await retriever.search(input))[0]!.chunkId).toBe('semantic-page');
  });

  it('keeps the out-of-scope refusal: no keyword evidence means no answer', async () => {
    let embedded = false;
    const retriever = new HybridRetriever(keyword([]), databasePath, async (texts) => {
      embedded = true;
      return towardsSemanticPage(texts);
    });
    expect(await retriever.search(input)).toEqual([]);
    expect(embedded).toBe(false);
  });

  it('computes cosine similarity', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0]))).toBeCloseTo(1);
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0);
  });
});
