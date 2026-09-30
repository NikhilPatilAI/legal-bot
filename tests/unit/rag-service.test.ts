import { describe, expect, it } from 'vitest';

import {
  DeterministicExtractComposer,
  LegalRagService,
  type RagComposer,
  type RagCorpusStatus,
  type RagEvidence,
  type RagQueryInput,
  type RagRetriever,
} from '../../src/rag/rag-service.js';

const status: RagCorpusStatus = {
  state: 'ready',
  indexSchemaVersion: 'test-v1',
  lastSuccessfulIngestionAt: '2026-09-01T12:54:17.027Z',
  categories: [{ category: 'corporate', documents: 1, chunks: 3, state: 'experimental' }],
  limitations: ['Legal status is unknown.'],
};

function evidence(sectionIdentifier: string): RagEvidence {
  return {
    chunkId: `chunk_${sectionIdentifier}`,
    documentId: 'legal_test',
    title: 'The Companies Act, 2013',
    authority: 'technology_development_board',
    sectionIdentifier,
    sectionHeading: 'Test heading',
    pageStart: 1,
    pageEnd: 2,
    officialSourceUrl: 'https://www.tdb.gov.in/example.pdf',
    effectiveDate: null,
    retrievalDate: '2026-09-01T12:54:17.027Z',
    sha256: 'a'.repeat(64),
    legalStatus: 'unknown',
    text: `Section ${sectionIdentifier} — Test heading\nVerified source text.`,
    score: 100,
  };
}

class StubRetriever implements RagRetriever {
  constructor(private readonly results: RagEvidence[] = [evidence('188')]) {}
  async status() {
    return status;
  }
  async search() {
    return this.results;
  }
}

describe('LegalRagService', () => {
  it('returns cited deterministic evidence without presenting it as model generation', async () => {
    const service = new LegalRagService(new StubRetriever(), new DeterministicExtractComposer());
    const result = await service.query(
      {
        question: 'What does Section 188 cover?',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-1',
    );
    expect(result.abstained).toBe(false);
    expect(result.answerMode).toBe('deterministic_extract');
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]).toMatchObject({
      sectionIdentifier: '188',
      authority: 'technology_development_board',
    });
    expect(result.answer).toContain('## Summary');
    expect(result.warnings.join(' ')).toContain('not live model generation');
  });

  it('formats a checklist request as readable grounded guidance without leading OCR noise', async () => {
    const trademarkEvidence = {
      ...evidence('Page 63'),
      title: 'Trade Marks Rules, 2017',
      sectionHeading: null,
      text: '1Hkkx II µ[k.M 3 (i) o Hkkjr dk jkti=k. Opposition to Registration 42. Notice of Opposition. (1) A notice of opposition to the registration of a trademark shall be filed in Form TM-O within four months from the date of publication of the trademark journal. (2) Where a notice of opposition has been filed in respect of a single application for different classes of goods and services, it shall bear the fee in respect of each class.',
    };
    const service = new LegalRagService(
      new StubRetriever([trademarkEvidence]),
      new DeterministicExtractComposer(),
    );
    const result = await service.query(
      {
        question: 'Explain the trademark opposition process and give me a compliance checklist.',
        legalCategory: 'all',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-trademark',
    );

    expect(result.answer).toContain('## Summary');
    expect(result.answer).toContain('## Compliance checklist');
    expect(result.answer).toContain('Form TM-O');
    expect(result.answer).toContain('four months');
    expect(result.answer).not.toContain('1Hkkx II');
    expect(result.answer).not.toContain('heading unavailable');
  });

  it.each([
    [
      {
        question: 'What is French contract law?',
        legalCategory: 'corporate',
        jurisdiction: 'France',
        resultLimit: 5,
      },
      'outside this test corpus',
    ],
    [
      {
        question: 'What does French company law require?',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'foreign jurisdiction',
    ],
    [
      {
        question: 'What was Section 188 in 2014?',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        asOfDate: '2014-01-01',
        resultLimit: 5,
      },
      'Historical retrieval is unavailable',
    ],
  ] satisfies Array<[RagQueryInput, string]>)(
    'abstains safely for unsupported scope',
    async (input, expected) => {
      const result = await new LegalRagService(
        new StubRetriever(),
        new DeterministicExtractComposer(),
      ).query(input, 'request-2');
      expect(result.abstained).toBe(true);
      expect(result.answer).toContain(expected);
      expect(result.citations).toEqual([]);
    },
  );

  it('abstains when a requested section is absent', async () => {
    const result = await new LegalRagService(
      new StubRetriever([evidence('149')]),
      new DeterministicExtractComposer(),
    ).query(
      {
        question: 'Explain Section 188',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-3',
    );
    expect(result.abstained).toBe(true);
    expect(result.answer).toContain('Section 188 was not found');
  });

  it('abstains without retrieval for an explicit homicide punishment question', async () => {
    const retriever = new StubRetriever();
    const search = vi.spyOn(retriever, 'search');
    const result = await new LegalRagService(retriever, new DeterministicExtractComposer()).query(
      {
        question: 'What if I kill someone, what is the punishment in India?',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-criminal',
    );
    expect(result.abstained).toBe(true);
    expect(result.answer).toContain('does not contain sufficient relevant criminal-law evidence');
    expect(result.citations).toEqual([]);
    expect(search).not.toHaveBeenCalled();
  });

  it('converts the model insufficient-evidence signal into a citation-free abstention', async () => {
    const composer: RagComposer = {
      mode: 'azure_openai',
      compose: async () => 'LEGALBOT_ABSTAIN: The evidence does not cover this question.',
    };
    const result = await new LegalRagService(new StubRetriever(), composer).query(
      {
        question: 'A vague unsupported question',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-abstain',
    );
    expect(result.abstained).toBe(true);
    expect(result.answer).toBe('The evidence does not cover this question.');
    expect(result.citations).toEqual([]);
  });

  it('rejects a whitespace-only question', async () => {
    await expect(
      new LegalRagService(new StubRetriever(), new DeterministicExtractComposer()).query(
        { question: '   ', legalCategory: 'corporate', jurisdiction: 'India', resultLimit: 5 },
        'request-4',
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'validation_failed' });
  });

  it('maps generation failures to a structured model-unavailable error', async () => {
    const composer: RagComposer = {
      mode: 'azure_openai',
      compose: async () => {
        throw new Error('provider detail must not escape');
      },
    };
    await expect(
      new LegalRagService(new StubRetriever(), composer).query(
        {
          question: 'Explain Section 188',
          legalCategory: 'corporate',
          jurisdiction: 'India',
          resultLimit: 5,
        },
        'request-5',
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: 'model_unavailable' });
  });

  it('does not repeat a billable generation when the first response is empty', async () => {
    const compose = vi.fn(async () => '');
    const composer: RagComposer = { mode: 'azure_openai', compose };
    await expect(
      new LegalRagService(new StubRetriever(), composer).query(
        {
          question: 'Explain Section 188',
          legalCategory: 'corporate',
          jurisdiction: 'India',
          resultLimit: 5,
        },
        'request-6',
      ),
    ).rejects.toMatchObject({ statusCode: 502, code: 'model_invalid_response' });
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled corpus check before any generation starts', async () => {
    const retriever = new StubRetriever();
    vi.spyOn(retriever, 'status').mockImplementation(() => new Promise(() => {}));
    const compose = vi.fn(async () => 'unused');
    await expect(
      new LegalRagService(retriever, { mode: 'azure_openai', compose }, 30).query(
        {
          question: 'Explain Section 188',
          legalCategory: 'corporate',
          jurisdiction: 'India',
          resultLimit: 5,
        },
        'request-timeout',
      ),
    ).rejects.toMatchObject({ statusCode: 504, code: 'rag_timeout' });
    expect(compose).not.toHaveBeenCalled();
  });

  it('cancels generation when the shared request deadline expires', async () => {
    let observed: AbortSignal | undefined;
    const compose = vi.fn(
      async (_question: string, _evidence: readonly RagEvidence[], signal?: AbortSignal) => {
        observed = signal;
        return new Promise<string>(() => {});
      },
    );
    await expect(
      new LegalRagService(new StubRetriever(), { mode: 'azure_openai', compose }, 30).query(
        {
          question: 'Explain Section 188',
          legalCategory: 'corporate',
          jurisdiction: 'India',
          resultLimit: 5,
        },
        'request-timeout',
      ),
    ).rejects.toMatchObject({ code: 'rag_timeout' });
    expect(compose).toHaveBeenCalledTimes(1);
    expect(observed?.aborted).toBe(true);
  });

  it('rejects oversized input and evidence before generation', async () => {
    const compose = vi.fn(async () => 'unused');
    const service = new LegalRagService(
      new StubRetriever([{ ...evidence('188'), text: 'a'.repeat(80_001) }]),
      { mode: 'azure_openai', compose },
    );
    const input = {
      question: 'Explain Section 188',
      legalCategory: 'corporate',
      jurisdiction: 'India',
      resultLimit: 5,
    };
    await expect(
      service.query({ ...input, question: 'a'.repeat(4001) }, 'request-large'),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(
      service.query({ ...input, resultLimit: 11 }, 'request-large'),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(service.query(input, 'request-large')).rejects.toMatchObject({
      code: 'search_invalid_response',
    });
    expect(compose).not.toHaveBeenCalled();
  });

  it('rejects oversized model output without including it in the error', async () => {
    const compose = vi.fn(async () => 'private-provider-content'.repeat(2000));
    await expect(
      new LegalRagService(new StubRetriever(), { mode: 'azure_openai', compose }).query(
        {
          question: 'Explain Section 188',
          legalCategory: 'corporate',
          jurisdiction: 'India',
          resultLimit: 5,
        },
        'request-output',
      ),
    ).rejects.toMatchObject({
      code: 'model_invalid_response',
      message: 'The answer provider returned an invalid response.',
    });
    expect(compose).toHaveBeenCalledTimes(1);
  });

  it('keeps all retrieved chunks but emits one citation card per source section and page range', async () => {
    const first = evidence('149');
    const second = {
      ...evidence('149'),
      chunkId: 'chunk_149_continued',
      text: 'Continued verified source text.',
    };
    const result = await new LegalRagService(
      new StubRetriever([first, second]),
      new DeterministicExtractComposer(),
    ).query(
      {
        question: 'Explain Section 149',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-7',
    );
    expect(result.retrievedSources).toHaveLength(2);
    expect(result.citations).toHaveLength(1);
  });

  it('reports only real service stages in execution order', async () => {
    const stages: string[] = [];
    await new LegalRagService(new StubRetriever(), new DeterministicExtractComposer()).query(
      {
        question: 'Explain Section 188',
        legalCategory: 'corporate',
        jurisdiction: 'India',
        resultLimit: 5,
      },
      'request-progress',
      undefined,
      (event) => stages.push(event.stage),
    );
    expect(stages).toEqual(['checking_scope', 'retrieving_sources', 'drafting_answer']);
  });
});
