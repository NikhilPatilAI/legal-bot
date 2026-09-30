import { AppError } from '../errors.js';
import {
  describeInterval,
  type HistoricalProvisionStore,
  type HistoricalResolution,
} from './temporal/historical-provision-store.js';
import { contentTokens, type AnswerVerifier } from './verification/claim-verifier.js';

export type LegalStatus = 'current' | 'historical' | 'amended' | 'superseded' | 'unknown';

export interface RagQueryInput {
  question: string;
  legalCategory: string;
  jurisdiction: string;
  asOfDate?: string;
  conversationId?: string;
  resultLimit: number;
}

export interface RagEvidence {
  chunkId: string;
  documentId: string;
  title: string;
  authority: string;
  sectionIdentifier: string;
  sectionHeading: string | null;
  pageStart: number;
  pageEnd: number;
  officialSourceUrl: string | null;
  effectiveDate: string | null;
  retrievalDate: string;
  sha256: string;
  legalStatus: LegalStatus;
  text: string;
  score: number;
}

export interface RagRetriever {
  search(input: RagQueryInput, signal?: AbortSignal): Promise<RagEvidence[]>;
  status(): Promise<RagCorpusStatus>;
}

export interface RagComposer {
  readonly mode: 'deterministic_extract' | 'azure_openai';
  compose(
    question: string,
    evidence: readonly RagEvidence[],
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface RagCorpusStatus {
  state: 'ready' | 'not_ready';
  indexSchemaVersion: string;
  lastSuccessfulIngestionAt: string | null;
  categories: Array<{
    category: string;
    documents: number;
    chunks: number;
    state: 'enabled' | 'experimental' | 'blocked';
  }>;
  limitations: string[];
}

export interface RagQueryResult {
  answer: string;
  abstained: boolean;
  answerMode: RagComposer['mode'];
  citations: Array<Omit<RagEvidence, 'text' | 'score' | 'legalStatus' | 'chunkId'>>;
  retrievedSources: Array<{ chunkId: string; sectionIdentifier: string; score: number }>;
  applicableDate: string | null;
  warnings: string[];
  corpusLimitations: string[];
  requestId: string;
  disclaimer: string;
}

export type RagProgressStage = 'checking_scope' | 'retrieving_sources' | 'drafting_answer';
export interface RagProgressEvent {
  stage: RagProgressStage;
  message: string;
}
export type RagProgressReporter = (event: RagProgressEvent) => void;

export interface LegalRagClient {
  status(): Promise<RagCorpusStatus>;
  query(
    input: RagQueryInput,
    requestId: string,
    signal?: AbortSignal,
    reportProgress?: RagProgressReporter,
  ): Promise<RagQueryResult>;
}

// Words that name the section rather than its subject; they cannot show that a
// question is about a particular recorded fragment.
const TEMPORAL_GENERIC_TOKENS = new Set(
  [
    'corporate',
    'social',
    'responsibility',
    'csr',
    'board',
    'directors',
    'companies',
    'provision',
  ].flatMap((word) => contentTokens(word)),
);

const disclaimer =
  'Legal information only; not legal advice. Verify the current official text and consult a qualified professional for your circumstances.';

export class LegalRagService implements LegalRagClient {
  private activeQueries = 0;
  constructor(
    private readonly retriever: RagRetriever,
    private readonly composer: RagComposer,
    private readonly timeoutMs = 30_000,
    private readonly verifier?: AnswerVerifier,
    private readonly verificationThreshold = 0.5,
    private readonly history?: HistoricalProvisionStore,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid RAG deadline');
    if (this.verificationThreshold <= 0 || this.verificationThreshold > 1)
      throw new Error('Invalid verification threshold');
  }

  status(): Promise<RagCorpusStatus> {
    return this.retriever.status();
  }

  async query(
    input: RagQueryInput,
    requestId: string,
    signal?: AbortSignal,
    reportProgress?: RagProgressReporter,
  ): Promise<RagQueryResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let rejectDeadline: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const rejectCancelled = () =>
      rejectDeadline(new AppError(504, 'rag_timeout', 'The legal answer request timed out.'));
    controller.signal.addEventListener('abort', rejectCancelled, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      if (controller.signal.aborted)
        throw new AppError(504, 'rag_timeout', 'The legal answer request timed out.');
      if (this.activeQueries >= 4)
        throw new AppError(429, 'rag_busy', 'The legal answer service is busy. Try again later.');
      this.activeQueries += 1;
      return await Promise.race([
        this.queryWithinDeadline(input, requestId, controller.signal, reportProgress).finally(
          () => {
            // Retain the permit if an upstream ignores cancellation and keeps working.
            this.activeQueries -= 1;
          },
        ),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectCancelled);
    }
  }

  private async queryWithinDeadline(
    input: RagQueryInput,
    requestId: string,
    signal: AbortSignal,
    reportProgress?: RagProgressReporter,
  ): Promise<RagQueryResult> {
    signal.throwIfAborted();
    const question = input.question.normalize('NFKC').trim();
    if (
      !question ||
      Array.from(question).length > 4_000 ||
      Buffer.byteLength(question, 'utf8') > 16_000 ||
      !Number.isSafeInteger(input.resultLimit) ||
      input.resultLimit < 1 ||
      input.resultLimit > 10
    ) {
      throw new AppError(
        422,
        'validation_failed',
        'Question or result limit is outside the supported range.',
      );
    }
    input = { ...input, question };
    reportProgress?.({
      stage: 'checking_scope',
      message: 'Checking the question against the enabled legal corpus',
    });
    const limitations = (await this.retriever.status()).limitations;
    if (
      input.jurisdiction.toLocaleLowerCase('en-US') !== 'india' ||
      !['all', 'corporate'].includes(input.legalCategory)
    ) {
      return this.abstention(
        requestId,
        'The requested jurisdiction or legal category is outside this test corpus.',
        limitations,
      );
    }
    if (explicitlyRequestsForeignLaw(input.question)) {
      return this.abstention(
        requestId,
        'The question explicitly requests a foreign jurisdiction that is outside this India-only test corpus.',
        limitations,
      );
    }
    if (explicitlyRequestsCriminalViolenceLaw(input.question)) {
      return this.abstention(
        requestId,
        "The enabled corpus does not contain sufficient relevant criminal-law evidence to answer homicide or punishment questions reliably. No supported answer or citation is available from this corpus. If anyone may be in immediate danger, call India's emergency number 112.",
        limitations,
      );
    }
    if (input.asOfDate && !this.history) {
      return this.abstention(
        requestId,
        'Historical retrieval is unavailable because this source has no verified effective-date interval.',
        limitations,
        input.asOfDate,
      );
    }

    let evidence: RagEvidence[];
    try {
      reportProgress?.({
        stage: 'retrieving_sources',
        message: 'Retrieving matching legal sources',
      });
      evidence = await this.retriever.search(input, signal);
    } catch {
      if (signal?.aborted) throw new AppError(504, 'rag_timeout', 'The legal search timed out.');
      throw new AppError(
        503,
        'search_unavailable',
        'The legal corpus search is temporarily unavailable.',
      );
    }
    if (evidence.length === 0)
      return this.abstention(
        requestId,
        'The available official evidence is insufficient to answer this question.',
        limitations,
      );

    const requestedSection = extractSection(input.question);
    if (requestedSection && !evidence.some((item) => item.sectionIdentifier === requestedSection)) {
      return this.abstention(
        requestId,
        `Section ${requestedSection} was not found in the enabled source.`,
        limitations,
        input.asOfDate ?? null,
      );
    }

    // As-of-date questions never use the undated corpus text. The provision is
    // the section named in the question or, failing that, the top retrieved
    // section; only its verified historical versions become evidence.
    let temporalWarnings: string[] = [];
    let applicableDate: string | null = null;
    let selected: RagEvidence[];
    if (input.asOfDate && this.history) {
      const temporal = this.selectHistoricalEvidence(
        input.question,
        input.asOfDate,
        requestedSection ?? evidence[0]!.sectionIdentifier,
        requestedSection === null,
      );
      if ('abstain' in temporal)
        return this.abstention(requestId, temporal.abstain, limitations, input.asOfDate);
      selected = temporal.evidence;
      temporalWarnings = temporal.warnings;
      applicableDate = input.asOfDate;
    } else {
      selected = evidence.slice(0, input.resultLimit);
      const amended = new Set(this.history?.amendedSections() ?? []);
      for (const section of new Set(selected.map((item) => item.sectionIdentifier.toUpperCase())))
        if (amended.has(section))
          temporalWarnings.push(
            `Section ${section} has recorded amendments; the indexed text may not be the version in force today. Ask with an as-of date to use verified historical text.`,
          );
    }
    if (Buffer.byteLength(JSON.stringify(selected), 'utf8') > 80_000) {
      throw new AppError(
        502,
        'search_invalid_response',
        'The legal corpus returned an unsupported response.',
      );
    }
    signal.throwIfAborted();
    const warnings = [
      ...new Set([
        ...(applicableDate
          ? []
          : [
              'The enabled source has legalStatus "unknown" and is not verified as a current consolidation.',
            ]),
        ...temporalWarnings,
        ...(this.composer.mode === 'deterministic_extract'
          ? ['This answer is a deterministic evidence summary, not live model generation.']
          : []),
      ]),
    ];
    let answer: string;
    try {
      reportProgress?.({
        stage: 'drafting_answer',
        message: 'Drafting an answer from the retrieved sources',
      });
      answer = await this.composer.compose(input.question, selected, signal);
    } catch {
      if (signal?.aborted)
        throw new AppError(504, 'rag_timeout', 'The legal answer request timed out.');
      throw new AppError(
        503,
        'model_unavailable',
        'The legal answer model is temporarily unavailable.',
      );
    }
    if (!answer.trim() || Buffer.byteLength(answer, 'utf8') > 32_000)
      throw new AppError(
        502,
        'model_invalid_response',
        'The answer provider returned an invalid response.',
      );
    if (answer.startsWith('LEGALBOT_ABSTAIN:')) {
      const reason =
        answer.slice('LEGALBOT_ABSTAIN:'.length).trim() ||
        'The available official evidence is insufficient to answer this question.';
      return this.abstention(requestId, reason, limitations, applicableDate);
    }

    // Post-generation verification. When a verifier is configured, every
    // material statement in the drafted answer is checked against the exact
    // evidence given to the composer before the answer is allowed out. A
    // contradicted claim, a fabricated section citation or quotation, or a
    // supported-claim rate below the threshold withholds the answer. Claims the
    // verifier could not check (for example, an unavailable semantic
    // classifier) count as not supported: the policy fails closed. This runs
    // inside the shared request deadline.
    if (this.verifier) {
      signal.throwIfAborted();
      const verification = await this.verifier.verify(answer, selected, signal);
      const failsVerification =
        verification.claimCount > 0 &&
        (verification.contradictedClaimCount > 0 ||
          verification.unverifiedCitationCount > 0 ||
          verification.unverifiedQuotationCount > 0 ||
          verification.supportedClaimRate < this.verificationThreshold);
      if (failsVerification) {
        return this.abstention(
          requestId,
          'The drafted answer could not be verified against the retrieved official sources, so it was withheld. Please rephrase or consult the cited provisions directly.',
          limitations,
          applicableDate,
        );
      }
      warnings.push(
        `Answer verification (${verification.verifierMode}, lexical screen, not legal review): ${verification.supportedClaimCount} of ${verification.claimCount} statements were matched to retrieved sources.`,
      );
      if (verification.unverifiedClaimCount > 0)
        warnings.push(
          `${verification.unverifiedClaimCount} statement(s) could not be semantically checked because the verifier was unavailable.`,
        );
      if (verification.qualificationNotMentionedSections.length > 0)
        warnings.push(
          `The cited text of ${verification.qualificationNotMentionedSections
            .map((id) =>
              /^page\s/iu.test(id) ? `page ${id.replace(/^page\s+/iu, '')}` : `section ${id}`,
            )
            .join(', ')} contains provisos or exceptions that this answer does not mention.`,
        );
    }

    return {
      answer,
      abstained: false,
      answerMode: this.composer.mode,
      citations: uniqueCitationEvidence(selected).map((item) => ({
        documentId: item.documentId,
        title: item.title,
        authority: item.authority,
        sectionIdentifier: item.sectionIdentifier,
        sectionHeading: item.sectionHeading,
        pageStart: item.pageStart,
        pageEnd: item.pageEnd,
        officialSourceUrl: item.officialSourceUrl,
        effectiveDate: item.effectiveDate,
        retrievalDate: item.retrievalDate,
        sha256: item.sha256,
      })),
      retrievedSources: selected.map((item) => ({
        chunkId: item.chunkId,
        sectionIdentifier: item.sectionIdentifier,
        score: item.score,
      })),
      applicableDate,
      warnings,
      corpusLimitations: limitations,
      requestId,
      disclaimer,
    };
  }

  private selectHistoricalEvidence(
    question: string,
    asOfDate: string,
    section: string,
    inferred: boolean,
  ): { evidence: RagEvidence[]; warnings: string[] } | { abstain: string } {
    const history = this.history!;
    const label = section.toUpperCase();
    if (asOfDate > new Date().toISOString().slice(0, 10))
      return {
        abstain:
          'The requested date is in the future, so the applicable law cannot be established.',
      };
    const resolutions = history.resolve(section, asOfDate);
    if (resolutions[0]?.kind === 'unknown_section')
      return {
        abstain: `No verified historical text is recorded for Section ${label}, so its version on ${asOfDate} cannot be established.`,
      };
    // A recorded fragment only answers the question if the question is about
    // that fragment. Otherwise a question about an unrecorded part of the same
    // section would be answered from unrelated historical text.
    const questionTokens = new Set(
      contentTokens(question).filter((token) => !TEMPORAL_GENERIC_TOKENS.has(token)),
    );
    const relevant = (fragmentText: string) => {
      const fragmentTokens = new Set(contentTokens(fragmentText));
      let shared = 0;
      for (const token of questionTokens) if (fragmentTokens.has(token)) shared += 1;
      return shared >= 2;
    };
    const matches = resolutions.filter(
      (item): item is Extract<HistoricalResolution, { kind: 'match' }> =>
        item.kind === 'match' && relevant(`${item.fragment.label} ${item.version.text}`),
    );
    if (matches.length === 0 && resolutions.some((item) => item.kind === 'match'))
      return {
        abstain: `The question concerns a part of Section ${label} for which no verified historical text is recorded, so its version on ${asOfDate} cannot be established.`,
      };
    const notInForce = resolutions.filter(
      (item): item is Extract<HistoricalResolution, { kind: 'not_in_force' }> =>
        item.kind === 'not_in_force',
    );
    if (matches.length === 0) {
      if (notInForce.length > 0 && !resolutions.some((item) => item.kind === 'unverified_version'))
        return {
          abstain: `The recorded parts of Section ${label} were not in force on ${asOfDate}; the earliest recorded commencement is ${
            notInForce.map((item) => item.commencement).sort()[0]!
          }.`,
        };
      return {
        abstain: `No verified version of Section ${label} is recorded for ${asOfDate}, so the applicable text cannot be established.`,
      };
    }
    const warnings = [
      ...(inferred
        ? [
            `The as-of date was applied to Section ${label}, the top retrieved provision; name the section in the question if a different provision is intended.`,
          ]
        : []),
      ...matches.map(
        (item) =>
          `Applied provision version: ${item.version.versionId} (Section ${item.fragment.section}, ${item.fragment.label}; in force ${describeInterval(item.version)}; date evidence ${item.version.dateReview.replaceAll('_', ' ')}).`,
      ),
      `Historical text covers only the recorded fragments of Section ${label}; other parts of the section are not answered for ${asOfDate}.`,
    ];
    for (const item of resolutions) {
      if (item.kind === 'not_in_force')
        warnings.push(`${item.fragment.label} was not yet in force on ${asOfDate}.`);
      if (item.kind === 'unverified_version' || item.kind === 'unknown_date')
        warnings.push(
          `${item.fragment.label} is excluded because no verified version is recorded for ${asOfDate}.`,
        );
    }
    return {
      evidence: matches.map((item) => history.toEvidence(item.fragment, item.version)),
      warnings,
    };
  }

  private abstention(
    requestId: string,
    answer: string,
    limitations: string[],
    applicableDate: string | null = null,
  ): RagQueryResult {
    return {
      answer,
      abstained: true,
      answerMode: this.composer.mode,
      citations: [],
      retrievedSources: [],
      applicableDate,
      warnings: [],
      corpusLimitations: limitations,
      requestId,
      disclaimer,
    };
  }
}

export class DeterministicExtractComposer implements RagComposer {
  readonly mode = 'deterministic_extract' as const;

  async compose(question: string, evidence: readonly RagEvidence[]): Promise<string> {
    // Extracts are ranked by overlap with the question so the sentence that
    // answers it is not crowded out by the opening sentences of the evidence.
    // Question words are weighted by rarity among the candidate sentences, so a
    // word every page repeats (the Act's own name) does not outrank the
    // specific term asked about. Ties keep evidence order; the output is still
    // verbatim source text.
    const questionTokens = new Set(contentTokens(question));
    const candidates = [...new Set(evidence.flatMap((item) => readableSentences(item.text)))];
    const sentenceTokens = candidates.map((sentence) => new Set(contentTokens(sentence)));
    const weight = new Map(
      [...questionTokens].map((token) => {
        const frequency = sentenceTokens.filter((tokens) => tokens.has(token)).length;
        return [token, Math.log(1 + candidates.length / Math.max(1, frequency))];
      }),
    );
    const sentences = candidates
      .map((sentence, index) => ({
        sentence,
        index,
        score: weightedOverlap(weight, sentenceTokens[index]!),
      }))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 5)
      .map((item) => item.sentence);
    if (sentences.length === 0) return '';
    const blocks = ['## Summary', '', ...sentences.slice(0, 3).map((sentence) => `- ${sentence}`)];
    if (/\b(?:checklist|steps?|what (?:do|should)|how (?:do|should))\b/iu.test(question)) {
      blocks.push(
        '',
        '## Compliance checklist',
        '',
        ...complianceChecklist(sentences).map((item) => `- [ ] ${item}`),
      );
    }
    return blocks.join('\n');
  }
}

function weightedOverlap(
  weight: ReadonlyMap<string, number>,
  sentenceTokens: ReadonlySet<string>,
): number {
  let score = 0;
  for (const [token, value] of weight) if (sentenceTokens.has(token)) score += value;
  return score;
}

function readableSentences(text: string): string[] {
  const normalized = text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return (
    normalized
      // Statutory text often chains sub-sections with ":" or ";" rather than a
      // full stop; those boundaries are split too so one long page is not a
      // single oversized "sentence" that the length filter discards.
      .split(/(?<=[.!?])\s+(?=(?:\(\d+\)\s*)?[A-Z])|(?<=[:;])\s+(?=\(\d{1,3}\)\s|Provided\b)/u)
      .map((sentence) => sentence.replace(/^\(\d+\)\s*/u, '').trim())
      .filter(
        (sentence) =>
          sentence.length >= 35 && sentence.length <= 700 && looksLikeEnglishLegalText(sentence),
      )
  );
}

function looksLikeEnglishLegalText(sentence: string): boolean {
  if (/(?:Hkk|jkti|vlk|μ|\[[A-Za-z]|=[A-Za-z])/u.test(sentence.slice(0, 100))) return false;
  const words = sentence.toLocaleLowerCase('en-US').match(/[a-z]{2,}/gu) ?? [];
  const legalEnglish = new Set([
    'a',
    'and',
    'application',
    'be',
    'board',
    'class',
    'company',
    'date',
    'directors',
    'each',
    'every',
    'fee',
    'filed',
    'for',
    'form',
    'from',
    'has',
    'heading',
    'in',
    'is',
    'notice',
    'of',
    'on',
    'opposition',
    'publication',
    'registration',
    'section',
    'shall',
    'source',
    'test',
    'text',
    'the',
    'to',
    'trademark',
    'under',
    'verified',
    'where',
    'which',
    'with',
    'within',
  ]);
  return words.length >= 5 && words.filter((word) => legalEnglish.has(word)).length >= 3;
}

function complianceChecklist(sentences: readonly string[]): string[] {
  const source = sentences.join(' ');
  const checklist: string[] = [];
  if (/Form\s+TM-O/iu.test(source))
    checklist.push('Prepare the notice of opposition in Form TM-O.');
  const deadline = /within\s+(\w+(?:\s+\w+){0,2})\s+from\s+the\s+date\s+of\s+publication/iu.exec(
    source,
  )?.[1];
  if (deadline)
    checklist.push(
      `Record the Trade Marks Journal publication date and file within ${deadline} of publication.`,
    );
  if (/fee\s+in\s+respect\s+of\s+each\s+class/iu.test(source))
    checklist.push(
      'For a multi-class application, account for the filing fee for every class opposed.',
    );
  if (checklist.length === 0)
    checklist.push(
      ...sentences
        .slice(0, 4)
        .map((sentence) => `Verify and document this source requirement: ${sentence}`),
    );
  checklist.push('Verify the current official rule and applicable fee before filing.');
  return [...new Set(checklist)];
}

export function extractSection(question: string): string | null {
  return (
    /\bsection\s+(\d{1,3}[A-Z]{0,3})\b/iu.exec(question.normalize('NFKC'))?.[1]?.toUpperCase() ??
    null
  );
}

function explicitlyRequestsForeignLaw(question: string): boolean {
  return /\b(?:france|french|germany|german|england|english law|united kingdom|uk|uk law|united states|u\.s\. law|us law|american law|delaware|new york law|california law|canada|canadian|australia|australian|singapore|singaporean|hong kong law|european union law|eu law)\b/iu.test(
    question,
  );
}

function explicitlyRequestsCriminalViolenceLaw(question: string): boolean {
  return /\b(?:kill(?:ed|ing)?|murder|homicide|manslaughter)\b/iu.test(question);
}

function uniqueCitationEvidence(evidence: readonly RagEvidence[]): RagEvidence[] {
  const citations = new Map<string, RagEvidence>();
  for (const item of evidence) {
    const key = `${item.documentId}|${item.sectionIdentifier}|${item.pageStart}|${item.pageEnd}`;
    if (!citations.has(key)) citations.set(key, item);
  }
  return [...citations.values()];
}
