import { createReadStream, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  extractSection,
  type RagCorpusStatus,
  type RagEvidence,
  type RagQueryInput,
  type RagRetriever,
} from '../rag-service.js';
import { buildFtsQuery } from './fts-query.js';
import { inferLegalCategory } from './legal-category.js';

// Retrieval over the SQLite FTS5 index built by `pnpm ingest` from PDFs.
//
// Search pipeline for one question:
//   1. out-of-area guard: a question that matches no supported legal area
//      returns no evidence, so the service declines it;
//   2. text-quality filter: garbled or near-empty pages are skipped;
//   3. definition lookup for "what does X mean" questions;
//   4. named-instrument routing: when the question names an Act, Rules or
//      Regulations present in the index, its pages fill up to half the budget;
//   5. general BM25 search for the rest;
//   6. version families: when several consolidations of one instrument exist,
//      only the newest is kept.
//
// Citations carry the document title, page and recorded source URL. Only
// extracted text is served; original PDFs are never opened.

interface Row {
  chunk_id: string;
  document_id: string;
  title: string;
  authority: string;
  page_start: number;
  page_end: number;
  text: string;
  effective_date: string | null;
  final_pdf_url: string | null;
  official_landing_url: string | null;
  source_sha256: string;
  score: number;
}

export class CorpusIndexRetriever implements RagRetriever {
  private readonly database: DatabaseSync;
  private readonly statement: ReturnType<DatabaseSync['prepare']>;
  private readonly scopedStatement: ReturnType<DatabaseSync['prepare']>;
  private readonly definitionStatement: ReturnType<DatabaseSync['prepare']>;
  private readonly documents = new Map<string, DocumentVersion>();
  private cachedStatus: RagCorpusStatus | null = null;

  private readonly databasePath: string;

  constructor(
    databasePath: string,
    private readonly indexedAt: string,
  ) {
    this.databasePath = resolve(databasePath);
    if (!existsSync(this.databasePath))
      throw new Error(`Corpus index not found at ${this.databasePath}; run pnpm ingest`);
    this.database = new DatabaseSync(this.databasePath, { readOnly: true });
    // BM25 over title (weight 6) and text (weight 1); metadata-only and very
    // short chunks are pushed down.
    this.statement = this.database.prepare(`
      SELECT c.chunk_id, c.document_id, c.title, c.authority, c.page_start, c.page_end, c.text,
             c.effective_date, c.final_pdf_url, c.official_landing_url, c.source_sha256,
             bm25(corpus_chunks_fts, 0, 6, 1, 0.5, 0.5, 0.5)
               + CASE WHEN c.content_kind = 'metadata_only' THEN 20 WHEN length(c.text) < 120 THEN 20 WHEN length(c.text) < 300 THEN 8 ELSE 0 END AS score
      FROM corpus_chunks_fts
      JOIN corpus_chunks c ON c.chunk_id = corpus_chunks_fts.chunk_id
      WHERE corpus_chunks_fts MATCH ? AND (? IS NULL OR c.legal_category = ?)
      ORDER BY score
      LIMIT ?
    `);
    this.scopedStatement = this.database.prepare(`
      SELECT c.chunk_id, c.document_id, c.title, c.authority, c.page_start, c.page_end, c.text,
             c.effective_date, c.final_pdf_url, c.official_landing_url, c.source_sha256,
             bm25(corpus_chunks_fts, 0, 6, 1, 0.5, 0.5, 0.5)
               + CASE WHEN c.content_kind = 'metadata_only' THEN 20 WHEN length(c.text) < 120 THEN 20 WHEN length(c.text) < 300 THEN 8 ELSE 0 END AS score
      FROM corpus_chunks_fts
      JOIN corpus_chunks c ON c.chunk_id = corpus_chunks_fts.chunk_id
      WHERE corpus_chunks_fts MATCH ? AND c.document_id IN (SELECT value FROM json_each(?))
      ORDER BY score
      LIMIT ?
    `);
    this.definitionStatement = this.database.prepare(`
      SELECT c.chunk_id, c.document_id, c.title, c.authority, c.page_start, c.page_end, c.text,
             c.effective_date, c.final_pdf_url, c.official_landing_url, c.source_sha256, 0 AS score
      FROM corpus_chunks c
      WHERE c.document_id IN (SELECT value FROM json_each(?)) AND lower(c.text) LIKE ?
        AND (lower(c.text) LIKE '%means%' OR lower(c.text) LIKE '%includes%')
      ORDER BY c.page_start
      LIMIT 40
    `);
    for (const row of this.database
      .prepare('SELECT document_id, title, relative_file_path FROM corpus_documents')
      .all() as Array<{ document_id: string; title: string; relative_file_path: string }>)
      this.documents.set(row.document_id, documentVersion(row.title, row.relative_file_path));
    // Titles taken from file names often omit the Act's year ("CGST-Act-
    // Updated-31082021"). Such a family joins the dated family of the same
    // name only when exactly one year exists, so for example the Income-tax
    // Acts of 1961 and 2025 stay separate.
    const years = new Map<string, Set<string>>();
    for (const { family } of this.documents.values()) {
      const match = /^(.*) ((?:19|20)\d{2})$/u.exec(family);
      if (match) years.set(match[1]!, (years.get(match[1]!) ?? new Set()).add(match[2]!));
    }
    for (const version of this.documents.values()) {
      const only = years.get(version.family);
      if (only?.size === 1) version.family = `${version.family} ${[...only][0]!}`;
    }
  }

  async status(): Promise<RagCorpusStatus> {
    if (this.cachedStatus) return this.cachedStatus;
    const { documents } = this.database
      .prepare('SELECT COUNT(*) AS documents FROM corpus_documents')
      .get() as { documents: number };
    const categories = this.database
      .prepare(
        'SELECT legal_category AS category, COUNT(DISTINCT document_id) AS documents, COUNT(*) AS chunks FROM corpus_chunks GROUP BY legal_category ORDER BY documents DESC',
      )
      .all() as Array<{ category: string; documents: number; chunks: number }>;
    this.cachedStatus = {
      state: Number(documents) > 0 ? 'ready' : 'not_ready',
      indexSchemaVersion: 'legal-bot-corpus-index-v1',
      lastSuccessfulIngestionAt: this.indexedAt,
      categories: categories.map((item) => ({
        category: item.category,
        documents: Number(item.documents),
        chunks: Number(item.chunks),
        state: 'enabled' as const,
      })),
      limitations: [
        `Corpus index of ${Number(documents)} documents.`,
        'Every document has legalStatus "unknown"; currentness is not verified.',
      ],
    };
    return this.cachedStatus;
  }

  // Reads the index file once so the operating system caches it and the first
  // real question does not pay a cold-start cost (~20 s on a 723 MB index).
  // The read is asynchronous, so the server keeps answering while it runs.
  // Best effort: errors are ignored. Resolves to the elapsed milliseconds.
  async warmUp(): Promise<number> {
    const started = performance.now();
    try {
      for await (const chunk of createReadStream(this.databasePath, {
        highWaterMark: 4 * 1024 * 1024,
      }))
        void chunk;
    } catch {
      // Warm-up is best effort.
    }
    return performance.now() - started;
  }

  async search(input: RagQueryInput, signal?: AbortSignal): Promise<RagEvidence[]> {
    signal?.throwIfAborted();
    const inferred = inferLegalCategory(input.question);
    // Out-of-area guard: with no category chosen, a question that matches none
    // of the corpus's legal areas (for example passports or labour law) gets
    // no evidence, so the service abstains instead of answering from loosely
    // related documents.
    if (input.legalCategory === 'all' && inferred === undefined) return [];
    const category =
      input.legalCategory === 'all'
        ? (inferred ?? null)
        : input.legalCategory === 'corporate'
          ? 'companies'
          : input.legalCategory;
    const limit = input.resultLimit;
    // Over-fetch so unusable chunks (Hindi-dominant text for an English
    // question, legacy-font garbling, near-empty pages) and superseded
    // versions can be dropped while still filling the evidence budget.
    const pool = Math.min(80, limit * 6);
    const hindiQuestion = isDevanagariDominant(input.question);
    const usable = (row: Row) => hindiQuestion || textQuality(row.text) === 'usable';
    const candidates: Row[] = [];
    const seen = new Set<string>();
    const add = (row: Row) => {
      if (seen.has(row.chunk_id) || !usable(row)) return;
      seen.add(row.chunk_id);
      candidates.push(row);
    };

    // Named-instrument routing: when the question names an Act, Rules,
    // Regulations or Code that exists in the corpus as its own document, that
    // instrument's pages are searched first and may fill up to half the
    // budget. Circulars whose titles merely mention the Act do not match.
    const named = this.namedInstrumentDocuments(input.question);
    // Definition questions ("Who is a taxable person under the CGST Act?")
    // need the page that defines the term, which keyword ranking misses when
    // every page of the Act uses the term. Pages of the named instrument that
    // print the term as a definition ('"taxable person" means') come first.
    const term = definedTermAsked(input.question);
    if (term && named.length > 0) {
      const pattern = new RegExp(
        `[“"―‖'‘]\\s*${term.replace(/[^a-z0-9 ]/gu, '').replace(/ /gu, '\\s+')}\\s*[”"‖’']\\s*(?:,[^,]{0,60},\\s*)?(?:means|includes)\\b`,
        'iu',
      );
      for (const row of this.definitionStatement.all(
        JSON.stringify(named.slice(0, 3)),
        `%${term.split(' ')[0]}%`,
      ) as unknown as Row[])
        if (pattern.test(row.text.normalize('NFKC'))) add(row);
    }
    if (named.length > 0)
      for (const operator of ['AND', 'OR'] as const)
        for (const row of this.scopedStatement.all(
          buildFtsQuery(input.question, operator),
          JSON.stringify(named),
          pool,
        ) as unknown as Row[])
          add(row);
    const routed = candidates.length;
    for (const operator of ['AND', 'OR'] as const)
      for (const row of this.statement.all(
        buildFtsQuery(input.question, operator),
        category,
        category,
        pool,
      ) as unknown as Row[])
        add(row);

    // Version preference: when several dated versions of one instrument are
    // candidates (for example CGST Act consolidations of 2020, 2021 and
    // 2022), only the newest version's pages are kept.
    const newest = new Map<string, { date: number; documentId: string }>();
    for (const row of candidates) {
      const version = this.documents.get(row.document_id);
      if (!version?.date) continue;
      const best = newest.get(version.family);
      if (!best || version.date > best.date)
        newest.set(version.family, { date: version.date, documentId: row.document_id });
    }
    const isCurrent = (row: Row) => {
      const version = this.documents.get(row.document_id);
      return !version?.date || newest.get(version.family)?.documentId === row.document_id;
    };
    // Inside a named instrument every page repeats the instrument's own words,
    // so keyword ranking alone favours arbitrary pages. Pages whose section
    // headings ("7. Designated partners.—") share words with the question come
    // first, and arrangement-of-sections (table of contents) pages come last.
    // The same ordering is applied to general results, where the question
    // does not name an Act ("How many designated partners must an LLP have?").
    const questionWords = headingWords(input.question);
    const byHeading = (rows: Row[]) =>
      rows
        .map((row, index) => ({
          row,
          index,
          toc: /arrangement\s+of\s+sections/iu.test(row.text) ? 1 : 0,
          heading: headingMatch(row.text, questionWords),
        }))
        .sort(
          (left, right) =>
            left.toc - right.toc || right.heading - left.heading || left.index - right.index,
        )
        .map((item) => item.row);
    const routedRows = byHeading(candidates.slice(0, routed).filter(isCurrent));
    const generalRows = byHeading(candidates.slice(routed).filter(isCurrent));
    const half = Math.ceil(limit / 2);
    const rows = [...routedRows.slice(0, half), ...generalRows, ...routedRows.slice(half)].slice(
      0,
      limit,
    );
    const requestedSection = extractSection(input.question);
    return rows.map((row) => {
      const source = row.final_pdf_url ?? row.official_landing_url;
      const namesSection =
        requestedSection !== null &&
        new RegExp(`\\bsection\\s+${requestedSection}\\b`, 'iu').test(`${row.title}\n${row.text}`);
      return {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        authority: row.authority,
        sectionIdentifier: namesSection ? requestedSection! : `Page ${row.page_start}`,
        sectionHeading: null,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        officialSourceUrl: source && /^https:\/\//iu.test(source) ? source : null,
        effectiveDate: row.effective_date,
        retrievalDate: this.indexedAt,
        sha256: row.source_sha256,
        legalStatus: 'unknown' as const,
        text: row.text,
        score: Number.isFinite(row.score) ? -row.score : 0,
      };
    });
  }

  // Documents whose own title is the instrument the question names (after
  // removing version dates), newest version first.
  private namedInstrumentDocuments(question: string): string[] {
    const names = instrumentNames(question);
    if (names.length === 0) return [];
    const matches: Array<{ documentId: string; date: number }> = [];
    for (const [documentId, version] of this.documents)
      if (
        names.some(
          (name) =>
            version.family === name ||
            (!/ (?:19|20)\d{2}$/u.test(name) &&
              version.family.replace(/ (?:19|20)\d{2}$/u, '') === name),
        )
      )
        matches.push({ documentId, date: version.date ?? 0 });
    return matches.sort((left, right) => right.date - left.date).map((item) => item.documentId);
  }

  close(): void {
    this.database.close();
  }
}

const HEADING_STOP_WORDS = new Set([
  'what',
  'which',
  'when',
  'where',
  'must',
  'shall',
  'have',
  'does',
  'under',
  'with',
  'from',
  'that',
  'this',
  'many',
  'much',
  'there',
  'their',
  'india',
]);

function headingWords(text: string): Set<string> {
  return new Set(
    (text.toLocaleLowerCase('en-US').match(/[a-z]{4,}/gu) ?? [])
      .filter((word) => !HEADING_STOP_WORDS.has(word))
      .map((word) => word.replace(/(?:ies|es|s)$/u, '')),
  );
}

// Largest number of question words found in one heading on the page. Headings
// are section titles "<number>. <Title>.—" and defined terms
// '(v) "person resident in India" means' as printed in Indian statutes.
export function headingMatch(text: string, questionWords: ReadonlySet<string>): number {
  let best = 0;
  const normalized = text.normalize('NFKC');
  const headings = [
    ...normalized.matchAll(
      /(?:^|\s)\d{1,3}[A-Z]{0,2}\.\s+([A-Z][A-Za-z ,'()-]{2,90}?)\s*\.?\s*[—–-]/gu,
    ),
    ...normalized.matchAll(
      /[“"―‖]\s*([A-Za-z][A-Za-z ,'()-]{2,80}?)\s*[”"‖’]\s*(?:,[^,]{0,60},\s*)?(?:means|includes)\b/gu,
    ),
  ];
  for (const match of headings) {
    const words = headingWords(match[1]!);
    let shared = 0;
    for (const word of words) if (questionWords.has(word)) shared += 1;
    best = Math.max(best, shared);
  }
  return best;
}

interface DocumentVersion {
  // Normalized title with version dates and "as amended/updated" phrases removed.
  family: string;
  // Version date as yyyymmdd when the title or file name states one.
  date: number | null;
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

// Parses a version family and date from a document title and file name, for
// example "CGST Act, 2017 as amended up to 01.01.2022" or
// "CGST-Act-Updated-31082021.pdf" (family "cgst act 2017", date 20220101).
export function documentVersion(title: string, relativePath: string): DocumentVersion {
  const source = `${title} ${relativePath.split('/').pop() ?? ''}`;
  let date: number | null = null;
  const numeric = /(?:^|\D)(\d{2})[.\-/]?(\d{2})[.\-/]?((?:19|20)\d{2})(?!\d)/u.exec(source);
  if (numeric) {
    const [day, month, year] = [Number(numeric[1]), Number(numeric[2]), Number(numeric[3])];
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12)
      date = year * 10_000 + month * 100 + day;
  }
  if (date === null) {
    const worded =
      /\b(\d{1,2})?(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*(\d{1,2})?,?\s*((?:19|20)\d{2})\b/iu.exec(
        source,
      );
    if (worded)
      date =
        Number(worded[4]) * 10_000 +
        MONTHS[worded[2]!.toLowerCase()]! * 100 +
        Number(worded[1] ?? worded[3] ?? 1);
  }
  const family = normalizeTitle(
    title
      .replace(/\.pdf$/iu, '')
      .replace(
        /\s*[([]?\s*(?:up\s*to|upto|updated(?:\s+as)?\s+on|last\s+amended\s+on|as\s+amended\s+(?:up\s*to|by)|as\s+on)\b.*$/iu,
        '',
      )
      .replace(/(?:^|[-_\s])\d{8}(?=[-_\s]|$)/gu, ' ')
      .replace(/[-_]?\b(?:updated|amended)\b/giu, ' '),
  )
    .replace(/^the\s+/u, '')
    // "CGST-Rules-2017-Part-A-Rules" and "CGST-Rules-2017-amended_Part-A" are
    // one family; repeated words are dropped so they compare equal.
    .split(' ')
    .filter((word, index, words) => words.indexOf(word) === index)
    .join(' ');
  return { family, date };
}

function normalizeTitle(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/([a-z])([A-Z])/gu, '$1 $2')
    .replace(/([A-Za-z])(\d)/gu, '$1 $2')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z0-9]+/gu, ' ')
    .trim();
}

// The term a definition question asks about: "Who is a taxable person under
// ..." -> "taxable person"; "What does 'tax year' mean ..." -> "tax year".
export function definedTermAsked(question: string): string | null {
  const text = question.normalize('NFKC').replace(/[“”"‘’']/gu, '');
  const match =
    /\b(?:who|what)\s+(?:is|are)\s+(?:an?\s+|the\s+)?([a-z][a-z -]{2,60}?)\s+(?:under|in|as per|according to|for the purposes of)\b/iu.exec(
      text,
    ) ??
    /\bwhat\s+does\s+(?:an?\s+|the\s+)?([a-z][a-z -]{2,60}?)\s+mean\b/iu.exec(text) ??
    /\b(?:meaning|definition)\s+of\s+(?:an?\s+|the\s+)?([a-z][a-z -]{2,60}?)(?:\s+(?:under|in)\b|[?.]|$)/iu.exec(
      text,
    );
  const term = match?.[1]?.trim().toLocaleLowerCase('en-US') ?? null;
  return term && term.split(' ').length <= 6 ? term : null;
}

// Standard abbreviations of Indian legal instruments, expanded to the words
// their official titles use (parentheses dropped, as in normalized titles).
// Only abbreviations seen in the development sets are listed.
const INSTRUMENT_ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bNCLT\b/gu, 'National Company Law Tribunal'],
  [
    /\bCIRP Regulations\b/gu,
    'IBBI Insolvency Resolution Process for Corporate Persons Regulations',
  ],
  [
    /\b(?:SEBI )?LODR Regulations\b/gu,
    'Securities and Exchange Board of India Listing Obligations and Disclosure Requirements Regulations',
  ],
  [
    /\b(?:SEBI )?(?:PIT|Insider Trading) Regulations\b/gu,
    'Securities and Exchange Board of India Prohibition of Insider Trading Regulations',
  ],
  [/\bFEMA\b(?= [A-Z(])/gu, 'Foreign Exchange Management'],
];

// Instrument names a question mentions, such as "Limited Liability Partnership
// Act, 2008" or "CGST Act", normalized like titles (with and without year).
export function instrumentNames(question: string): string[] {
  const names = new Set<string>();
  const pattern =
    /((?:[A-Z][A-Za-z-]*\s+)(?:(?:[A-Z][A-Za-z-]*|of|and|for|the)\s+)*?(?:Act|Rules|Regulations|Code))(?:,?\s*((?:19|20)\d{2}))?/gu;
  // Users write "NCLT Rules" or "LODR Regulations"; titles spell them out.
  // Both the question as written and with standard abbreviations expanded are
  // matched.
  const normalized = question.normalize('NFKC');
  const expanded = INSTRUMENT_ABBREVIATIONS.reduce(
    (text, [pattern, full]) => text.replace(pattern, full),
    normalized,
  );
  for (const match of [...normalized.matchAll(pattern), ...expanded.matchAll(pattern)]) {
    const base = normalizeTitle(match[1]!)
      .replace(/^(?:under|as of|as per|per|in|what|how|does|do|is|are|can)\s+/u, '')
      .replace(/^the\s+/u, '');
    if (base.split(' ').length < 2) continue;
    names.add(match[2] ? `${base} ${match[2]}` : base);
  }
  return [...names];
}

// Text-quality screen for extracted PDF text. Hindi (Devanagari) text is valid
// law but cannot answer an English question; legacy-font extraction produces
// Latin-letter garbage such as "Hkkx" for Hindi; near-empty chunks carry no
// provisions.
export function textQuality(text: string): 'usable' | 'devanagari' | 'garbled' | 'near_empty' {
  const devanagari = (text.match(/[ऀ-ॿ]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length;
  if (devanagari + latin < 50) return 'near_empty';
  if (devanagari / (devanagari + latin) > 0.3) return 'devanagari';
  const words = text.match(/[A-Za-z]{3,}/gu) ?? [];
  const legacy = words.filter((word) => LEGACY_FONT_WORD.test(word)).length;
  if (words.length > 0 && legacy / words.length > 0.08) return 'garbled';
  return 'usable';
}

function isDevanagariDominant(text: string): boolean {
  const devanagari = (text.match(/[ऀ-ॿ]/gu) ?? []).length;
  const latin = (text.match(/[A-Za-z]/gu) ?? []).length;
  return devanagari > latin;
}

// Common Kruti Dev style transliteration artefacts for Hindi words
// (for example "Hkkx", "vf/kfu;e", "ljdkj", "izkf/kdkj").
const LEGACY_FONT_WORD =
  /^(?:Hkk[a-z]*|[a-z]*kk[A-Z][a-z]*|ljdkj|dEiuh|izk[a-z]*|[a-z]*[A-Z][a-z]*[A-Z][a-z]*)$/u;
