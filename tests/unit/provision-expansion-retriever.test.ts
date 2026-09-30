import { describe, expect, it } from 'vitest';

import type { LegalChunk } from '../../src/rag/ingestion/legal-section-chunker.js';
import type { RagEvidence, RagRetriever } from '../../src/rag/rag-service.js';
import { ProvisionExpansionRetriever } from '../../src/rag/retrieval/provision-expansion-retriever.js';
import { ProvisionGraph } from '../../src/rag/retrieval/provision-graph.js';

// Synthetic engineering fixtures shaped like the parsed Companies Act chunks.
function chunk(section: string, text: string, crossReferences: string[] = []): LegalChunk {
  return {
    chunkId: `chunk_${section}`,
    documentId: 'legal_fixture',
    actOrRegulation: 'Fixture Act',
    chapter: null,
    part: null,
    sectionNumber: section,
    sectionHeading: `Heading ${section}`,
    subsection: null,
    clause: null,
    pageStart: 1,
    pageEnd: 1,
    text,
    effectiveDate: null,
    legalStatus: 'unknown',
    authority: 'fixture',
    officialSourceUrl: 'https://example.gov/fixture.pdf',
    sha256: 'c'.repeat(64),
    parentChunkId: null,
    crossReferences,
  } as LegalChunk;
}

const chunks = [
  chunk(
    '2',
    'Section 2 — Definitions\n(1) ―board meeting‖ means a meeting of the Board;\n(85) ―small company‖ means a company, other than a public company, whose capital is small:\nProvided that nothing in this clause shall apply to a holding company or a subsidiary company;\n(86) ―subscribed capital‖ means capital subscribed by members;',
  ),
  chunk(
    '173',
    'Section 173 — Meetings of Board. A small company shall hold one meeting in each half of a calendar year, subject to section 174.',
    ['174'],
  ),
  chunk(
    '174',
    'Section 174 — Quorum for meetings of Board. The quorum for a meeting of the Board shall be one third of its total strength.',
  ),
  chunk('300', 'Section 300 — Unrelated provision about winding up.'),
];

function toEvidence(item: LegalChunk, score: number): RagEvidence {
  return {
    chunkId: item.chunkId,
    documentId: item.documentId,
    title: item.actOrRegulation,
    authority: item.authority,
    sectionIdentifier: item.sectionNumber,
    sectionHeading: item.sectionHeading,
    pageStart: 1,
    pageEnd: 1,
    officialSourceUrl: item.officialSourceUrl,
    effectiveDate: null,
    retrievalDate: '2026-09-28T00:00:00.000Z',
    sha256: item.sha256,
    legalStatus: 'unknown',
    text: item.text,
    score,
  };
}

class FixedRetriever implements RagRetriever {
  constructor(private readonly results: RagEvidence[]) {}
  async search() {
    return this.results;
  }
  async status() {
    return {
      state: 'ready' as const,
      indexSchemaVersion: 'fixture',
      lastSuccessfulIngestionAt: null,
      categories: [],
      limitations: [],
    };
  }
}

const graph = new ProvisionGraph(chunks);
const input = {
  question: 'Does a small company need four board meetings of the quorum?',
  legalCategory: 'corporate',
  jurisdiction: 'India',
  resultLimit: 4,
};

describe('ProvisionExpansionRetriever', () => {
  it('indexes Section 2 definitions by defined term', () => {
    expect(graph.definitionIndex().get('small company')?.clause).toBe('85');
  });

  it('adds the definition used by the question and provision plus a relevant cross-reference', async () => {
    const base = new FixedRetriever([toEvidence(chunks[1]!, 10)]);
    const results = await new ProvisionExpansionRetriever(base, graph, 'x').search(input);
    expect(results.map((item) => item.chunkId)).toEqual([
      'chunk_173',
      'chunk_2#def-85',
      'chunk_174',
    ]);
    expect(results[1]?.text).toContain('holding company or a subsidiary company');
    expect(results[1]?.text).not.toContain('subscribed capital');
  });

  it('never exceeds the evidence budget and keeps at least half for base results', async () => {
    const base = new FixedRetriever([
      toEvidence(chunks[1]!, 10),
      toEvidence(chunks[3]!, 9),
      toEvidence({ ...chunks[3]!, chunkId: 'chunk_300b' }, 8),
      toEvidence({ ...chunks[3]!, chunkId: 'chunk_300c' }, 7),
    ]);
    const results = await new ProvisionExpansionRetriever(base, graph, 'x').search(input);
    expect(results).toHaveLength(4);
    expect(results.slice(0, 2).map((item) => item.chunkId)).toEqual(['chunk_173', 'chunk_300']);
  });

  it('does not expand evidence from a different document', async () => {
    const foreign = { ...toEvidence(chunks[1]!, 10), documentId: 'legal_other' };
    const results = await new ProvisionExpansionRetriever(
      new FixedRetriever([foreign]),
      graph,
      'x',
    ).search(input);
    expect(results).toHaveLength(1);
  });

  it('returns an empty result unchanged so the service still abstains', async () => {
    const results = await new ProvisionExpansionRetriever(
      new FixedRetriever([]),
      graph,
      'x',
    ).search(input);
    expect(results).toEqual([]);
  });
});
