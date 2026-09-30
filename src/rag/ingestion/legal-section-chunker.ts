import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { ExtractedDocument } from './document-extractor.js';
import type { SourceManifest } from './source-manifest.js';

const sectionNumberPattern = /^\d{1,3}[A-Z]{0,3}$/;

export const legalChunkSchema = z
  .object({
    chunkId: z.string().regex(/^chunk_[a-f0-9]{32}$/),
    documentId: z.string().regex(/^legal_[a-f0-9]{24}$/),
    actOrRegulation: z.string().min(1),
    chapter: z.string().nullable(),
    part: z.string().nullable(),
    sectionNumber: z.string().regex(sectionNumberPattern),
    sectionHeading: z.string().min(1),
    subsection: z.string().nullable(),
    clause: z.string().nullable(),
    pageStart: z.number().int().positive(),
    pageEnd: z.number().int().positive(),
    text: z.string().min(1),
    effectiveDate: z.string().nullable(),
    legalStatus: z.enum(['current', 'historical', 'amended', 'superseded', 'unknown']),
    authority: z.string().min(1),
    officialSourceUrl: z.url(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    parentChunkId: z
      .string()
      .regex(/^parent_[a-f0-9]{32}$/)
      .nullable(),
    crossReferences: z.array(z.string().regex(sectionNumberPattern)),
  })
  .strict()
  .refine((chunk) => chunk.pageEnd >= chunk.pageStart, {
    message: 'pageEnd must not precede pageStart',
  });

export type LegalChunk = z.infer<typeof legalChunkSchema>;

export interface ChunkingOptions {
  maxCharacters?: number;
}

interface SectionSpan {
  sectionNumber: string;
  heading: string;
  body: string;
  chapter: string | null;
  pageStart: number;
  pageEnd: number;
}

interface LocatedText {
  text: string;
  pageAt(offset: number): number;
}

export function createLegalChunks(
  manifest: SourceManifest,
  extracted: ExtractedDocument,
  options: ChunkingOptions = {},
): LegalChunk[] {
  if (manifest.documentId !== extracted.documentId || manifest.sha256 !== extracted.sourceSha256) {
    throw new Error('Manifest and extracted document identity do not match');
  }
  const maxCharacters = options.maxCharacters ?? 5_000;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 500)
    throw new Error('maxCharacters must be an integer of at least 500');

  const sections = parseSections(extracted);
  if (sections.length === 0) throw new Error('No operative legal sections were detected');

  return sections.flatMap((section) => chunkSection(manifest, section, maxCharacters));
}

export function parseSections(extracted: ExtractedDocument): SectionSpan[] {
  const located = joinPages(extracted);
  const candidates = [
    ...located.text.matchAll(
      /(?:^|\n)(\d{1,3}[A-Z]{0,3})\.\s+([^\n]{2,260}?)\.\s*(?:—|–|\uFFFD)\s*/gu,
    ),
  ];
  const firstOperative = candidates.findIndex((match) => match[1] === '1');
  if (firstOperative < 0) return [];

  const operative: RegExpMatchArray[] = [];
  let previousNumber = 0;
  for (const candidate of candidates.slice(firstOperative)) {
    const candidateNumber = Number.parseInt(candidate[1] ?? '', 10);
    if (!Number.isFinite(candidateNumber) || candidateNumber < previousNumber) continue;
    operative.push(candidate);
    previousNumber = candidateNumber;
  }
  return operative
    .map((match, index) => {
      const sectionNumber = match[1];
      const heading = match[2]?.trim();
      if (!sectionNumber || !heading || match.index === undefined)
        throw new Error('Malformed section heading match');
      const start = match.index + match[0].indexOf(sectionNumber);
      const end = operative[index + 1]?.index ?? located.text.length;
      const bodyStart = match.index + match[0].length;
      const text = cleanSectionText(located.text.slice(bodyStart, end));
      return {
        sectionNumber,
        heading,
        body: text,
        chapter: findChapter(located.text.slice(0, start)),
        pageStart: located.pageAt(start),
        pageEnd: located.pageAt(Math.max(start, end - 1)),
      };
    })
    .filter(
      (section, index, all) =>
        index === 0 || section.sectionNumber !== all[index - 1]?.sectionNumber,
    );
}

function chunkSection(
  manifest: SourceManifest,
  section: SectionSpan,
  maxCharacters: number,
): LegalChunk[] {
  const prefix = `Section ${section.sectionNumber} — ${section.heading}\n`;
  const units = splitAtSubsections(section.body);
  const pieces: string[] = [];
  let current = '';

  for (const unit of units) {
    if (current && `${prefix}${current}\n${unit}`.length > maxCharacters) {
      pieces.push(current.trim());
      current = unit;
    } else {
      current = current ? `${current}\n${unit}` : unit;
    }
  }
  if (current) pieces.push(current.trim());

  const parentChunkId =
    pieces.length > 1
      ? deterministicId('parent', [
          manifest.documentId,
          manifest.sha256 ?? '',
          section.sectionNumber,
        ])
      : null;
  return pieces.map((piece, index) => {
    const text = `${prefix}${piece}`.trim();
    const subsection = /^\((\d+[A-Z]?)\)/u.exec(piece)?.[1] ?? null;
    return legalChunkSchema.parse({
      chunkId: deterministicId('chunk', [
        manifest.documentId,
        manifest.sha256 ?? '',
        section.sectionNumber,
        String(index),
        text,
      ]),
      documentId: manifest.documentId,
      actOrRegulation: manifest.title,
      chapter: section.chapter,
      part: null,
      sectionNumber: section.sectionNumber,
      sectionHeading: section.heading,
      subsection,
      clause: null,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      text,
      effectiveDate: manifest.effectiveDate,
      legalStatus: manifest.legalStatus,
      authority: manifest.authority,
      officialSourceUrl: manifest.originalDownloadUrl,
      sha256: manifest.sha256,
      parentChunkId,
      crossReferences: extractCrossReferences(piece, section.sectionNumber),
    });
  });
}

function joinPages(extracted: ExtractedDocument): LocatedText {
  let text = '';
  const starts: Array<{ offset: number; pageNumber: number }> = [];
  for (const page of extracted.pages) {
    starts.push({ offset: text.length, pageNumber: page.pageNumber });
    text += `${removePageArtifacts(page.text)}\n`;
  }
  return {
    text,
    pageAt(offset) {
      let pageNumber = 1;
      for (const start of starts) {
        if (start.offset > offset) break;
        pageNumber = start.pageNumber;
      }
      return pageNumber;
    },
  };
}

function removePageArtifacts(value: string): string {
  const lines = value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !/^\d{1,4}$/.test(line) && line !== 'THE COMPANIES ACT, 2013')
    .map((line) =>
      line.replace(
        /^(\d{1,3}[A-Z]{0,3})\.\s+(\[[^\]]+\])\s+Omitted by\s+/u,
        '$1. $2. — Omitted by ',
      ),
    );

  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!/^\d{1,3}[A-Z]{0,3}\.\s+[A-Za-z[]/u.test(line) || /\.\s*(?:—|–|\uFFFD)\s*/u.test(line)) {
      output.push(line);
      continue;
    }

    let joined = line;
    let cursor = index + 1;
    while (cursor < lines.length && joined.length < 500) {
      const next = lines[cursor] ?? '';
      if (/^(?:\d{1,3}[A-Z]{0,3}\.\s|CHAPTER\b|PART\b|SCHEDULES?\b)/u.test(next)) break;
      joined += ` ${next}`;
      cursor += 1;
      if (/\.\s*(?:—|–|\uFFFD)\s*/u.test(joined)) break;
    }
    if (/\.\s*(?:—|–|\uFFFD)\s*/u.test(joined)) {
      output.push(joined);
      index = cursor - 1;
    } else {
      output.push(line);
    }
  }
  return output.join('\n');
}

function cleanSectionText(value: string): string {
  return value
    .replace(/\nCHAPTER\s+[IVXLCDM]+\b[\s\S]*$/u, '')
    .replace(/\nSCHEDULES?\b[\s\S]*$/u, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function findChapter(prefix: string): string | null {
  const matches = [...prefix.matchAll(/(?:^|\n)(CHAPTER\s+[IVXLCDM]+)\s*\n([^\n]{2,160})/gu)];
  const match = matches.at(-1);
  if (!match?.[1] || !match[2]) return null;
  const heading = match[2].trim().replace(/\b([A-Z])\s+([A-Z]{2,})\b/gu, '$1$2');
  return `${match[1]} — ${heading}`;
}

function splitAtSubsections(value: string): string[] {
  const parts = value
    .split(/(?=\s\(\d+[A-Z]?\)\s)/gu)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [value.trim()];
}

function extractCrossReferences(value: string, ownSection: string): string[] {
  const references = new Set<string>();
  for (const match of value.matchAll(
    /\bsections?\s+((?:\d{1,3}[A-Z]?(?:\s*(?:,|and|or|to|-)\s*)?)+)/giu,
  )) {
    for (const section of match[1]?.match(/\d{1,3}[A-Z]?/gu) ?? []) {
      if (section !== ownSection) references.add(section.toUpperCase());
    }
  }
  return [...references].sort(numericSectionOrder);
}

function deterministicId(prefix: 'chunk' | 'parent', values: readonly string[]): string {
  return `${prefix}_${createHash('sha256').update(values.join('\n')).digest('hex').slice(0, 32)}`;
}

function numericSectionOrder(left: string, right: string): number {
  const leftNumber = Number.parseInt(left, 10);
  const rightNumber = Number.parseInt(right, 10);
  return leftNumber - rightNumber || left.localeCompare(right);
}
