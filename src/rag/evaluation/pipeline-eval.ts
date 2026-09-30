import { performance } from 'node:perf_hooks';

import { AppError } from '../../errors.js';
import type { LegalRagClient, RagEvidence, RagQueryResult } from '../rag-service.js';
import {
  contentTokens,
  extractNumbers,
  type AnswerVerificationReport,
  type AnswerVerifier,
} from '../verification/claim-verifier.js';
import type { LegalEvalCase, LegalEvalDataset } from './legal-eval-dataset.js';

// End-to-end evaluation through the real query service. Unlike the retriever
// harness, nothing here builds an answer: each case is sent to
// LegalRagService.query exactly as an authenticated request would be, so scope
// checks, retrieval, composition, verification, and abstention all run. The
// composer receives only the question and retrieved evidence; reference facts
// are used after the fact for scoring and never enter the pipeline.

export type PipelineFailureCategory =
  | 'error'
  | 'missed_abstention'
  | 'unnecessary_abstention'
  | 'withheld_by_verifier'
  | 'expected_provision_not_cited'
  | 'connected_provision_not_cited'
  | 'acceptable_document_not_cited'
  | 'expected_fact_missing'
  | 'unsupported_claims'
  | 'wrong_version';

export interface PipelineCaseResult {
  id: string;
  split: string | null;
  type: LegalEvalCase['type'];
  attempt: number;
  abstained: boolean;
  expectAbstention: boolean;
  errorCode: string | null;
  answer: string;
  answerMode: string | null;
  citedSections: string[];
  retrievedSections: string[];
  expectedSections: string[];
  connectedSections: string[];
  expectedProvisionRecall: number | null;
  connectedProvisionRecall: number | null;
  citedDocuments: string[];
  acceptableDocumentCited: boolean | null;
  factCoverage: number | null;
  missingFacts: string[];
  verification: {
    claimCount: number;
    supportedClaimCount: number;
    unsupportedClaimCount: number;
    contradictedClaimCount: number;
    unverifiedClaimCount: number;
    withheld: boolean;
    // Claims the verifier did not accept, for error analysis. Includes the
    // source span it compared against; the answer text itself is kept only
    // when it was withheld (the draft never reached the user).
    rejectedClaims: Array<{
      text: string;
      status: string;
      reasons: string[];
      supportScore: number;
      supportingText: string | null;
    }>;
  } | null;
  applicableDate: string | null;
  expectedVersionId: string | null;
  selectedVersionId: string | null;
  failureCategories: PipelineFailureCategory[];
  latencyMs: number;
}

export interface PipelineEvalMetrics {
  caseCount: number;
  answerableCount: number;
  refusalCount: number;
  correctAbstentionRate: number | null;
  missedAbstentionRate: number | null;
  unnecessaryAbstentionRate: number | null;
  withheldByVerifierRate: number | null;
  citedProvisionRecall: number | null;
  connectedProvisionRecall: number | null;
  acceptableDocumentHitRate: number | null;
  answerFactCoverage: number | null;
  verifierUnsupportedClaimRate: number | null;
  temporalVersionAccuracy: number | null;
  errorRate: number;
  latencyMsP50: number;
  latencyMsP95: number;
  failureCounts: Partial<Record<PipelineFailureCategory, number>>;
}

export interface PipelineEvalOptions {
  label: string;
  resultLimit?: number;
  repeats?: number;
  splits?: readonly string[];
  recorder?: RecordingAnswerVerifier;
  // Pause between cases, outside the measured latency, so a rate-limited
  // model deployment is not driven into throttling errors by the harness.
  pauseBetweenCasesMs?: number;
}

export interface PipelineEvalRun {
  label: string;
  resultLimit: number;
  repeats: number;
  splits: string[] | null;
  metrics: PipelineEvalMetrics;
  cases: PipelineCaseResult[];
}

// Captures the verification report produced for the most recent answer without
// changing what the service does with it. Evaluation runs cases sequentially.
export class RecordingAnswerVerifier implements AnswerVerifier {
  last: AnswerVerificationReport | null = null;
  // The draft and the evidence it was checked against, so a withheld draft can
  // be re-verified offline without calling the model again.
  lastAnswer: string | null = null;
  lastEvidenceChunkIds: string[] = [];
  constructor(private readonly inner: AnswerVerifier) {}

  reset(): void {
    this.last = null;
    this.lastAnswer = null;
    this.lastEvidenceChunkIds = [];
  }

  async verify(
    answer: string,
    evidence: readonly RagEvidence[],
    signal?: AbortSignal,
  ): Promise<AnswerVerificationReport> {
    this.lastAnswer = answer;
    this.lastEvidenceChunkIds = evidence.map((item) => item.chunkId);
    this.last = await this.inner.verify(answer, evidence, signal);
    return this.last;
  }
}

const VERIFIER_WITHHELD_PREFIX = 'The drafted answer could not be verified';

export async function runPipelineEvaluation(
  service: LegalRagClient,
  dataset: LegalEvalDataset,
  options: PipelineEvalOptions,
): Promise<PipelineEvalRun> {
  const resultLimit = options.resultLimit ?? 8;
  const repeats = options.repeats ?? 1;
  const splits = options.splits ? [...options.splits] : null;
  const selected = dataset.cases.filter(
    (testCase) => splits === null || splits.includes(caseSplit(testCase) ?? ''),
  );
  const cases: PipelineCaseResult[] = [];
  for (let attempt = 1; attempt <= repeats; attempt += 1)
    for (const testCase of selected) {
      if (cases.length > 0 && options.pauseBetweenCasesMs)
        await new Promise((done) => setTimeout(done, options.pauseBetweenCasesMs));
      cases.push(await evaluateCase(service, testCase, resultLimit, attempt, options.recorder));
    }
  return {
    label: options.label,
    resultLimit,
    repeats,
    splits,
    metrics: summarizePipeline(cases),
    cases,
  };
}

async function evaluateCase(
  service: LegalRagClient,
  testCase: LegalEvalCase,
  resultLimit: number,
  attempt: number,
  recorder?: RecordingAnswerVerifier,
): Promise<PipelineCaseResult> {
  recorder?.reset();
  const started = performance.now();
  let result: RagQueryResult | null = null;
  let errorCode: string | null = null;
  try {
    result = await service.query(
      {
        question: testCase.question,
        legalCategory: testCase.legalCategory,
        jurisdiction: testCase.jurisdiction,
        resultLimit,
        ...(testCase.asOfDate ? { asOfDate: testCase.asOfDate } : {}),
      },
      `eval_${testCase.id}_${attempt}`,
    );
  } catch (error) {
    errorCode = error instanceof AppError ? error.code : 'unexpected_error';
  }
  const latencyMs = round(performance.now() - started);

  const abstained = result?.abstained ?? false;
  const answer = result?.answer ?? '';
  const citedSections = uniqueUpper(
    (result?.citations ?? []).map((item) => item.sectionIdentifier),
  );
  const retrievedSections = uniqueUpper(
    (result?.retrievedSources ?? []).map((item) => item.sectionIdentifier),
  );
  const report = recorder?.last ?? null;
  const withheld = abstained && answer.startsWith(VERIFIER_WITHHELD_PREFIX);
  const answered = result !== null && !abstained;

  const expectedProvisionRecall =
    testCase.expectedSections.length > 0 && !testCase.expectAbstention
      ? recall(citedSections, testCase.expectedSections)
      : null;
  const connectedProvisionRecall =
    testCase.connectedSections.length > 0
      ? recall(citedSections, testCase.connectedSections)
      : null;
  const missingFacts = answered
    ? testCase.expectedFacts.filter((fact) => !factPresent(answer, fact))
    : [...testCase.expectedFacts];
  const factCoverage =
    testCase.expectAbstention || testCase.expectedFacts.length === 0
      ? null
      : round(1 - missingFacts.length / testCase.expectedFacts.length);
  const citedDocuments = [...new Set((result?.citations ?? []).map((item) => item.documentId))];
  const acceptableDocumentCited =
    testCase.acceptableDocuments.length > 0
      ? answered &&
        testCase.acceptableDocuments.some((documentId) => citedDocuments.includes(documentId))
      : null;
  const selectedVersionId = result ? versionFromResult(result) : null;
  const expectedVersionId = testCase.expectedVersionId ?? null;

  const failures: PipelineFailureCategory[] = [];
  if (errorCode) failures.push('error');
  else if (testCase.expectAbstention && !abstained) failures.push('missed_abstention');
  else if (!testCase.expectAbstention && abstained) {
    failures.push(withheld ? 'withheld_by_verifier' : 'unnecessary_abstention');
  }
  if (answered && !testCase.expectAbstention) {
    if (expectedProvisionRecall !== null && expectedProvisionRecall < 1)
      failures.push('expected_provision_not_cited');
    if (connectedProvisionRecall !== null && connectedProvisionRecall < 1)
      failures.push('connected_provision_not_cited');
    if (acceptableDocumentCited === false) failures.push('acceptable_document_not_cited');
    if (missingFacts.length > 0) failures.push('expected_fact_missing');
    if (report && report.claimCount > report.supportedClaimCount)
      failures.push('unsupported_claims');
  }
  if (expectedVersionId !== null && selectedVersionId !== expectedVersionId && !abstained)
    failures.push('wrong_version');

  return {
    id: testCase.id,
    split: caseSplit(testCase),
    type: testCase.type,
    attempt,
    abstained,
    expectAbstention: testCase.expectAbstention,
    errorCode,
    answer,
    answerMode: result?.answerMode ?? null,
    citedSections,
    retrievedSections,
    expectedSections: testCase.expectedSections,
    connectedSections: testCase.connectedSections,
    expectedProvisionRecall: answered ? expectedProvisionRecall : null,
    connectedProvisionRecall: answered ? connectedProvisionRecall : null,
    citedDocuments,
    acceptableDocumentCited,
    factCoverage: answered ? factCoverage : factCoverage === null ? null : 0,
    missingFacts,
    verification: report
      ? {
          claimCount: report.claimCount,
          supportedClaimCount: report.supportedClaimCount,
          unsupportedClaimCount: report.unsupportedClaimCount,
          contradictedClaimCount: report.contradictedClaimCount,
          unverifiedClaimCount: report.claimCount - report.supportedClaimCount,
          withheld,
          // Kept only for withheld drafts, which never reach a user.
          ...(withheld && recorder
            ? { draft: recorder.lastAnswer, evidenceChunkIds: recorder.lastEvidenceChunkIds }
            : {}),
          rejectedClaims: report.claims
            .filter((claim) => claim.status !== 'supported')
            .map((claim) => ({
              text: claim.text,
              status: claim.status,
              reasons: claim.reasons,
              supportScore: claim.supportScore,
              supportingText: claim.supportingText?.slice(0, 300) ?? null,
            })),
        }
      : null,
    applicableDate: result?.applicableDate ?? null,
    expectedVersionId,
    selectedVersionId,
    failureCategories: failures,
    latencyMs,
  };
}

export function summarizePipeline(cases: readonly PipelineCaseResult[]): PipelineEvalMetrics {
  const answerable = cases.filter((item) => !item.expectAbstention);
  const refusals = cases.filter((item) => item.expectAbstention);
  const answered = answerable.filter((item) => !item.abstained && item.errorCode === null);
  const verified = answered.filter((item) => item.verification !== null);
  const withConnected = answered.filter((item) => item.connectedProvisionRecall !== null);
  const withSections = answered.filter((item) => item.expectedProvisionRecall !== null);
  const withFacts = answerable.filter((item) => item.factCoverage !== null);
  const versioned = cases.filter((item) => item.expectedVersionId !== null);
  const failureCounts: Partial<Record<PipelineFailureCategory, number>> = {};
  for (const item of cases)
    for (const failure of item.failureCategories)
      failureCounts[failure] = (failureCounts[failure] ?? 0) + 1;
  const claimTotal = verified.reduce((sum, item) => sum + (item.verification?.claimCount ?? 0), 0);
  const unsupportedTotal = verified.reduce(
    (sum, item) => sum + (item.verification?.unverifiedClaimCount ?? 0),
    0,
  );
  return {
    caseCount: cases.length,
    answerableCount: answerable.length,
    refusalCount: refusals.length,
    correctAbstentionRate: rateOrNull(refusals, (item) => item.abstained),
    missedAbstentionRate: rateOrNull(refusals, (item) => !item.abstained && !item.errorCode),
    unnecessaryAbstentionRate: rateOrNull(answerable, (item) => item.abstained),
    withheldByVerifierRate: rateOrNull(answerable, (item) => item.verification?.withheld === true),
    citedProvisionRecall: meanOrNull(withSections.map((item) => item.expectedProvisionRecall!)),
    connectedProvisionRecall: meanOrNull(
      withConnected.map((item) => item.connectedProvisionRecall!),
    ),
    acceptableDocumentHitRate: rateOrNull(
      answerable.filter((item) => item.acceptableDocumentCited !== null),
      (item) => item.acceptableDocumentCited === true,
    ),
    // Unanswered answerable cases count as zero coverage so an abstention can
    // never raise this number.
    answerFactCoverage: meanOrNull(withFacts.map((item) => item.factCoverage ?? 0)),
    verifierUnsupportedClaimRate: claimTotal === 0 ? null : round(unsupportedTotal / claimTotal),
    temporalVersionAccuracy: rateOrNull(
      versioned,
      (item) => item.selectedVersionId === item.expectedVersionId,
    ),
    errorRate:
      cases.length === 0 ? 0 : round(cases.filter((item) => item.errorCode).length / cases.length),
    latencyMsP50: percentile(
      cases.map((item) => item.latencyMs),
      50,
    ),
    latencyMsP95: percentile(
      cases.map((item) => item.latencyMs),
      95,
    ),
    failureCounts,
  };
}

function caseSplit(testCase: LegalEvalCase): string | null {
  return testCase.split ?? null;
}

function versionFromResult(result: RagQueryResult): string | null {
  const marker = result.warnings
    .map((warning) => /^Applied provision version: (\S+)/u.exec(warning)?.[1])
    .find((value) => value !== undefined);
  return marker ?? null;
}

// A reference fact counts as present if it appears verbatim, or if a written
// (paraphrased) answer contains at least 80% of the fact's content words and
// every number the fact states. The same rule scores every composer, so
// extractive and model answers are compared on equal terms.
const NUMBER_WORDS =
  /^(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakh|lakhs|crore|crores|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)$/u;

export function factPresent(answer: string, fact: string): boolean {
  if (normalizeText(answer).includes(normalizeText(fact))) return true;
  // Words are compared by a five-letter stem ("connected" ~ "connection");
  // number words are left to the exact number check below.
  const stems = (text: string) =>
    contentTokens(text)
      .filter((word) => !NUMBER_WORDS.test(word))
      .map((word) => word.slice(0, 5));
  const factWords = [...new Set(stems(fact))];
  const factNumbers = extractNumbers(fact);
  // Facts that are mostly a quantity ("one hundred and eighty-two days")
  // need their number and any remaining words.
  if (factWords.length < 2 && factNumbers.length === 0) return false;
  const answerWords = new Set(stems(answer));
  const shared = factWords.filter((word) => answerWords.has(word)).length;
  const answerNumbers = new Set(extractNumbers(answer));
  const wordShare = factWords.length === 0 ? 1 : shared / factWords.length;
  return wordShare >= 0.8 && factNumbers.every((value) => answerNumbers.has(value));
}

function normalizeText(text: string): string {
  return text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ');
}

function uniqueUpper(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.toUpperCase()))];
}

function recall(found: readonly string[], expected: readonly string[]): number {
  if (expected.length === 0) return 1;
  return round(
    expected.filter((item) => found.includes(item.toUpperCase())).length / expected.length,
  );
}

function rateOrNull<T>(items: readonly T[], predicate: (item: T) => boolean): number | null {
  if (items.length === 0) return null;
  return round(items.filter(predicate).length / items.length);
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return round(sorted[Math.max(0, index)] ?? 0);
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}
