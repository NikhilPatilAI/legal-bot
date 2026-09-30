import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import { legalChunkSchema, type LegalChunk } from '../ingestion/legal-section-chunker.js';

// A read-only index over parsed legal-section chunks. It answers the questions a
// connected-provision retriever needs: which chunks belong to a section, what
// the section's cross-references and defined terms are, and which sections a
// definition chunk points back into. The graph is deterministic and pure so it
// can be reused by both the retriever and the evaluation harness.

export const provisionCorpusSchema = z
  .object({
    schemaVersion: z.string().min(1),
    documentId: z.string().regex(/^legal_[a-f0-9]{24}$/),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    chunks: z.array(legalChunkSchema).min(1),
  })
  .strict();

export type ProvisionCorpus = z.infer<typeof provisionCorpusSchema>;

const DEFINITIONS_SECTION = '2';

export class ProvisionGraph {
  private readonly bySection = new Map<string, LegalChunk[]>();
  private readonly definitionTargets = new Set<string>();

  constructor(readonly chunks: readonly LegalChunk[]) {
    for (const chunk of chunks) {
      const key = chunk.sectionNumber.toUpperCase();
      const list = this.bySection.get(key);
      if (list) list.push(chunk);
      else this.bySection.set(key, [chunk]);
      if (key === DEFINITIONS_SECTION)
        for (const reference of chunk.crossReferences)
          this.definitionTargets.add(reference.toUpperCase());
    }
    for (const list of this.bySection.values())
      list.sort((left, right) => pieceOrder(left) - pieceOrder(right));
  }

  static async fromFile(corpusPath: string): Promise<ProvisionGraph> {
    const parsed = provisionCorpusSchema.parse(
      JSON.parse(await readFile(resolve(corpusPath), 'utf8')),
    );
    return new ProvisionGraph(parsed.chunks);
  }

  static fromFileSync(corpusPath: string): ProvisionGraph {
    return new ProvisionGraph(
      provisionCorpusSchema.parse(JSON.parse(readFileSync(resolve(corpusPath), 'utf8'))).chunks,
    );
  }

  hasSection(section: string): boolean {
    return this.bySection.has(section.toUpperCase());
  }

  sectionChunks(section: string): LegalChunk[] {
    return this.bySection.get(section.toUpperCase()) ?? [];
  }

  representative(section: string): LegalChunk | null {
    return this.sectionChunks(section)[0] ?? null;
  }

  crossReferences(section: string): string[] {
    const references = new Set<string>();
    for (const chunk of this.sectionChunks(section))
      for (const reference of chunk.crossReferences) {
        const key = reference.toUpperCase();
        if (key !== section.toUpperCase() && this.bySection.has(key)) references.add(key);
      }
    return [...references].sort(numericSectionOrder);
  }

  // Section 2 (Definitions) usually applies whenever a defined term is used.
  // When the definitions provision explicitly cross-references a section, that
  // is the strongest signal that its defined terms bear on that section.
  definitionsFor(section: string): LegalChunk[] {
    if (section.toUpperCase() === DEFINITIONS_SECTION) return [];
    if (!this.definitionTargets.has(section.toUpperCase())) return [];
    // Return a single representative definitions chunk. Section 2 is split into
    // several chunks, and emitting all of them would crowd out the exception
    // and cross-referenced provisions that matter more for most questions.
    const first = this.sectionChunks(DEFINITIONS_SECTION)[0];
    return first ? [first] : [];
  }

  sectionCount(): number {
    return this.bySection.size;
  }

  get documentId(): string | null {
    return this.chunks[0]?.documentId ?? null;
  }

  // Index of Section 2 clauses keyed by the defined term, built lazily. Each
  // entry is the verbatim clause text (including any proviso inside it) and the
  // chunk it came from, so a definition can be cited precisely.
  definitionIndex(): ReadonlyMap<string, DefinitionClause> {
    if (this.definitions) return this.definitions;
    const index = new Map<string, DefinitionClause>();
    for (const chunk of this.sectionChunks(DEFINITIONS_SECTION)) {
      const clauses = chunk.text.split(/\n(?=\(\d{1,3}[A-Z]{0,2}\)\s)/u);
      for (const clause of clauses) {
        const head = /^\((\d{1,3}[A-Z]{0,2})\)\s*(.{0,160})/su.exec(clause);
        if (!head) continue;
        const terms = [
          ...head[2]!.matchAll(/(?:[―“"‘]|̳)+\s*([A-Za-z][A-Za-z '-]{1,60}?)\s*[‖”"‘’]+/gu),
        ]
          .map((match) => normalizeTerm(match[1]!))
          .filter((term) => term.length >= 3);
        if (terms.length === 0 || !/\b(?:means|includes)\b/u.test(clause.slice(0, 300))) continue;
        for (const term of terms)
          if (!index.has(term))
            index.set(term, {
              term,
              clause: head[1]!,
              text: `Section 2(${head[1]!}) — Definitions\n${clause.trim()}`,
              chunk,
            });
      }
    }
    this.definitions = index;
    return index;
  }

  private definitions: Map<string, DefinitionClause> | null = null;
}

export interface DefinitionClause {
  term: string;
  clause: string;
  text: string;
  chunk: LegalChunk;
}

export function normalizeTerm(term: string): string {
  return term
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^a-z ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function pieceOrder(chunk: LegalChunk): number {
  const subsection = chunk.subsection ? Number.parseInt(chunk.subsection, 10) : 0;
  return Number.isFinite(subsection) ? subsection : 0;
}

function numericSectionOrder(left: string, right: string): number {
  const leftNumber = Number.parseInt(left, 10);
  const rightNumber = Number.parseInt(right, 10);
  return leftNumber - rightNumber || left.localeCompare(right);
}
