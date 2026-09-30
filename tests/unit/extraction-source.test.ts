import { describe, expect, it } from 'vitest';
import {
  assertExtractionSource,
  extractedDocumentSchema,
} from '../../src/rag/ingestion/document-extractor.js';

const cached = extractedDocumentSchema.parse({
  schemaVersion: '1.0.0',
  documentId: `legal_${'a'.repeat(24)}`,
  sourceSha256: 'b'.repeat(64),
  extractor: 'pdfjs-dist',
  extractedAt: '2026-09-10T00:00:00Z',
  pageCount: 1,
  status: 'extracted',
  pages: [
    {
      pageNumber: 1,
      text: 'Synthetic',
      textCharacterCount: 9,
      extractionMethod: 'embedded_text',
      confidence: null,
    },
  ],
  warnings: [],
});

describe('cached extraction source binding', () => {
  it('accepts only the requested document and inspected input checksum', () => {
    expect(() =>
      assertExtractionSource(cached, cached.documentId, cached.sourceSha256),
    ).not.toThrow();
    expect(() =>
      assertExtractionSource(cached, `legal_${'c'.repeat(24)}`, cached.sourceSha256),
    ).toThrow(/identity/);
    expect(() => assertExtractionSource(cached, cached.documentId, 'd'.repeat(64))).toThrow(
      /identity/,
    );
  });
});
