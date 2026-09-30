import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { LegalChunk } from '../../src/rag/ingestion/legal-section-chunker.js';
import { LegalSectionJsonRetriever } from '../../src/rag/retrieval/legal-section-json-retriever.js';

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

function chunk(sectionNumber: string, heading: string, text: string): LegalChunk {
  return {
    chunkId: `chunk_${sectionNumber.padEnd(32, '0')}`,
    documentId: 'legal_aaaaaaaaaaaaaaaaaaaaaaaa',
    actOrRegulation: 'The Companies Act, 2013',
    chapter: 'CHAPTER TEST',
    part: null,
    sectionNumber,
    sectionHeading: heading,
    subsection: null,
    clause: null,
    pageStart: 1,
    pageEnd: 1,
    text: `Section ${sectionNumber} — ${heading}\n${text}`,
    effectiveDate: null,
    legalStatus: 'unknown',
    authority: 'technology_development_board',
    officialSourceUrl: 'https://www.tdb.gov.in/example.pdf',
    sha256: 'a'.repeat(64),
    parentChunkId: null,
    crossReferences: [],
  };
}

async function retriever() {
  const root = await mkdtemp(join(tmpdir(), 'legal-bot-rag-json-'));
  roots.push(root);
  const file = join(root, 'chunks.json');
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 'legal-sections-v2',
      documentId: 'legal_aaaaaaaaaaaaaaaaaaaaaaaa',
      sourceSha256: 'a'.repeat(64),
      chunks: [
        chunk(
          '149',
          'Company to have Board of Directors',
          'Every company shall have a Board of Directors.',
        ),
        chunk(
          '173',
          'Meetings of Board',
          'Every company shall hold its first Board meeting within thirty days.',
        ),
        chunk(
          '188',
          'Related party transactions',
          'Specified related party contracts require Board consent.',
        ),
      ],
    }),
  );
  return LegalSectionJsonRetriever.open(file, '2026-09-01T12:54:17.027Z');
}

describe('LegalSectionJsonRetriever', () => {
  it.each([
    ['What does Section 188 cover?', '188'],
    ['Explain Section 173 simply', '173'],
    ['What is the requirement under Section 149?', '149'],
  ])('ranks direct section %s first', async (question, expected) => {
    const results = await (
      await retriever()
    ).search({ question, legalCategory: 'corporate', jurisdiction: 'India', resultLimit: 3 });
    expect(results[0]?.sectionIdentifier).toBe(expected);
  });

  it('ranks conceptual heading matches and emits immutable citation metadata', async () => {
    const results = await (
      await retriever()
    ).search({
      question: 'related party transactions',
      legalCategory: 'corporate',
      jurisdiction: 'India',
      resultLimit: 3,
    });
    expect(results[0]).toMatchObject({
      sectionIdentifier: '188',
      sha256: 'a'.repeat(64),
      legalStatus: 'unknown',
    });
  });
});
