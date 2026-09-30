import { DatabaseSync } from 'node:sqlite';

import type { RagCorpusStatus, RagEvidence, RagQueryInput, RagRetriever } from '../rag-service.js';
import { inferLegalCategory } from './legal-category.js';

// Hybrid retrieval: keyword (BM25) and semantic (embedding) search, merged with
// Reciprocal Rank Fusion.
//
// BM25 is exact on section numbers and defined terms; embeddings find passages
// that answer a paraphrased question with different words. RRF combines the
// two rankings without tuning score scales: each result scores
// sum(1 / (k + rank)) over the lists it appears in.
//
// Embeddings are stored in the index file (table chunk_embeddings, float32),
// built by scripts/build-embeddings.ts. Search is exact cosine similarity over
// the stored vectors of the question's legal area.

export type Embedder = (texts: string[], signal?: AbortSignal) => Promise<Float32Array[]>;

export interface HybridOptions {
  /** RRF constant; 60 is the value from the original RRF paper. */
  k?: number;
  /** Results taken from each list before fusion. */
  depth?: number;
}

interface StoredVector {
  chunkId: string;
  category: string;
  vector: Float32Array;
}

export class HybridRetriever implements RagRetriever {
  private readonly vectors: StoredVector[];
  private readonly database: DatabaseSync;
  private readonly k: number;
  private readonly depth: number;

  constructor(
    private readonly keyword: RagRetriever,
    databasePath: string,
    private readonly embed: Embedder,
    options: HybridOptions = {},
  ) {
    this.k = options.k ?? 60;
    this.depth = options.depth ?? 20;
    this.database = new DatabaseSync(databasePath, { readOnly: true });
    this.vectors = (
      this.database
        .prepare(
          `SELECT e.chunk_id, c.legal_category, e.vector
           FROM chunk_embeddings e JOIN corpus_chunks c ON c.chunk_id = e.chunk_id`,
        )
        .all() as Array<{ chunk_id: string; legal_category: string; vector: Uint8Array }>
    ).map((row) => ({
      chunkId: row.chunk_id,
      category: row.legal_category,
      vector: new Float32Array(
        row.vector.buffer.slice(
          row.vector.byteOffset,
          row.vector.byteOffset + row.vector.byteLength,
        ),
      ),
    }));
    if (this.vectors.length === 0)
      throw new Error('The index has no embeddings; run scripts/build-embeddings.ts');
  }

  status(): Promise<RagCorpusStatus> {
    return this.keyword.status();
  }

  async search(input: RagQueryInput, signal?: AbortSignal): Promise<RagEvidence[]> {
    const deep = { ...input, resultLimit: Math.max(input.resultLimit, this.depth) };
    const keywordResults = await this.keyword.search(deep, signal);
    // The keyword retriever applies the out-of-area guard: no evidence means
    // the question is out of scope, and semantic search must not override it.
    if (keywordResults.length === 0) return [];
    const [query] = await this.embed([input.question], signal);
    const category =
      input.legalCategory === 'all' ? inferLegalCategory(input.question) : input.legalCategory;
    const semantic = this.vectors
      .filter((item) => !category || item.category === category)
      .map((item) => ({ chunkId: item.chunkId, score: cosine(query!, item.vector) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, this.depth);

    const fused = new Map<string, number>();
    keywordResults.forEach((item, rank) =>
      fused.set(item.chunkId, (fused.get(item.chunkId) ?? 0) + 1 / (this.k + rank + 1)),
    );
    semantic.forEach((item, rank) =>
      fused.set(item.chunkId, (fused.get(item.chunkId) ?? 0) + 1 / (this.k + rank + 1)),
    );
    const ranked = [...fused.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, input.resultLimit);

    const byId = new Map(keywordResults.map((item) => [item.chunkId, item]));
    const missing = ranked.map(([chunkId]) => chunkId).filter((chunkId) => !byId.has(chunkId));
    for (const evidence of this.loadEvidence(missing, keywordResults[0]!.retrievalDate))
      byId.set(evidence.chunkId, evidence);
    return ranked
      .map(([chunkId, score]) => {
        const evidence = byId.get(chunkId);
        return evidence ? { ...evidence, score } : null;
      })
      .filter((item): item is RagEvidence => item !== null);
  }

  // Evidence for chunks found only by semantic search, in the same shape the
  // keyword retriever returns (page-level citations).
  private loadEvidence(chunkIds: string[], retrievalDate: string): RagEvidence[] {
    if (chunkIds.length === 0) return [];
    const rows = this.database
      .prepare(
        `SELECT chunk_id, document_id, title, authority, page_start, page_end, text, effective_date,
                final_pdf_url, official_landing_url, source_sha256
         FROM corpus_chunks WHERE chunk_id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(chunkIds)) as Array<{
      chunk_id: string;
      document_id: string;
      title: string;
      authority: string;
      page_start: number;
      page_end: number;
      text: string;
      effective_date: string | null;
      final_pdf_url: string | null;
      official_landing_url: string | null;
      source_sha256: string;
    }>;
    return rows.map((row) => {
      const source = row.final_pdf_url ?? row.official_landing_url;
      return {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        authority: row.authority,
        sectionIdentifier: `Page ${row.page_start}`,
        sectionHeading: null,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        officialSourceUrl: source && /^https:\/\//iu.test(source) ? source : null,
        effectiveDate: row.effective_date,
        retrievalDate,
        sha256: row.source_sha256,
        legalStatus: 'unknown' as const,
        text: row.text,
        score: 0,
      };
    });
  }
}

export function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  return leftNorm && rightNorm ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

export function encodeVector(vector: Float32Array): Uint8Array {
  return new Uint8Array(
    vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength),
  );
}
