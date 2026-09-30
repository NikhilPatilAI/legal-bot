import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ExtractedDocument } from './document-extractor.js';
import { manifestSchema, provenanceProblems, type ManifestEntry } from './manifest.js';
import { createPageChunks, type PageChunk, type SourceDocument } from './page-chunker.js';
import { LocalPdfJsExtractor } from './pdfjs-local-extractor.js';

// PDF -> SQLite FTS5 index.
//
//   manifest.json --validate--> hash each PDF --extract text (pdf.js)--> page
//   chunks --one transaction per document--> corpus_documents, corpus_chunks,
//   corpus_chunks_fts (BM25 full-text index)
//
// Re-running is incremental: a PDF whose SHA-256 is already indexed is
// skipped. A failing PDF is reported and does not stop the run.

export interface IngestOptions {
  manifestPath: string;
  indexPath: string;
  /** Accept sources outside the official-host allow-list (still recorded). */
  allowUnofficial?: boolean;
  /** Called after each document, for progress output. */
  onProgress?: (event: { file: string; outcome: 'indexed' | 'skipped' | 'failed' }) => void;
  now?: () => Date;
}

export interface IngestReport {
  manifestDocuments: number;
  indexed: number;
  alreadyIndexed: number;
  ocrRequired: number;
  failures: Array<{ file: string; error: string }>;
  totalDocuments: number;
  totalChunks: number;
  builtAt: string;
}

export async function ingest(options: IngestOptions): Promise<IngestReport> {
  const manifestPath = resolve(options.manifestPath);
  const root = dirname(manifestPath);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
  await mkdir(dirname(resolve(options.indexPath)), { recursive: true });
  const database = new DatabaseSync(resolve(options.indexPath));
  createIndexSchema(database);
  const existing = new Set(
    (
      database.prepare('SELECT source_sha256 FROM corpus_documents').all() as Array<{
        source_sha256: string;
      }>
    ).map((row) => row.source_sha256),
  );
  const extractor = new LocalPdfJsExtractor({ maxPages: 2_000 });
  const report: IngestReport = {
    manifestDocuments: manifest.documents.length,
    indexed: 0,
    alreadyIndexed: 0,
    ocrRequired: 0,
    failures: [],
    totalDocuments: 0,
    totalChunks: 0,
    builtAt: '',
  };
  try {
    for (const entry of manifest.documents) {
      const file = entry.file.replaceAll('\\', '/');
      try {
        const problems = provenanceProblems(entry, options.allowUnofficial ?? false);
        if (problems.length > 0) throw new Error(problems.join('; '));
        const path = resolve(root, file);
        if (relative(root, path).startsWith('..'))
          throw new Error('file is outside the manifest folder');
        const sha256 = createHash('sha256')
          .update(await readFile(path))
          .digest('hex');
        if (existing.has(sha256)) {
          report.alreadyIndexed += 1;
          options.onProgress?.({ file, outcome: 'skipped' });
          continue;
        }
        const source = sourceDocument(entry, file, sha256, options.allowUnofficial ?? false);
        const extracted = await extractor.extract({
          documentId: source.documentId,
          sourcePath: path,
          sourceSha256: sha256,
        });
        writeDocument(database, source, extracted, createPageChunks(source, extracted));
        existing.add(sha256);
        report.indexed += 1;
        if (extracted.status === 'ocr_required') report.ocrRequired += 1;
        options.onProgress?.({ file, outcome: 'indexed' });
      } catch (error) {
        report.failures.push({
          file,
          error: error instanceof Error ? error.message : String(error),
        });
        options.onProgress?.({ file, outcome: 'failed' });
      }
    }
    database.exec("INSERT INTO corpus_chunks_fts(corpus_chunks_fts) VALUES ('optimize')");
    report.builtAt = (options.now?.() ?? new Date()).toISOString();
    database
      .prepare(
        "INSERT INTO index_metadata (key, value) VALUES ('built_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(report.builtAt);
    report.totalDocuments = count(database, 'corpus_documents');
    report.totalChunks = count(database, 'corpus_chunks');
    // Fold the write-ahead log back into one self-contained file, so the index
    // can be copied, shipped in an image and opened on a read-only filesystem.
    database.exec('PRAGMA journal_mode = DELETE');
  } finally {
    database.close();
  }
  return report;
}

function sourceDocument(
  entry: ManifestEntry,
  file: string,
  sha256: string,
  allowUnofficial: boolean,
): SourceDocument {
  return {
    // Content-addressed: the same PDF always gets the same id.
    documentId: `legal_${sha256.slice(0, 24)}`,
    sha256,
    title: entry.title,
    authority: entry.authority,
    legalCategory: entry.legalCategory,
    documentType: entry.documentType,
    documentNumber: entry.documentNumber,
    publicationDate: entry.publicationDate,
    effectiveDate: entry.effectiveDate,
    amendmentDate: entry.amendmentDate,
    language: entry.language,
    relativeFilePath: file,
    officialLandingUrl: entry.officialLandingUrl,
    finalPdfUrl: entry.finalPdfUrl,
    notes: entry.notes,
    warnings: allowUnofficial ? ['SOURCE_NOT_ON_OFFICIAL_ALLOW_LIST'] : [],
  };
}

export function createIndexSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS corpus_documents (
      source_sha256 TEXT PRIMARY KEY,
      document_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      authority TEXT NOT NULL,
      legal_category TEXT NOT NULL,
      document_type TEXT,
      relative_file_path TEXT NOT NULL,
      final_pdf_url TEXT,
      official_landing_url TEXT,
      extraction_status TEXT NOT NULL CHECK (extraction_status IN ('extracted', 'ocr_required')),
      page_count INTEGER NOT NULL,
      text_characters INTEGER NOT NULL,
      legal_status TEXT NOT NULL CHECK (legal_status = 'unknown'),
      metadata_warnings_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS corpus_chunks (
      chunk_id TEXT PRIMARY KEY,
      source_sha256 TEXT NOT NULL REFERENCES corpus_documents(source_sha256) ON DELETE CASCADE,
      document_id TEXT NOT NULL,
      title TEXT NOT NULL,
      authority TEXT NOT NULL,
      legal_category TEXT NOT NULL,
      document_type TEXT,
      document_number TEXT,
      publication_date TEXT,
      effective_date TEXT,
      amendment_date TEXT,
      language TEXT NOT NULL,
      legal_status TEXT NOT NULL,
      page_start INTEGER NOT NULL,
      page_end INTEGER NOT NULL,
      text TEXT NOT NULL,
      content_kind TEXT NOT NULL,
      relative_file_path TEXT NOT NULL,
      official_landing_url TEXT,
      final_pdf_url TEXT,
      metadata_warnings_json TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS corpus_chunks_fts USING fts5(
      chunk_id UNINDEXED, title, text, authority, legal_category, document_type,
      tokenize = 'unicode61 remove_diacritics 2'
    );
    CREATE INDEX IF NOT EXISTS corpus_chunks_document_id ON corpus_chunks(document_id);
    CREATE INDEX IF NOT EXISTS corpus_chunks_category ON corpus_chunks(legal_category);
  `);
}

// One transaction per document: a crash never leaves a half-indexed PDF.
function writeDocument(
  database: DatabaseSync,
  source: SourceDocument,
  extracted: ExtractedDocument,
  chunks: PageChunk[],
): void {
  const insertDocument = database.prepare(`INSERT INTO corpus_documents (
    source_sha256, document_id, title, authority, legal_category, document_type, relative_file_path,
    final_pdf_url, official_landing_url, extraction_status, page_count, text_characters, legal_status,
    metadata_warnings_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?)`);
  const insertChunk = database.prepare(`INSERT INTO corpus_chunks (
    chunk_id, source_sha256, document_id, title, authority, legal_category, document_type,
    document_number, publication_date, effective_date, amendment_date, language, legal_status,
    page_start, page_end, text, content_kind, relative_file_path, official_landing_url,
    final_pdf_url, metadata_warnings_json
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertFts = database.prepare(
    'INSERT INTO corpus_chunks_fts (chunk_id, title, text, authority, legal_category, document_type) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const textCharacters = extracted.pages.reduce((sum, page) => sum + page.textCharacterCount, 0);
  database.exec('BEGIN IMMEDIATE');
  try {
    insertDocument.run(
      source.sha256,
      source.documentId,
      source.title,
      source.authority,
      source.legalCategory,
      source.documentType,
      source.relativeFilePath,
      source.finalPdfUrl,
      source.officialLandingUrl,
      extracted.status,
      extracted.pageCount,
      textCharacters,
      JSON.stringify(source.warnings),
    );
    for (const chunk of chunks) {
      insertChunk.run(
        chunk.chunkId,
        chunk.sourceSha256,
        chunk.documentId,
        chunk.title,
        chunk.authority,
        chunk.legalCategory,
        chunk.documentType,
        chunk.documentNumber,
        chunk.publicationDate,
        chunk.effectiveDate,
        chunk.amendmentDate,
        chunk.language,
        chunk.legalStatus,
        chunk.pageStart,
        chunk.pageEnd,
        chunk.text,
        chunk.contentKind,
        chunk.relativeFilePath,
        chunk.officialLandingUrl,
        chunk.finalPdfUrl,
        JSON.stringify(chunk.metadataWarnings),
      );
      insertFts.run(
        chunk.chunkId,
        chunk.title,
        chunk.text,
        chunk.authority,
        chunk.legalCategory,
        chunk.documentType,
      );
    }
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function count(database: DatabaseSync, table: 'corpus_documents' | 'corpus_chunks'): number {
  return Number((database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}
