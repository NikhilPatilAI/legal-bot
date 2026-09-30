import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  LocalPdfJsExtractor,
  normalizeExtractedText,
  textItemsToString,
  type PdfLoader,
} from '../../src/rag/ingestion/pdfjs-local-extractor.js';

describe('LocalPdfJsExtractor', () => {
  const roots: string[] = [];
  afterEach(async () =>
    Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
  );

  async function request() {
    const bytes = Buffer.from('%PDF-limit-fixture');
    const root = await mkdtemp(join(tmpdir(), 'legal-bot-pdf-'));
    roots.push(root);
    const sourcePath = join(root, 'fixture.pdf');
    await writeFile(sourcePath, bytes);
    return {
      documentId: 'legal_1234567890abcdef12345678',
      sourcePath,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }

  it('rejects oversized input before invoking the parser', async () => {
    const loader = vi.fn();
    await expect(
      new LocalPdfJsExtractor({ maxBytes: 8, loader }).extract(await request()),
    ).rejects.toThrow(/byte limit/);
    expect(loader).not.toHaveBeenCalled();
  });

  it('bounds a stalled parser and destroys its loading task', async () => {
    const destroy = vi.fn(async () => {});
    const loader: PdfLoader = () => ({ promise: new Promise(() => {}), destroy });
    await expect(
      new LocalPdfJsExtractor({ timeoutMs: 20, loader }).extract(await request()),
    ).rejects.toThrow(/deadline/);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('bounds cumulative extracted text and cleans up the page and document', async () => {
    const cleanup = vi.fn();
    const destroy = vi.fn(async () => {});
    const loader: PdfLoader = () => ({
      promise: Promise.resolve({
        numPages: 2,
        async getPage() {
          return {
            async getTextContent() {
              return { items: [{ str: 'Sixsix' }] };
            },
            cleanup,
          };
        },
      }),
      destroy,
    });
    await expect(
      new LocalPdfJsExtractor({ maxTextCharacters: 10, loader }).extract(await request()),
    ).rejects.toThrow(/character limit/);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('rejects invalid parser budgets', () => {
    for (const maxBytes of [0, -1, Infinity, 0.5])
      expect(() => new LocalPdfJsExtractor({ maxBytes })).toThrow(/positive integers/);
  });

  it('extracts page-scoped embedded text with deterministic source verification', async () => {
    const bytes = Buffer.from('%PDF-test-fixture');
    const root = await mkdtemp(join(tmpdir(), 'legal-bot-pdf-'));
    roots.push(root);
    const path = join(root, 'fixture.pdf');
    await writeFile(path, bytes);
    const pages = [
      [
        { str: 'THE COMPANIES ACT, 2013', hasEOL: true, transform: [1, 0, 0, 1, 1, 10] },
        { str: 'Section text', transform: [1, 0, 0, 1, 1, 8] },
      ],
      [
        { str: 'More', transform: [1, 0, 0, 1, 1, 10] },
        { str: 'text', hasEOL: true, transform: [1, 0, 0, 1, 10, 10] },
      ],
    ];
    let destroyed = false;
    const loader: PdfLoader = () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        async getPage(pageNumber) {
          return {
            async getTextContent() {
              return { items: pages[pageNumber - 1] ?? [] };
            },
            cleanup() {},
          };
        },
      }),
      async destroy() {
        destroyed = true;
      },
    });
    const extractor = new LocalPdfJsExtractor({
      loader,
      minimumCharactersPerPage: 1,
      now: () => new Date('2026-09-01T00:00:00.000Z'),
    });
    const result = await extractor.extract({
      documentId: 'legal_1234567890abcdef12345678',
      sourcePath: path,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(result).toMatchObject({
      status: 'extracted',
      pageCount: 2,
      extractedAt: '2026-09-01T00:00:00.000Z',
    });
    expect(result.pages.map((page) => page.text)).toEqual([
      'THE COMPANIES ACT, 2013\nSection text',
      'More text',
    ]);
    expect(destroyed).toBe(true);
  });

  it('marks image-only documents as requiring OCR', async () => {
    const bytes = Buffer.from('%PDF-image-fixture');
    const root = await mkdtemp(join(tmpdir(), 'legal-bot-pdf-'));
    roots.push(root);
    const path = join(root, 'fixture.pdf');
    await writeFile(path, bytes);
    const loader: PdfLoader = () => ({
      promise: Promise.resolve({
        numPages: 2,
        async getPage() {
          return {
            async getTextContent() {
              return { items: [] };
            },
            cleanup() {},
          };
        },
      }),
      async destroy() {},
    });
    const result = await new LocalPdfJsExtractor({ loader }).extract({
      documentId: 'legal_1234567890abcdef12345678',
      sourcePath: path,
      sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(result.status).toBe('ocr_required');
    expect(result.warnings.join(' ')).toMatch(/cloud OCR/i);
  });

  it('rejects checksum drift before parsing', async () => {
    const bytes = Buffer.from('%PDF-checksum-fixture');
    const root = await mkdtemp(join(tmpdir(), 'legal-bot-pdf-'));
    roots.push(root);
    const path = join(root, 'fixture.pdf');
    await writeFile(path, bytes);
    await expect(
      new LocalPdfJsExtractor().extract({
        documentId: 'legal_1234567890abcdef12345678',
        sourcePath: path,
        sourceSha256: '0'.repeat(64),
      }),
    ).rejects.toThrow(/checksum/);
  });
});

describe('PDF text normalization', () => {
  it('preserves line boundaries and repairs only lowercase line-break hyphenation', () => {
    expect(
      textItemsToString([
        { str: 'Related', transform: [1, 0, 0, 1, 1, 10] },
        { str: 'party', hasEOL: true, transform: [1, 0, 0, 1, 20, 10] },
        { str: 'trans-', hasEOL: true, transform: [1, 0, 0, 1, 1, 8] },
        { str: 'actions', transform: [1, 0, 0, 1, 1, 6] },
      ]),
    ).toBe('Related party\ntrans-\nactions');
    expect(normalizeExtractedText('trans-\nactions')).toBe('transactions');
  });
});
