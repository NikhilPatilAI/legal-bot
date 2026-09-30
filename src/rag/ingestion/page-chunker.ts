import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ExtractedDocument } from './document-extractor.js';

// Splits an extracted PDF into page-aware chunks for the search index. Each
// chunk keeps its page number, the source's SHA-256 and its official URLs, so
// every citation can be traced back to an exact page of an exact file.

/** One PDF listed in the ingestion manifest, after hashing. */
export interface SourceDocument {
  documentId: string;
  sha256: string;
  title: string;
  authority: string;
  legalCategory: string;
  documentType: string | null;
  documentNumber: string | null;
  publicationDate: string | null;
  effectiveDate: string | null;
  amendmentDate: string | null;
  language: string;
  relativeFilePath: string;
  officialLandingUrl: string | null;
  finalPdfUrl: string | null;
  notes: string | null;
  warnings: string[];
}

export const pageChunkSchema = z
  .object({
    chunkId: z.string().regex(/^chunk_[a-f0-9]{32}$/),
    documentId: z.string().regex(/^legal_[a-f0-9]{24}$/),
    title: z.string().min(1),
    authority: z.string().min(1),
    legalCategory: z.string().min(1),
    documentType: z.string().nullable(),
    documentNumber: z.string().nullable(),
    publicationDate: z.string().nullable(),
    effectiveDate: z.string().nullable(),
    amendmentDate: z.string().nullable(),
    language: z.string(),
    legalStatus: z.literal('unknown'),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    text: z.string().min(1),
    contentKind: z.enum(['page_text', 'ocr_text', 'metadata_only']),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    extractionSha256: z.string().regex(/^[a-f0-9]{64}$/),
    relativeFilePath: z.string().min(1),
    officialLandingUrl: z.url().nullable(),
    finalPdfUrl: z.url().nullable(),
    metadataWarnings: z.array(z.string().min(1)),
  })
  .strict()
  .refine((chunk) => chunk.pageEnd >= chunk.pageStart, {
    message: 'pageEnd must not precede pageStart',
  });

export type PageChunk = z.infer<typeof pageChunkSchema>;

export interface PageChunkingOptions {
  maxCharacters?: number;
  overlapCharacters?: number;
}

export function createPageChunks(
  record: SourceDocument,
  extracted: ExtractedDocument,
  options: PageChunkingOptions = {},
): PageChunk[] {
  if (record.documentId !== extracted.documentId)
    throw new Error('Source document and extracted document identity do not match');
  if (!/^[a-f0-9]{64}$/.test(record.sha256))
    throw new Error('Source document has no SHA-256 digest');
  const maxCharacters = options.maxCharacters ?? 4_000;
  const overlapCharacters = options.overlapCharacters ?? 300;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 500 || maxCharacters > 20_000)
    throw new Error('maxCharacters must be an integer from 500 to 20000');
  if (
    !Number.isSafeInteger(overlapCharacters) ||
    overlapCharacters < 0 ||
    overlapCharacters >= maxCharacters / 2
  )
    throw new Error('overlapCharacters must be a non-negative integer below half of maxCharacters');

  const warnings = record.warnings;
  const chunks: PageChunk[] = [];
  for (const page of extracted.pages) {
    const isOcr = page.extractionMethod === 'ocr_tesseract';
    for (const [index, text] of splitText(page.text, maxCharacters, overlapCharacters).entries()) {
      chunks.push(
        buildChunk(
          record,
          extracted.sourceSha256,
          page.pageNumber,
          text,
          isOcr ? 'ocr_text' : 'page_text',
          index,
          isOcr ? [...warnings, 'OCR_TESSERACT_TEXT_UNVALIDATED'] : warnings,
        ),
      );
    }
  }
  if (chunks.length === 0) {
    const metadata = [
      record.title,
      record.documentNumber,
      record.authority,
      record.legalCategory,
      record.documentType,
      record.notes,
    ]
      .filter(Boolean)
      .join('\n');
    chunks.push(
      buildChunk(
        record,
        extracted.sourceSha256,
        1,
        metadata || record.relativeFilePath,
        'metadata_only',
        0,
        [...warnings, 'OCR_REQUIRED_NO_EXTRACTABLE_TEXT'],
      ),
    );
  }
  return chunks;
}

export function splitText(
  value: string,
  maxCharacters: number,
  overlapCharacters: number,
): string[] {
  const text = value
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (!text) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxCharacters, text.length);
    if (end < text.length) {
      const minimumBreak = start + Math.floor(maxCharacters * 0.6);
      const paragraphBreak = text.lastIndexOf('\n\n', end);
      const sentenceBreak = Math.max(text.lastIndexOf('. ', end), text.lastIndexOf('; ', end));
      const whitespaceBreak = text.lastIndexOf(' ', end);
      const preferred = [
        paragraphBreak,
        sentenceBreak >= 0 ? sentenceBreak + 1 : -1,
        whitespaceBreak,
      ].find((candidate) => candidate >= minimumBreak);
      if (preferred !== undefined) end = preferred;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= text.length) break;
    const next = Math.max(start + 1, end - overlapCharacters);
    const whitespace = text.indexOf(' ', next);
    start = whitespace >= 0 && whitespace < end ? whitespace + 1 : next;
  }
  return chunks;
}

function buildChunk(
  record: SourceDocument,
  extractionSha256: string,
  pageNumber: number,
  text: string,
  contentKind: 'page_text' | 'ocr_text' | 'metadata_only',
  index: number,
  metadataWarnings: string[],
): PageChunk {
  const chunkId = `chunk_${createHash('sha256').update(`${record.documentId}\n${record.sha256}\n${pageNumber}\n${index}\n${text}`).digest('hex').slice(0, 32)}`;
  return pageChunkSchema.parse({
    chunkId,
    documentId: record.documentId,
    title: record.title,
    authority: record.authority,
    legalCategory: record.legalCategory,
    documentType: record.documentType,
    documentNumber: record.documentNumber,
    publicationDate: record.publicationDate,
    effectiveDate: record.effectiveDate,
    amendmentDate: record.amendmentDate,
    language: record.language,
    legalStatus: 'unknown',
    pageStart: pageNumber,
    pageEnd: pageNumber,
    text,
    contentKind,
    sourceSha256: record.sha256,
    extractionSha256,
    relativeFilePath: record.relativeFilePath.replaceAll('\\', '/'),
    officialLandingUrl: record.officialLandingUrl,
    finalPdfUrl: record.finalPdfUrl,
    metadataWarnings: [...new Set(metadataWarnings)].sort(),
  });
}
