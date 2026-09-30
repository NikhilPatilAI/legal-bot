import { describe, expect, it } from 'vitest';

import {
  LegalRagService,
  type RagComposer,
  type RagCorpusStatus,
  type RagEvidence,
  type RagRetriever,
} from '../../src/rag/rag-service.js';
import { DeterministicClaimVerifier } from '../../src/rag/verification/claim-verifier.js';

const status: RagCorpusStatus = {
  state: 'ready',
  indexSchemaVersion: 'test-v1',
  lastSuccessfulIngestionAt: '2026-09-01T12:54:17.027Z',
  categories: [{ category: 'corporate', documents: 1, chunks: 1, state: 'experimental' }],
  limitations: ['Legal status is unknown.'],
};

function evidence(): RagEvidence {
  return {
    chunkId: 'chunk_188',
    documentId: 'legal_test',
    title: 'The Companies Act, 2013',
    authority: 'ministry_of_corporate_affairs',
    sectionIdentifier: '188',
    sectionHeading: 'Related party transactions',
    pageStart: 117,
    pageEnd: 118,
    officialSourceUrl: 'https://www.mca.gov.in/example.pdf',
    effectiveDate: null,
    retrievalDate: '2026-09-01T12:54:17.027Z',
    sha256: 'a'.repeat(64),
    legalStatus: 'unknown',
    text: 'Section 188 — Related party transactions. Except with the consent of the Board of Directors given by a resolution, no company shall enter into a contract with a related party, other than transactions in the ordinary course of business on an arm length basis.',
    score: 100,
  };
}

class StubRetriever implements RagRetriever {
  async status() {
    return status;
  }
  async search() {
    return [evidence()];
  }
}

describe('LegalRagService with post-generation verification', () => {
  it('passes through an answer whose claims are grounded in the evidence', async () => {
    const composer: RagComposer = {
      mode: 'azure_openai',
      compose: async () =>
        '## Summary\nUnder Section 188, a company needs the consent of the Board of Directors by resolution for a related party contract, except transactions in the ordinary course of business on an arm length basis.',
    };
    const service = new LegalRagService(
      new StubRetriever(),
      composer,
      30_000,
      new DeterministicClaimVerifier(),
    );
    const result = await service.query(
      {
        question: 'Explain Section 188',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-verify-pass',
    );
    expect(result.abstained).toBe(false);
    expect(result.warnings.join(' ')).toContain('Answer verification');
  });

  it('withholds an answer that cites a section the evidence never provided', async () => {
    const composer: RagComposer = {
      mode: 'azure_openai',
      compose: async () =>
        '## Summary\nUnder Section 402, every company must obtain written approval from the Central Government before any related party transaction.',
    };
    const service = new LegalRagService(
      new StubRetriever(),
      composer,
      30_000,
      new DeterministicClaimVerifier(),
    );
    const result = await service.query(
      {
        question: 'Explain Section 188',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-verify-fail',
    );
    expect(result.abstained).toBe(true);
    expect(result.answer).toContain('could not be verified');
    expect(result.citations).toEqual([]);
  });
});
