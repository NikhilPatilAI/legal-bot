import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config.js';
import { createRagService } from '../../src/rag/factory.js';
import { DeterministicExtractComposer, LegalRagService } from '../../src/rag/rag-service.js';
import {
  CorpusIndexRetriever,
  textQuality,
} from '../../src/rag/retrieval/corpus-index-retriever.js';

// Synthetic engineering fixture in the same table layout as the full-corpus
// index. The text is not a statement of any real law.
const directory = mkdtempSync(join(tmpdir(), 'legal-bot-corpus-'));
const databasePath = join(directory, 'fixture.sqlite');
{
  const db = new DatabaseSync(databasePath);
  db.exec(`
    CREATE TABLE corpus_documents (source_sha256 TEXT PRIMARY KEY, document_id TEXT NOT NULL, title TEXT NOT NULL, relative_file_path TEXT NOT NULL);
    CREATE TABLE corpus_chunks (
      chunk_id TEXT PRIMARY KEY, source_sha256 TEXT NOT NULL, document_id TEXT NOT NULL,
      title TEXT NOT NULL, authority TEXT NOT NULL, legal_category TEXT NOT NULL,
      page_start INTEGER NOT NULL, page_end INTEGER NOT NULL, text TEXT NOT NULL,
      content_kind TEXT NOT NULL, effective_date TEXT, final_pdf_url TEXT, official_landing_url TEXT);
    CREATE VIRTUAL TABLE corpus_chunks_fts USING fts5(chunk_id UNINDEXED, title, text, authority, legal_category, document_type);
  `);
  let count = 0;
  const insert = (category: string, title: string, text: string) => {
    count += 1;
    const sha = String(count).repeat(64).slice(0, 64);
    const id = `legal_${String(count).repeat(24).slice(0, 24)}`;
    db.prepare('INSERT INTO corpus_documents VALUES (?, ?, ?, ?)').run(
      sha,
      id,
      title,
      `04-gst/fixture-${count}.pdf`,
    );
    db.prepare(
      'INSERT INTO corpus_chunks VALUES (?, ?, ?, ?, ?, ?, 3, 3, ?, ?, NULL, ?, NULL)',
    ).run(
      `chunk_${count}`,
      sha,
      id,
      title,
      'fixture authority',
      category,
      text,
      'page_text',
      'https://www.cbic-gst.gov.in/fixture.pdf',
    );
    db.prepare('INSERT INTO corpus_chunks_fts VALUES (?, ?, ?, ?, ?, NULL)').run(
      `chunk_${count}`,
      title,
      text,
      'fixture authority',
      category,
    );
  };
  insert(
    'gst',
    'Fixture GST circular',
    'Every registered supplier shall display the GST registration certificate at the principal place of business and at every additional place of business under this fixture circular.',
  );
  insert(
    'gst',
    'Fixture GST Hindi notice',
    'जीएसटी पंजीकरण प्रमाणपत्र प्रत्येक व्यापार स्थल पर प्रदर्शित किया जाएगा और यह नियम सभी पंजीकृत आपूर्तिकर्ताओं पर लागू होता है GST registration',
  );
  insert('gst', 'Fixture GST short page', 'GST registration certificate page 4');
  db.close();
}

afterAll(() => {
  // The factory-built service keeps its read-only handle open; Windows locks
  // the file until the process exits, so leftover temp files are tolerated.
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    /* temp directory is removed by the OS */
  }
});

const gstQuestion = {
  question: 'Where must a GST registered supplier display the registration certificate?',
  legalCategory: 'all',
  jurisdiction: 'India',
  resultLimit: 3,
};

describe('CorpusIndexRetriever', () => {
  it('returns plain citations with the document title and no qualification label', async () => {
    const retriever = new CorpusIndexRetriever(databasePath, '2026-09-02T11:52:00.000Z');
    const results = await retriever.search(gstQuestion);
    expect(results[0]?.title).toBe('Fixture GST circular');
    expect(results.every((item) => item.sectionHeading === null)).toBe(true);
    const status = await retriever.status();
    expect(status.limitations.join(' ')).not.toMatch(/qualif/iu);
    retriever.close();
  });

  it('drops Hindi-dominant and near-empty chunks for an English question', async () => {
    const retriever = new CorpusIndexRetriever(databasePath, '2026-09-02T11:52:00.000Z');
    const titles = (await retriever.search(gstQuestion)).map((item) => item.title);
    expect(titles).toEqual(['Fixture GST circular']);
    retriever.close();
  });

  it('returns no evidence for a question outside every corpus legal area', async () => {
    const retriever = new CorpusIndexRetriever(databasePath, '2026-09-02T11:52:00.000Z');
    const passport = {
      ...gstQuestion,
      question: 'What documents do I need to apply for a fresh Indian passport?',
    };
    expect(await retriever.search(passport)).toEqual([]);
    const answer = await new LegalRagService(retriever, new DeterministicExtractComposer()).query(
      passport,
      'req_passport',
    );
    expect(answer.abstained).toBe(true);
    retriever.close();
  });

  it('answers without an unqualified-source warning', async () => {
    const retriever = new CorpusIndexRetriever(databasePath, '2026-09-02T11:52:00.000Z');
    const result = await new LegalRagService(retriever, new DeterministicExtractComposer()).query(
      gstQuestion,
      'req_private',
    );
    expect(result.abstained).toBe(false);
    expect(result.citations[0]?.title).toBe('Fixture GST circular');
    expect(result.warnings.join(' ')).not.toMatch(/qualif/iu);
    retriever.close();
  });

  it('warms the index without throwing', async () => {
    const retriever = new CorpusIndexRetriever(databasePath, '2026-09-02T11:52:00.000Z');
    expect(await retriever.warmUp()).toBeGreaterThanOrEqual(0);
    retriever.close();
  });
});

describe('textQuality', () => {
  it('classifies usable, Hindi, garbled and near-empty text', () => {
    expect(
      textQuality(
        'Every company shall hold a meeting of its Board of Directors within thirty days of incorporation.',
      ),
    ).toBe('usable');
    expect(
      textQuality(
        'कंपनी अधिनियम के अंतर्गत प्रत्येक कंपनी को निदेशक मंडल की बैठक आयोजित करनी होगी',
      ),
    ).toBe('devanagari');
    expect(
      textQuality(
        'Hkkx II [k.M 3 ljdkj dEiuh izkf/kdkj vlk/kkj.k jftLVªh Hkkjr ljdkj dEiuh ekeys ea=ky; vf/klwpuk Hkkx',
      ),
    ).toBe('garbled');
    expect(textQuality('Page 4')).toBe('near_empty');
  });
});

describe('index retriever configuration', () => {
  it('requires the build metadata written by pnpm ingest', async () => {
    const config = loadConfig({ RETRIEVER: 'index', INDEX_PATH: databasePath, HISTORY_PATH: '' });
    await expect(createRagService(config)).rejects.toThrow(/build metadata/u);
    const db = new DatabaseSync(databasePath);
    db.exec(
      "CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO index_metadata VALUES ('built_at', '2026-09-02T11:52:00.000Z')",
    );
    db.close();
    const service = await createRagService(config);
    expect(await service.status()).toMatchObject({
      indexSchemaVersion: 'legal-bot-corpus-index-v1',
      lastSuccessfulIngestionAt: '2026-09-02T11:52:00.000Z',
    });
  });
});
