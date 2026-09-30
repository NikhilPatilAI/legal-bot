import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import {
  extractedDocumentSchema,
  type DocumentExtractor,
  type ExtractedDocument,
  type ExtractedPage,
  type ExtractionRequest,
} from './document-extractor.js';

interface PdfTextItem {
  str: string;
  hasEOL?: boolean;
  transform?: readonly number[];
}

interface PdfPageLike {
  getTextContent(): Promise<{ items: readonly unknown[] }>;
  cleanup(): void;
}

interface PdfDocumentLike {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageLike>;
}

interface PdfLoadingTaskLike {
  promise: Promise<PdfDocumentLike>;
  destroy(): Promise<void>;
}

export type PdfLoader = (data: Uint8Array) => PdfLoadingTaskLike;

export interface LocalPdfExtractorOptions {
  now?: () => Date;
  loader?: PdfLoader;
  maxPages?: number;
  minimumCharactersPerPage?: number;
  minimumTextPageRatio?: number;
  maxBytes?: number;
  maxTextCharacters?: number;
  timeoutMs?: number;
}

export class LocalPdfJsExtractor implements DocumentExtractor {
  private readonly now: () => Date;
  private readonly loader: PdfLoader;
  private readonly maxPages: number;
  private readonly minimumCharactersPerPage: number;
  private readonly minimumTextPageRatio: number;
  private readonly maxBytes: number;
  private readonly maxTextCharacters: number;
  private readonly timeoutMs: number;

  constructor(options: LocalPdfExtractorOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.loader = options.loader ?? defaultPdfLoader;
    this.maxPages = options.maxPages ?? 2_000;
    this.minimumCharactersPerPage = options.minimumCharactersPerPage ?? 40;
    this.minimumTextPageRatio = options.minimumTextPageRatio ?? 0.6;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxTextCharacters = options.maxTextCharacters ?? 8_000_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    for (const value of [this.maxPages, this.maxBytes, this.maxTextCharacters, this.timeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error('PDF limits must be positive integers');
    }
  }

  async extract(request: ExtractionRequest): Promise<ExtractedDocument> {
    validateRequest(request);
    const file = await open(request.sourcePath, 'r');
    let bytes: Buffer;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > this.maxBytes)
        throw new Error('PDF input exceeds the configured byte limit');
      // Bound the actual read too: the file may grow after stat().
      const chunks: Buffer[] = [];
      let total = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, this.maxBytes + 1 - total));
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) break;
        total += bytesRead;
        if (total > this.maxBytes) throw new Error('PDF input exceeds the configured byte limit');
        chunks.push(chunk.subarray(0, bytesRead));
      }
      bytes = Buffer.concat(chunks, total);
    } finally {
      await file.close();
    }
    const actualSha256 = createHash('sha256').update(bytes).digest('hex');
    if (actualSha256 !== request.sourceSha256)
      throw new Error('Source PDF checksum does not match the manifest');

    const loadingTask = this.loader(new Uint8Array(bytes));
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('PDF extraction deadline exceeded')),
        this.timeoutMs,
      );
    });
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
    try {
      const document = await bounded(loadingTask.promise);
      if (
        !Number.isSafeInteger(document.numPages) ||
        document.numPages <= 0 ||
        document.numPages > this.maxPages
      ) {
        throw new Error(`PDF page count is outside the configured range: ${document.numPages}`);
      }

      const pages: ExtractedPage[] = [];
      let textCharacters = 0;
      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await bounded(document.getPage(pageNumber));
        try {
          const content = await bounded(page.getTextContent());
          const remaining = this.maxTextCharacters - textCharacters;
          const text = normalizeExtractedText(textItemsToString(content.items, remaining));
          textCharacters += text.length;
          if (textCharacters > this.maxTextCharacters)
            throw new Error('PDF text exceeds the configured character limit');
          pages.push({
            pageNumber,
            text,
            textCharacterCount: text.length,
            extractionMethod: 'embedded_text',
            confidence: null,
          });
        } finally {
          page.cleanup();
        }
      }

      const textPages = pages.filter(
        (page) => page.textCharacterCount >= this.minimumCharactersPerPage,
      ).length;
      const textPageRatio = textPages / pages.length;
      const warnings: string[] = [
        'Local embedded-text extraction does not provide OCR confidence scores.',
      ];
      const status = textPageRatio < this.minimumTextPageRatio ? 'ocr_required' : 'extracted';
      if (status === 'ocr_required') {
        warnings.push(
          `Only ${textPages}/${pages.length} pages met the embedded-text threshold; cloud OCR is required.`,
        );
      }

      return extractedDocumentSchema.parse({
        schemaVersion: '1.0.0',
        documentId: request.documentId,
        sourceSha256: request.sourceSha256,
        extractor: 'pdfjs-dist',
        extractedAt: this.now().toISOString(),
        pageCount: pages.length,
        status,
        pages,
        warnings,
      });
    } finally {
      clearTimeout(timer!);
      let cleanupTimer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          loadingTask.destroy(),
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, 1_000);
          }),
        ]);
      } finally {
        clearTimeout(cleanupTimer!);
      }
    }
  }
}

export function textItemsToString(items: readonly unknown[], maxCharacters = 8_000_000): string {
  let output = '';
  let previousY: number | undefined;
  let previousHadEndOfLine = false;

  for (const candidate of items) {
    if (!isPdfTextItem(candidate) || candidate.str.length === 0) continue;
    if (output.length + candidate.str.length + (output.length ? 1 : 0) > maxCharacters)
      throw new Error('PDF text exceeds the configured character limit');
    const y = candidate.transform?.[5];
    const movedLine = previousY !== undefined && y !== undefined && Math.abs(y - previousY) > 2;
    if (output.length > 0 && (movedLine || previousHadEndOfLine)) output += '\n';
    else if (output.length > 0 && needsSpace(output, candidate.str)) output += ' ';
    output += candidate.str;
    previousHadEndOfLine = candidate.hasEOL === true;
    if (y !== undefined) previousY = y;
  }

  return output;
}

export function normalizeExtractedText(value: string): string {
  return value
    .normalize('NFKC')
    .replaceAll('\u0000', '')
    .replaceAll('\u00a0', ' ')
    .replace(/([\p{L}])-[ \t]*\r?\n[ \t]*([\p{Ll}])/gu, '$1$2')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\r?\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function defaultPdfLoader(data: Uint8Array): PdfLoadingTaskLike {
  const options = {
    data,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
    verbosity: 0,
  } as unknown as Parameters<typeof getDocument>[0];
  return getDocument(options) as unknown as PdfLoadingTaskLike;
}

function isPdfTextItem(value: unknown): value is PdfTextItem {
  return (
    typeof value === 'object' && value !== null && 'str' in value && typeof value.str === 'string'
  );
}

function needsSpace(output: string, next: string): boolean {
  const previous = output.at(-1) ?? '';
  return (
    !(/[\s([{]/.test(previous) || previous === '/' || previous === '-') &&
    !/^[\s,.;:!?%)\]}]/.test(next)
  );
}

function validateRequest(request: ExtractionRequest): void {
  if (!/^legal_[a-f0-9]{24}$/.test(request.documentId))
    throw new Error('Invalid document identifier');
  if (!/^[a-f0-9]{64}$/.test(request.sourceSha256)) throw new Error('Invalid source SHA-256');
  if (!request.sourcePath) throw new Error('Source path is required');
}
