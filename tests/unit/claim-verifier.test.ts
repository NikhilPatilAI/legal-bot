import { describe, expect, it } from 'vitest';

import {
  DeterministicClaimVerifier,
  extractClaims,
  type ClaimSupportClassifier,
} from '../../src/rag/verification/claim-verifier.js';
import type { RagEvidence } from '../../src/rag/rag-service.js';

function evidence(overrides: Partial<RagEvidence> = {}): RagEvidence {
  return {
    chunkId: 'chunk_1',
    documentId: 'legal_test',
    title: 'The Companies Act, 2013',
    authority: 'ministry_of_corporate_affairs',
    sectionIdentifier: '149',
    sectionHeading: 'Company to have Board of Directors',
    pageStart: 98,
    pageEnd: 99,
    officialSourceUrl: 'https://www.mca.gov.in/example.pdf',
    effectiveDate: null,
    retrievalDate: '2026-09-01T12:54:17.027Z',
    sha256: 'a'.repeat(64),
    legalStatus: 'unknown',
    text: 'Section 149 — Company to have Board of Directors. Every company shall have a minimum number of three directors in the case of a public company, two directors in the case of a private company, and one director in the case of a One Person Company, and a maximum of fifteen directors.',
    score: 100,
    ...overrides,
  };
}

describe('extractClaims', () => {
  it('splits prose and list items into claims and drops disclaimers and headings', () => {
    const answer = [
      '## Summary',
      'A public company must have at least three directors.',
      '- The maximum number of directors is fifteen without a special resolution.',
      'Legal information only; not legal advice.',
    ].join('\n');
    const claims = extractClaims(answer, 25);
    expect(claims).toHaveLength(2);
    expect(claims[0]).toContain('three directors');
    expect(claims.some((claim) => claim.includes('not legal advice'))).toBe(false);
  });
});

describe('DeterministicClaimVerifier', () => {
  it('marks a claim supported when its content appears in retrieved evidence', async () => {
    const report = await new DeterministicClaimVerifier().verify(
      'A public company must have a minimum number of three directors.',
      [evidence()],
    );
    expect(report.claimCount).toBe(1);
    expect(report.supportedClaimCount).toBe(1);
    expect(report.claims[0]?.status).toBe('supported');
  });

  it('flags a fabricated section citation that the evidence never provided', async () => {
    const report = await new DeterministicClaimVerifier().verify(
      'Section 402 requires a company to appoint three directors.',
      [evidence()],
    );
    expect(report.unverifiedCitationCount).toBe(1);
    expect(report.claims[0]?.status).toBe('unverified_citation');
    expect(report.citationSupportRate).toBeLessThan(1);
  });

  it('flags a quotation that does not appear verbatim in any source', async () => {
    const report = await new DeterministicClaimVerifier().verify(
      'The Act says "every company must appoint a compliance robot for each branch office".',
      [evidence()],
    );
    expect(report.unverifiedQuotationCount).toBe(1);
    expect(report.claims[0]?.status).toBe('unverified_quotation');
  });

  it('treats an unrelated statement with no evidence overlap as unsupported', async () => {
    const report = await new DeterministicClaimVerifier().verify(
      'Quarterly greenhouse emission audits are mandatory for every partnership firm.',
      [evidence()],
    );
    expect(report.unsupportedClaimCount).toBe(1);
    expect(report.claims[0]?.status).toBe('unsupported');
  });

  it('lets an optional classifier downgrade a lexically supported claim to contradicted but never fabricate support', async () => {
    const contradicting: ClaimSupportClassifier = { classify: async () => 'contradicted' };
    const downgrade = await new DeterministicClaimVerifier({ classifier: contradicting }).verify(
      'A public company must have a minimum number of three directors.',
      [evidence()],
    );
    expect(downgrade.verifierMode).toBe('deterministic_plus_semantic');
    expect(downgrade.claims[0]?.status).toBe('contradicted');

    const optimistic: ClaimSupportClassifier = { classify: async () => 'supported' };
    const unsupported = await new DeterministicClaimVerifier({ classifier: optimistic }).verify(
      'Quarterly greenhouse emission audits are mandatory for every partnership firm.',
      [evidence()],
    );
    // Deterministic check found no support, so the classifier cannot upgrade it.
    expect(unsupported.claims[0]?.status).toBe('unsupported');
  });

  it('reports a throwing classifier as unverified instead of silently supported', async () => {
    const failing: ClaimSupportClassifier = {
      classify: async () => {
        throw new Error('provider down');
      },
    };
    const report = await new DeterministicClaimVerifier({ classifier: failing }).verify(
      'A public company must have a minimum number of three directors.',
      [evidence()],
    );
    expect(report.claims[0]?.status).toBe('unverified');
    expect(report.claims[0]?.reasons).toContain('semantic_unavailable');
    expect(report.unverifiedClaimCount).toBe(1);
  });
});
