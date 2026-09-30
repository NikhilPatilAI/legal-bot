import type { LegalChunk } from '../ingestion/legal-section-chunker.js';
import type { RagCorpusStatus, RagEvidence, RagQueryInput, RagRetriever } from '../rag-service.js';
import { normalizeTerm, type DefinitionClause, type ProvisionGraph } from './provision-graph.js';

// Connected-provision expansion for any configured retriever.
//
// The base retriever's ranking is kept; this decorator only reserves part of the
// SAME evidence budget for provisions linked to the top-ranked sections:
//   - Section 2 definitions of terms that appear in both the question and the
//     provision text (so "small company" in a Section 173 question pulls in
//     Section 2(85) and its proviso, not an arbitrary block of definitions);
//   - sections the provision cross-references, ranked by overlap with the
//     question.
// Expansion only uses provisions from the same document as the base evidence,
// so jurisdiction/category scope checks made by the base retriever carry over.
// Parsed links are navigational: a cross-reference is not proof that the linked
// text is an exception, and the evaluation reports cases where expansion hurts.

export interface ProvisionExpansionOptions {
  // Maximum share of the evidence budget used for linked provisions.
  maxExpansionShare?: number;
  // How many of the top-ranked base sections are expanded.
  expandTopSections?: number;
  maxDefinitionsPerSection?: number;
  maxCrossReferencesPerSection?: number;
}

const GENERIC_TERMS = new Set([
  'company',
  'companies',
  'board',
  'board of directors',
  'director',
  'member',
  'members',
  'prescribed',
  'tribunal',
  'registrar',
  'share',
  'person',
  'officer',
  'section',
  'financial year',
]);

export class ProvisionExpansionRetriever implements RagRetriever {
  private readonly maxExpansionShare: number;
  private readonly expandTopSections: number;
  private readonly maxDefinitionsPerSection: number;
  private readonly maxCrossReferencesPerSection: number;

  constructor(
    private readonly base: RagRetriever,
    private readonly graph: ProvisionGraph,
    private readonly retrievedAt: string,
    options: ProvisionExpansionOptions = {},
  ) {
    this.maxExpansionShare = options.maxExpansionShare ?? 0.5;
    this.expandTopSections = options.expandTopSections ?? 2;
    this.maxDefinitionsPerSection = options.maxDefinitionsPerSection ?? 2;
    this.maxCrossReferencesPerSection = options.maxCrossReferencesPerSection ?? 2;
    if (this.maxExpansionShare < 0 || this.maxExpansionShare > 0.75)
      throw new Error('maxExpansionShare must be within [0, 0.75]');
  }

  async status(): Promise<RagCorpusStatus> {
    const status = await this.base.status();
    return {
      ...status,
      indexSchemaVersion: `${status.indexSchemaVersion}+provision-expansion`,
      limitations: [
        ...status.limitations,
        'Linked definitions and cross-referenced provisions are parsed from the source text; a parsed link does not establish that the linked provision is a legally verified exception.',
      ],
    };
  }

  async search(input: RagQueryInput, signal?: AbortSignal): Promise<RagEvidence[]> {
    const primary = await this.base.search(input, signal);
    signal?.throwIfAborted();
    const budget = input.resultLimit;
    if (primary.length === 0 || budget < 2) return primary.slice(0, budget);
    const documentId = this.graph.documentId;

    const topSections: string[] = [];
    for (const item of primary) {
      const section = item.sectionIdentifier.toUpperCase();
      if (item.documentId !== documentId || topSections.includes(section)) continue;
      topSections.push(section);
      if (topSections.length >= this.expandTopSections) break;
    }
    const present = new Set(primary.slice(0, budget).map((item) => item.chunkId));
    const presentSections = new Set(
      primary.slice(0, budget).map((item) => item.sectionIdentifier.toUpperCase()),
    );
    const questionTerms = normalizeTerm(input.question);
    const questionTokens = new Set(questionTerms.split(' ').filter((token) => token.length >= 4));

    const expansions: RagEvidence[] = [];
    for (const [rank, section] of topSections.entries()) {
      const sectionText = primary
        .filter((item) => item.sectionIdentifier.toUpperCase() === section)
        .map((item) => item.text)
        .join('\n');
      for (const definition of this.definitionsFor(sectionText, questionTerms)) {
        const chunkId = `${definition.chunk.chunkId}#def-${definition.clause}`;
        if (present.has(chunkId)) continue;
        present.add(chunkId);
        expansions.push(this.definitionEvidence(definition, chunkId, section, 300 - rank));
      }
      const references = this.graph
        .crossReferences(section)
        .filter((reference) => !presentSections.has(reference))
        .map((reference) => ({ reference, chunk: this.graph.representative(reference) }))
        .filter((item): item is { reference: string; chunk: LegalChunk } => item.chunk !== null)
        .map((item) => ({ ...item, overlap: overlap(item.chunk, questionTokens) }))
        .filter((item) => item.overlap > 0)
        .sort((left, right) => right.overlap - left.overlap)
        .slice(0, this.maxCrossReferencesPerSection);
      for (const { chunk } of references) {
        if (present.has(chunk.chunkId)) continue;
        present.add(chunk.chunkId);
        expansions.push(this.chunkEvidence(chunk, section, 200 - rank));
      }
    }

    const reserved = Math.min(expansions.length, Math.floor(budget * this.maxExpansionShare));
    return [...primary.slice(0, budget - reserved), ...expansions.slice(0, reserved)];
  }

  // Definitions for defined terms that occur in the provision text and in the
  // question. Longer (more specific) terms are preferred; generic terms that
  // appear in almost every provision are skipped.
  private definitionsFor(sectionText: string, questionTerms: string): DefinitionClause[] {
    const provision = normalizeTerm(sectionText);
    const matches: DefinitionClause[] = [];
    for (const [term, clause] of this.graph.definitionIndex()) {
      if (GENERIC_TERMS.has(term)) continue;
      const pattern = new RegExp(`\\b${term.replaceAll(' ', '\\s+')}\\b`, 'u');
      if (pattern.test(questionTerms) && pattern.test(provision)) matches.push(clause);
    }
    return matches
      .sort((left, right) => right.term.length - left.term.length)
      .slice(0, this.maxDefinitionsPerSection);
  }

  private definitionEvidence(
    definition: DefinitionClause,
    chunkId: string,
    linkedFrom: string,
    score: number,
  ): RagEvidence {
    return {
      ...this.chunkEvidence(definition.chunk, linkedFrom, score),
      chunkId,
      sectionHeading: `Definitions: "${definition.term}" (linked definition for Section ${linkedFrom})`,
      text: definition.text,
    };
  }

  private chunkEvidence(chunk: LegalChunk, linkedFrom: string, score: number): RagEvidence {
    return {
      chunkId: chunk.chunkId,
      documentId: chunk.documentId,
      title: chunk.actOrRegulation,
      authority: chunk.authority,
      sectionIdentifier: chunk.sectionNumber,
      sectionHeading: `${chunk.sectionHeading} (provision cross-referenced by Section ${linkedFrom})`,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      officialSourceUrl: chunk.officialSourceUrl,
      effectiveDate: chunk.effectiveDate,
      retrievalDate: this.retrievedAt,
      sha256: chunk.sha256,
      legalStatus: chunk.legalStatus,
      text: chunk.text,
      score,
    };
  }
}

function overlap(chunk: LegalChunk, questionTokens: ReadonlySet<string>): number {
  const text = normalizeTerm(`${chunk.sectionHeading} ${chunk.text}`);
  let count = 0;
  for (const token of questionTokens) if (text.includes(token)) count += 1;
  return count;
}
