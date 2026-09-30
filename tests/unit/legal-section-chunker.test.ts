import { describe, expect, it } from 'vitest';

import { createLegalChunks } from '../../src/rag/ingestion/legal-section-chunker.js';
import { createDocumentId, parseSourceManifest } from '../../src/rag/ingestion/source-manifest.js';
import { extractedDocumentSchema } from '../../src/rag/ingestion/document-extractor.js';

const identity = {
  authority: 'technology_development_board' as const,
  officialLandingUrl: 'https://www.tdb.gov.in/',
  version: 'fixture-version',
};
const documentId = createDocumentId(identity);
const sha256 = 'a'.repeat(64);
const manifest = parseSourceManifest({
  ...identity,
  documentId,
  title: 'The Companies Act, 2013',
  jurisdiction: 'India',
  legalCategory: 'corporate',
  documentType: 'act',
  originalDownloadUrl: 'https://www.tdb.gov.in/sites/default/files/fixture.pdf',
  publicationDate: '2013-08-29',
  effectiveDate: null,
  amendmentDate: null,
  retrievedAt: '2026-09-01T00:00:00.000Z',
  legalStatus: 'unknown',
  supersedes: [],
  supersededBy: [],
  sha256,
  mimeType: 'application/pdf',
  originalFilename: 'fixture.pdf',
  pageCount: 3,
  sourceAccessStatus: 'downloaded',
  localPath: `.rag-corpus/raw/technology_development_board/${documentId}/fixture-version/${sha256}.pdf`,
  azureBlobPath: null,
  extractionStatus: 'extracted',
  indexingStatus: 'not_started',
  knownGaps: ['Synthetic structure fixture; not release evidence.'],
});
const extracted = extractedDocumentSchema.parse({
  schemaVersion: '1.0.0',
  documentId,
  sourceSha256: sha256,
  extractor: 'pdfjs-dist',
  extractedAt: '2026-09-01T00:00:00.000Z',
  pageCount: 3,
  status: 'extracted',
  warnings: [],
  pages: [
    {
      pageNumber: 1,
      extractionMethod: 'embedded_text',
      confidence: null,
      textCharacterCount: 115,
      text: 'ARRANGEMENT OF SECTIONS\n149. Company to have Board of Directors.\nCHAPTER XI\nAPPOINTMENT AND QUALIFICATIONS OF DIRECTORS',
    },
    {
      pageNumber: 2,
      extractionMethod: 'embedded_text',
      confidence: null,
      textCharacterCount: 211,
      text: 'CHAPTER XI\nAPPOINTMENT AND QUALIFICATIONS OF DIRECTORS\n1. Short title. — (1) This is the operative start.\n149. Company to have Board of Directors. — (1) Every company shall have a Board. (2) Section 149 applies with section 150.',
    },
    {
      pageNumber: 3,
      extractionMethod: 'embedded_text',
      confidence: null,
      textCharacterCount: 257,
      text: `CHAPTER XII\nM EETINGS OF BOARD AND ITS POWERS\n173. Meetings of Board. — (1) The Board shall meet. (2) Participation may be electronic.\n188. Related party\ntransactions. — (1) ${'The Board must consent to the disclosed related-party arrangement. '.repeat(5)} (2) ${'The agenda shall disclose the relationship and relevant terms. '.repeat(5)} (3) The minutes shall preserve the decision. (a) Sale or supply. (b) Leasing.`,
    },
  ],
});

describe('legal section chunker', () => {
  it('finds operative Sections 149, 173, and structurally complex 188, not the arrangement entry', () => {
    const chunks = createLegalChunks(manifest, extracted, { maxCharacters: 500 });
    expect([...new Set(chunks.map((chunk) => chunk.sectionNumber))]).toEqual([
      '1',
      '149',
      '173',
      '188',
    ]);
    expect(chunks.find((chunk) => chunk.sectionNumber === '149')).toMatchObject({
      pageStart: 2,
      chapter: 'CHAPTER XI — APPOINTMENT AND QUALIFICATIONS OF DIRECTORS',
    });
    expect(chunks.find((chunk) => chunk.sectionNumber === '173')).toMatchObject({
      chapter: 'CHAPTER XII — MEETINGS OF BOARD AND ITS POWERS',
    });
    expect(
      chunks
        .filter((chunk) => chunk.sectionNumber === '188')
        .map((chunk) => chunk.text)
        .join('\n'),
    ).toContain('(b) Leasing');
    expect(chunks.find((chunk) => chunk.sectionNumber === '149')?.crossReferences).toEqual(['150']);
  });

  it('produces stable IDs and parent links for unchanged long sections', () => {
    const first = createLegalChunks(manifest, extracted, { maxCharacters: 500 });
    const second = createLegalChunks(manifest, extracted, { maxCharacters: 500 });
    expect(second).toEqual(first);
    const long = first.filter((chunk) => chunk.sectionNumber === '188');
    expect(long.length).toBeGreaterThan(1);
    expect(long[0]?.parentChunkId).not.toBeNull();
    expect(new Set(long.map((chunk) => chunk.parentChunkId)).size).toBe(1);
  });
});
