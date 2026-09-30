import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ingest } from '../../src/rag/ingestion/ingest.js';
import { isOfficialLegalUrl, manifestSchema } from '../../src/rag/ingestion/manifest.js';
import { DeterministicExtractComposer, LegalRagService } from '../../src/rag/rag-service.js';
import { CorpusIndexRetriever } from '../../src/rag/retrieval/corpus-index-retriever.js';

// End to end over a real official PDF: manifest -> pdf.js extraction -> page
// chunks -> SQLite FTS5 index -> retrieval -> answer with a page citation.

const directory = mkdtempSync(join(tmpdir(), 'legal-bot-ingest-'));
afterAll(() => {
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    // Windows can hold SQLite handles briefly after close.
  }
});

const llpActUrl =
  'https://indiacode.gov.in/server/api/core/bitstreams/eebd9c23-655b-4e6e-a0ab-25033a8e3834/content';

function manifest(entries: unknown[]): string {
  const path = join(directory, `manifest-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({ schemaVersion: 'legal-bot-manifest-v1', documents: entries }),
  );
  return path;
}

describe('ingestion', () => {
  copyFileSync(resolve('data/sample-pdfs/llp-act-2008.pdf'), join(directory, 'llp.pdf'));
  const indexPath = join(directory, 'index.sqlite');
  const llp = {
    file: 'llp.pdf',
    title: 'The Limited Liability Partnership Act, 2008',
    authority: 'India Code',
    legalCategory: 'llp',
    documentType: 'act',
    finalPdfUrl: llpActUrl,
  };

  it('indexes an official PDF and answers from it with a page citation', async () => {
    const report = await ingest({
      manifestPath: manifest([llp]),
      indexPath,
      now: () => new Date('2026-09-30T00:00:00.000Z'),
    });
    expect(report).toMatchObject({ indexed: 1, failures: [], totalDocuments: 1 });
    expect(report.totalChunks).toBeGreaterThan(20);

    const retriever = new CorpusIndexRetriever(indexPath, report.builtAt);
    const service = new LegalRagService(retriever, new DeterministicExtractComposer());
    const result = await service.query(
      {
        question: 'How many designated partners must a limited liability partnership have?',
        legalCategory: 'all',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-1',
    );
    expect(result.abstained).toBe(false);
    // Section 7 of the Act, found by its heading "Designated partners".
    expect(result.answer).toContain('at least two designated partners');
    expect(result.citations[0]).toMatchObject({
      title: 'The Limited Liability Partnership Act, 2008',
      officialSourceUrl: llpActUrl,
    });
    expect(result.citations[0]!.sectionIdentifier).toMatch(/^Page \d+$/u);
    expect(await retriever.status()).toMatchObject({ lastSuccessfulIngestionAt: report.builtAt });
  });

  it('is incremental: an already indexed PDF is skipped', async () => {
    const report = await ingest({ manifestPath: manifest([llp]), indexPath });
    expect(report).toMatchObject({ indexed: 0, alreadyIndexed: 1, totalDocuments: 1 });
  });

  it('refuses sources that are not official unless explicitly allowed', async () => {
    const unofficial = { ...llp, finalPdfUrl: 'https://example.com/llp.pdf' };
    const refused = await ingest({
      manifestPath: manifest([unofficial]),
      indexPath: join(directory, 'refused.sqlite'),
    });
    expect(refused.indexed).toBe(0);
    expect(refused.failures[0]!.error).toMatch(/official/u);
    const allowed = await ingest({
      manifestPath: manifest([unofficial]),
      indexPath: join(directory, 'allowed.sqlite'),
      allowUnofficial: true,
    });
    expect(allowed.indexed).toBe(1);
  });

  it('reports a missing file without stopping the run', async () => {
    const report = await ingest({
      manifestPath: manifest([{ ...llp, file: 'missing.pdf' }, llp]),
      indexPath: join(directory, 'partial.sqlite'),
    });
    expect(report.indexed).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]!.file).toBe('missing.pdf');
  });
});

describe('manifest validation', () => {
  it('accepts only https URLs on the official-host allow-list', () => {
    expect(isOfficialLegalUrl('https://indiacode.gov.in/x.pdf')).toBe(true);
    expect(isOfficialLegalUrl('https://www.cbic-gst.gov.in/x.pdf')).toBe(true);
    expect(isOfficialLegalUrl('http://indiacode.gov.in/x.pdf')).toBe(false);
    expect(isOfficialLegalUrl('https://indiacode.gov.in.evil.test/x.pdf')).toBe(false);
  });

  it('rejects paths that leave the manifest folder and unknown legal areas', () => {
    const base = { title: 'T', authority: 'A', legalCategory: 'llp' };
    expect(() =>
      manifestSchema.parse({
        schemaVersion: 'legal-bot-manifest-v1',
        documents: [{ ...base, file: '../secret.pdf' }],
      }),
    ).toThrow();
    expect(() =>
      manifestSchema.parse({
        schemaVersion: 'legal-bot-manifest-v1',
        documents: [{ ...base, file: 'a.pdf', legalCategory: 'astrology' }],
      }),
    ).toThrow();
  });
});
