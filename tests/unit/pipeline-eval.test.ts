import { describe, expect, it } from 'vitest';

import {
  RecordingAnswerVerifier,
  runPipelineEvaluation,
} from '../../src/rag/evaluation/pipeline-eval.js';
import { legalEvalDatasetSchema } from '../../src/rag/evaluation/legal-eval-dataset.js';
import {
  DeterministicExtractComposer,
  LegalRagService,
  type RagComposer,
  type RagEvidence,
  type RagRetriever,
} from '../../src/rag/rag-service.js';
import { HistoricalProvisionStore } from '../../src/rag/temporal/historical-provision-store.js';
import { DeterministicClaimVerifier } from '../../src/rag/verification/claim-verifier.js';

// Synthetic engineering fixture evidence (not a statement of law).
const evidence: RagEvidence = {
  chunkId: 'chunk_901',
  documentId: 'legal_fixture',
  title: 'Fixture Act',
  authority: 'fixture',
  sectionIdentifier: '135',
  sectionHeading: 'Fixture heading',
  pageStart: 1,
  pageEnd: 1,
  officialSourceUrl: 'https://example.gov/fixture.pdf',
  effectiveDate: null,
  retrievalDate: '2026-09-28T00:00:00.000Z',
  sha256: 'd'.repeat(64),
  legalStatus: 'unknown',
  text: 'Section 135 — Fixture. Every company shall file the annual compliance statement with the registrar within thirty days after the close of the financial year.',
  score: 1,
};

const retriever: RagRetriever = {
  search: async () => [evidence],
  status: async () => ({
    state: 'ready',
    indexSchemaVersion: 'fixture',
    lastSuccessfulIngestionAt: null,
    categories: [],
    limitations: [],
  }),
};

const dataset = legalEvalDatasetSchema.parse({
  schemaVersion: 'legal-bot-legal-eval-v1',
  act: 'Fixture Act',
  reviewStatus: 'unverified_curated',
  reviewNote: 'Synthetic fixture.',
  cases: [
    {
      id: 'answerable',
      type: 'direct_lookup',
      question: 'When must the annual compliance statement be filed under Section 135?',
      legalCategory: 'corporate',
      jurisdiction: 'India',
      expectedSections: ['135'],
      expectedFacts: ['thirty days', 'close of the financial year', 'a fact the source lacks'],
    },
    {
      id: 'refusal',
      type: 'insufficient_evidence',
      question: 'How does Delaware law treat mergers?',
      legalCategory: 'corporate',
      jurisdiction: 'India',
      expectedSections: [],
      expectAbstention: true,
    },
  ],
});

describe('runPipelineEvaluation', () => {
  it('runs cases through the real service and scores the actual answer', async () => {
    const recorder = new RecordingAnswerVerifier(new DeterministicClaimVerifier());
    const service = new LegalRagService(
      retriever,
      new DeterministicExtractComposer(),
      30_000,
      recorder,
    );
    const run = await runPipelineEvaluation(service, dataset, { label: 'fixture', recorder });
    const answerable = run.cases.find((item) => item.id === 'answerable')!;
    expect(answerable.abstained).toBe(false);
    expect(answerable.citedSections).toEqual(['135']);
    expect(answerable.factCoverage).toBeCloseTo(0.667, 3);
    expect(answerable.failureCategories).toContain('expected_fact_missing');
    expect(answerable.verification?.claimCount).toBeGreaterThan(0);
    expect(run.metrics.correctAbstentionRate).toBe(1);
  });

  it('never passes reference facts to the composer', async () => {
    const seen: string[] = [];
    const composer: RagComposer = {
      mode: 'azure_openai',
      compose: async (question, items) => {
        seen.push(question, ...items.map((item) => item.text));
        return 'Every company shall file the annual compliance statement with the registrar.';
      },
    };
    const service = new LegalRagService(retriever, composer, 30_000);
    await runPipelineEvaluation(service, dataset, { label: 'fixture' });
    expect(seen.join(' ')).not.toContain('a fact the source lacks');
  });

  it('counts an unnecessary abstention against answerable cases', async () => {
    const abstaining: RagComposer = {
      mode: 'azure_openai',
      compose: async () => 'LEGALBOT_ABSTAIN: not enough evidence',
    };
    const run = await runPipelineEvaluation(
      new LegalRagService(retriever, abstaining, 30_000),
      dataset,
      {
        label: 'fixture',
      },
    );
    expect(run.metrics.unnecessaryAbstentionRate).toBe(1);
    expect(run.metrics.answerFactCoverage).toBe(0);
  });
});

describe('LegalRagService as-of-date answers', () => {
  const history = HistoricalProvisionStore.fromFile('data/history/companies-act-2013.history.json');
  const ask = async (question: string, asOfDate: string) =>
    new LegalRagService(
      retriever,
      new DeterministicExtractComposer(),
      30_000,
      new DeterministicClaimVerifier(),
      0.5,
      await history,
    ).query(
      { question, legalCategory: 'corporate', jurisdiction: 'India', resultLimit: 6, asOfDate },
      'req_test',
    );
  const unspent =
    'Under Section 135, what must happen if the company fails to spend the CSR amount?';

  it('answers from the pre-amendment text before 22 January 2021', async () => {
    const result = await ask(unspent, '2021-01-21');
    expect(result.abstained).toBe(false);
    expect(result.applicableDate).toBe('2021-01-21');
    expect(result.answer).toContain('specify the reasons for not spending the amount');
    expect(result.answer).not.toContain('Schedule VII');
    expect(result.warnings.some((item) => item.includes('s135-5-p2-2014'))).toBe(true);
  });

  it('answers from the amended text on 22 January 2021', async () => {
    const result = await ask(unspent, '2021-01-22');
    expect(result.abstained).toBe(false);
    expect(result.answer).toContain('Schedule VII');
    expect(result.warnings.some((item) => item.includes('s135-5-p2-2021'))).toBe(true);
  });

  it('abstains before commencement, for future dates, and for unrecorded parts of the section', async () => {
    expect((await ask(unspent, '2014-03-31')).abstained).toBe(true);
    expect((await ask(unspent, '2999-01-01')).abstained).toBe(true);
    const uncovered = await ask(
      'Under Section 135, which financial year decides whether the net worth threshold applies?',
      '2016-06-01',
    );
    expect(uncovered.abstained).toBe(true);
    expect(uncovered.answer).toContain('no verified historical text');
  });
});
