import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { legalChunkSchema, type LegalChunk } from '../ingestion/legal-section-chunker.js';
import {
  extractSection,
  type RagCorpusStatus,
  type RagEvidence,
  type RagQueryInput,
  type RagRetriever,
} from '../rag-service.js';

const corpusSchema = z
  .object({
    schemaVersion: z.string().min(1),
    documentId: z.string().regex(/^legal_[a-f0-9]{24}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    chunks: z.array(legalChunkSchema).min(1),
  })
  .strict();

const stopWords = new Set([
  'about',
  'and',
  'does',
  'explain',
  'for',
  'from',
  'is',
  'of',
  'requirement',
  'the',
  'under',
  'what',
]);

export class LegalSectionJsonRetriever implements RagRetriever {
  private constructor(
    private readonly schemaVersion: string,
    private readonly chunks: LegalChunk[],
    private readonly retrievedAt: string,
  ) {}

  static async open(corpusPath: string, retrievedAt: string): Promise<LegalSectionJsonRetriever> {
    const parsed = corpusSchema.parse(JSON.parse(await readFile(resolve(corpusPath), 'utf8')));
    return new LegalSectionJsonRetriever(parsed.schemaVersion, parsed.chunks, retrievedAt);
  }

  async status(): Promise<RagCorpusStatus> {
    return {
      state: 'ready',
      indexSchemaVersion: this.schemaVersion,
      lastSuccessfulIngestionAt: this.retrievedAt,
      categories: [
        { category: 'corporate', documents: 1, chunks: this.chunks.length, state: 'experimental' },
      ],
      limitations: [
        'Coverage is limited to one official-government reproduction of the Companies Act, 2013.',
        'The source is not verified as a current consolidation; legal status and effective dates remain unknown.',
        'Historical and non-corporate questions are not supported by this test corpus.',
      ],
    };
  }

  async search(input: RagQueryInput, signal?: AbortSignal): Promise<RagEvidence[]> {
    signal?.throwIfAborted();
    const section = extractSection(input.question);
    const tokens = searchableTokens(input.question);
    const scored = this.chunks
      .map((chunk) => ({
        chunk,
        score: scoreChunk(chunk, section, tokens),
      }))
      .filter(({ score }) => score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.chunk.sectionNumber.localeCompare(b.chunk.sectionNumber, 'en', { numeric: true }),
      );

    return scored.slice(0, input.resultLimit).map(({ chunk, score }) => ({
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      title: chunk.actOrRegulation,
      authority: chunk.authority,
      sectionIdentifier: chunk.sectionNumber,
      sectionHeading: chunk.sectionHeading,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      officialSourceUrl: chunk.officialSourceUrl,
      effectiveDate: chunk.effectiveDate,
      retrievalDate: this.retrievedAt,
      sha256: chunk.sha256,
      legalStatus: chunk.legalStatus,
      text: chunk.text,
      score,
    }));
  }
}

function searchableTokens(question: string): string[] {
  return [
    ...new Set(
      (
        question
          .normalize('NFKC')
          .toLocaleLowerCase('en-US')
          .match(/[\p{L}\p{N}]{3,}/gu) ?? []
      ).filter((token) => !stopWords.has(token)),
    ),
  ];
}

function scoreChunk(chunk: LegalChunk, section: string | null, tokens: string[]): number {
  if (section) return chunk.sectionNumber === section ? 10_000 + lexicalScore(chunk, tokens) : 0;
  return lexicalScore(chunk, tokens);
}

function lexicalScore(chunk: LegalChunk, tokens: string[]): number {
  const heading = chunk.sectionHeading.toLocaleLowerCase('en-US');
  const text = chunk.text.toLocaleLowerCase('en-US');
  return tokens.reduce(
    (score, token) =>
      score + (heading.includes(token) ? 20 : 0) + Math.min(5, text.split(token).length - 1),
    0,
  );
}
