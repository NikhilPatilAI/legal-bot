import { describe, expect, it } from 'vitest';

import {
  createPageChunks,
  splitText,
  type SourceDocument,
} from '../../src/rag/ingestion/page-chunker.js';
import {
  extractedDocumentSchema,
  type ExtractedDocument,
} from '../../src/rag/ingestion/document-extractor.js';

describe('page chunking', () => {
  it('creates deterministic page-bounded chunks with immutable citation metadata', () => {
    const first = createPageChunks(record(), extracted('A '.repeat(900), 'B '.repeat(100)), {
      maxCharacters: 800,
      overlapCharacters: 100,
    });
    const second = createPageChunks(record(), extracted('A '.repeat(900), 'B '.repeat(100)), {
      maxCharacters: 800,
      overlapCharacters: 100,
    });
    expect(first.length).toBeGreaterThan(2);
    expect(first.map((chunk) => chunk.chunkId)).toEqual(second.map((chunk) => chunk.chunkId));
    expect(first.every((chunk) => chunk.pageStart === chunk.pageEnd)).toBe(true);
    expect(
      first.every(
        (chunk) => chunk.sourceSha256 === 'a'.repeat(64) && chunk.legalStatus === 'unknown',
      ),
    ).toBe(true);
    expect(new Set(first.map((chunk) => chunk.pageStart))).toEqual(new Set([1, 2]));
  });

  it('creates a clearly labelled metadata-only chunk when no text is extractable', () => {
    const chunks = createPageChunks(record(), extracted('', ''));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ contentKind: 'metadata_only', pageStart: 1, pageEnd: 1 });
    expect(chunks[0]?.metadataWarnings).toContain('OCR_REQUIRED_NO_EXTRACTABLE_TEXT');
  });

  it('validates chunk bounds and overlap', () => {
    expect(() => splitText('text', 499, 0)).not.toThrow();
    expect(() => createPageChunks(record(), extracted('text'), { maxCharacters: 499 })).toThrow(
      /maxCharacters/,
    );
    expect(() =>
      createPageChunks(record(), extracted('text'), {
        maxCharacters: 1_000,
        overlapCharacters: 500,
      }),
    ).toThrow(/overlapCharacters/);
  });

  it('accepts explicitly labelled Tesseract page output', () => {
    const document = extracted('OCR legal text');
    document.extractor = 'pypdf+tesseract';
    document.pages[0]!.extractionMethod = 'ocr_tesseract';
    expect(extractedDocumentSchema.parse(document).pages[0]?.extractionMethod).toBe(
      'ocr_tesseract',
    );
    const chunks = createPageChunks(record(), document);
    expect(chunks[0]).toMatchObject({ contentKind: 'ocr_text', pageStart: 1, pageEnd: 1 });
    expect(chunks[0]?.metadataWarnings).toContain('OCR_TESSERACT_TEXT_UNVALIDATED');
  });
});

function record(): SourceDocument {
  return {
    documentId: `legal_${'a'.repeat(24)}`,
    sha256: 'a'.repeat(64),
    title: 'Synthetic Act',
    authority: 'India Code',
    legalCategory: 'companies',
    documentType: 'act',
    documentNumber: null,
    publicationDate: '2013-08-29',
    effectiveDate: null,
    amendmentDate: null,
    language: 'English',
    relativeFilePath: 'folder\\act.pdf',
    officialLandingUrl: 'https://indiacode.gov.in/handle/example',
    finalPdfUrl: 'https://indiacode.gov.in/example.pdf',
    notes: null,
    warnings: ['MISSING_REUSE_PERMISSION_REFERENCE'],
  };
}

function extracted(...texts: string[]): ExtractedDocument {
  return {
    schemaVersion: '1.0.0',
    documentId: `legal_${'a'.repeat(24)}`,
    sourceSha256: 'b'.repeat(64),
    extractor: 'pdfjs-dist',
    extractedAt: '2026-09-02T00:00:00.000Z',
    pageCount: texts.length,
    status: texts.some(Boolean) ? 'extracted' : 'ocr_required',
    pages: texts.map((text, index) => ({
      pageNumber: index + 1,
      text,
      textCharacterCount: text.length,
      extractionMethod: 'embedded_text',
      confidence: null,
    })),
    warnings: [],
  };
}
