import type { RagEvidence } from '../rag-service.js';

// Post-generation verification. Every material statement in a drafted legal
// answer is checked against the retrieved evidence before the answer is allowed
// to reach a user.
//
// The deterministic verifier binds each claim to the passages of the sections it
// cites (or to all evidence when it cites none), finds the best-matching source
// sentence, and then checks that the claim preserves the source's polarity,
// numbers, modality, and stated qualifications. It never calls a model, so it is
// cheap, reproducible, and safe to run inline. It is a lexical screen, not proof
// of legal entailment: a claim can pass every check and still misstate the law,
// and the evaluation reports measure its false acceptances and rejections.
//
// An optional semantic classifier receives only the bound passages. It can
// downgrade a claim but can never create support that the deterministic checks
// did not find. When it is configured but fails, the claim is reported as
// "unverified" rather than silently treated as supported.

export type ClaimStatus =
  | 'supported'
  | 'unsupported'
  | 'contradicted'
  | 'unverified_citation'
  | 'unverified_quotation'
  | 'unverified';

export type ClaimReason =
  | 'no_lexical_support'
  | 'cited_passage_does_not_support'
  | 'cited_section_not_retrieved'
  // The cited section barely supports the claim while another retrieved
  // section states it almost word for word: the citation is wrong.
  | 'cited_section_mismatch'
  // The claim copies the source except for its negation or modal words
  // ("shall" -> "shall not", "shall" -> "may").
  | 'verbatim_edit'
  | 'quotation_not_found'
  | 'polarity_mismatch'
  | 'number_not_in_source'
  | 'modality_mismatch'
  | 'denies_source_qualification'
  | 'semantic_contradicted'
  | 'semantic_unsupported'
  | 'semantic_unavailable';

export interface VerifiedClaim {
  id: string;
  text: string;
  status: ClaimStatus;
  reasons: ClaimReason[];
  supportScore: number;
  matchedChunkIds: string[];
  matchedSectionIdentifier: string | null;
  citedSection: string | null;
  citedSections: string[];
  quotation: string | null;
  supportingText: string | null;
}

export interface AnswerVerificationReport {
  verifierMode: 'deterministic' | 'deterministic_plus_semantic';
  claimCount: number;
  supportedClaimCount: number;
  unsupportedClaimCount: number;
  unverifiedCitationCount: number;
  unverifiedQuotationCount: number;
  contradictedClaimCount: number;
  unverifiedClaimCount: number;
  supportedClaimRate: number;
  citationSupportRate: number;
  // Sections whose bound passages state a proviso or exception that the answer
  // never mentions. This is a warning signal, not a claim-level verdict.
  qualificationNotMentionedSections: string[];
  claims: VerifiedClaim[];
}

// The service depends only on this narrow contract, so an alternative verifier
// can be substituted without touching the query pipeline.
export interface AnswerVerifier {
  verify(
    answer: string,
    evidence: readonly RagEvidence[],
    signal?: AbortSignal,
  ): Promise<AnswerVerificationReport>;
}

// Optional semantic layer. It receives only the passages the claim is bound to.
// Implementations may throw; the verifier converts failures into "unverified".
export interface ClaimSupportClassifier {
  classify(
    claim: string,
    evidence: readonly RagEvidence[],
    signal?: AbortSignal,
  ): Promise<'supported' | 'unsupported' | 'contradicted'>;
}

export interface ClaimVerifierOptions {
  supportThreshold?: number;
  contradictionThreshold?: number;
  minClaimCharacters?: number;
  classifier?: ClaimSupportClassifier;
}

// "Based on the supplied FAQ, ...", "According to the provided extract, ...".
const EVIDENCE_FRAMING =
  /^\s*(?:based on|according to|as per|under|in|from) (?:the |this )?(?:supplied|provided|quoted|cited|retrieved)\b[^,]{0,120},\s*/iu;
// Model notes in brackets: "[the supplied extract ends before ...]".
const EVIDENCE_NOTE =
  /\s*\[(?:the |this )?(?:supplied|provided|quoted|retrieved)\b[^\]]{0,200}\]/giu;

function assertedText(text: string): string {
  const stripped = text.replace(EVIDENCE_NOTE, '').replace(EVIDENCE_FRAMING, '');
  return stripped.trim().length > 0 ? stripped : text;
}

function isYearOrDate(value: string): boolean {
  return value.startsWith('d:') || /^n:(?:19|20)\d{2}$/u.test(value);
}

// Variants of a source passage for quotation matching: as extracted, and with
// amendment apparatus removed ("claimed [in FORM GSTR-02] 143 by" -> "claimed
// by") and ordinals rejoined ("1 st April" -> "1st April"). A quotation that
// omits an inserted amendment marker is still a faithful quotation; it still
// cannot add words that are not in the source.
function quotationSources(rawText: string): string[] {
  const rejoin = (text: string) => text.replace(/\b(\d{1,2}) (st|nd|rd|th)\b/gu, '$1$2');
  // Insertions are removed from the raw text, before statute cleaning strips
  // the square brackets that mark them.
  const withoutInsertions = rawText.replace(/\s*\[[^\]]{0,200}\]\s*\d{0,3}\s*/gu, ' ');
  const variants = [rawText, withoutInsertions].flatMap((text) => {
    const normalized = normalizeForMatch(cleanStatuteText(text));
    return [normalized, rejoin(normalized)];
  });
  return [...new Set(variants)].map(withoutQuoteMarks);
}

// Wrong-citation test: another retrieved section supports the claim at least
// this well, and at least this much better than the cited section.
const WRONG_CITATION_MATCH = 0.9;
const WRONG_CITATION_MARGIN = 0.25;

// Words that change a rule's meaning without changing its wording: negation
// and modal verbs. Everything else is the "core" of a sentence.
const EDIT_WORDS = new Set([
  'not',
  'no',
  'never',
  'nor',
  'none',
  'cannot',
  'shall',
  'may',
  'must',
  'should',
  'can',
  'will',
  'need',
]);
const MIN_VERBATIM_CORE_WORDS = 8;

function wordsOf(text: string): string[] {
  return (
    cleanStatuteText(text)
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[a-z0-9]+/gu) ?? []
  );
}

// Splits words into core words and, for each core word, the negation/modal
// words directly before it.
function coreWithEdits(words: readonly string[]): { core: string[]; edits: string[] } {
  const core: string[] = [];
  const edits: string[] = [];
  let pending: string[] = [];
  for (const word of words) {
    if (EDIT_WORDS.has(word)) pending.push(word);
    else {
      core.push(word);
      edits.push(pending.join(' '));
      pending = [];
    }
  }
  return { core, edits };
}

/**
 * Whether a claim copies a source sentence. 'same': the claim's words occur
 * contiguously in a passage with the same negation and modal words. 'edited':
 * the core words occur contiguously but a negation or modal word differs.
 * null: not a verbatim copy (a paraphrase), so the ordinary checks apply.
 */
export function verbatimCopy(claim: string, passages: readonly string[]): 'same' | 'edited' | null {
  const claimed = coreWithEdits(wordsOf(claim.replace(FRAMING_PHRASE, '')));
  if (claimed.core.length < MIN_VERBATIM_CORE_WORDS) return null;
  let edited = false;
  for (const passage of passages) {
    const source = coreWithEdits(wordsOf(passage));
    for (let start = 0; start + claimed.core.length <= source.core.length; start += 1) {
      let match = true;
      for (let offset = 0; offset < claimed.core.length && match; offset += 1)
        match = source.core[start + offset] === claimed.core[offset];
      if (!match) continue;
      // Edit words before the first core word are not compared: the claim may
      // begin mid-sentence ("... shall be" -> "the report shall").
      let differs = false;
      for (let offset = 1; offset < claimed.core.length && !differs; offset += 1)
        differs = source.edits[start + offset] !== claimed.edits[offset];
      if (!differs) return 'same';
      edited = true;
    }
  }
  return edited ? 'edited' : null;
}

const DISCLAIMER_MARKERS = [
  'legal information only',
  'not legal advice',
  'consult a qualified',
  'legal currentness is unverified',
  'draft for professional review',
];

interface PreparedPassage {
  evidence: RagEvidence;
  normalized: string;
  units: SourceUnit[];
  tokens: Set<string>;
  numbers: Set<string>;
}

interface SourceUnit {
  text: string;
  tokens: Set<string>;
}

export class DeterministicClaimVerifier implements AnswerVerifier {
  private readonly supportThreshold: number;
  private readonly contradictionThreshold: number;
  private readonly minClaimCharacters: number;
  private readonly classifier: ClaimSupportClassifier | null;

  constructor(options: ClaimVerifierOptions = {}) {
    this.supportThreshold = options.supportThreshold ?? 0.5;
    this.contradictionThreshold = options.contradictionThreshold ?? 0.8;
    this.minClaimCharacters = options.minClaimCharacters ?? 25;
    this.classifier = options.classifier ?? null;
    if (this.supportThreshold <= 0 || this.supportThreshold > 1)
      throw new Error('supportThreshold must be within (0, 1]');
    if (this.contradictionThreshold < this.supportThreshold || this.contradictionThreshold > 1)
      throw new Error('contradictionThreshold must be within [supportThreshold, 1]');
  }

  async verify(
    answer: string,
    evidence: readonly RagEvidence[],
    signal?: AbortSignal,
  ): Promise<AnswerVerificationReport> {
    const prepared = evidence.map(preparePassage);
    const claims: VerifiedClaim[] = [];
    let index = 0;
    for (const { text, leadIn } of extractClaimContexts(answer, this.minClaimCharacters)) {
      signal?.throwIfAborted();
      index += 1;
      claims.push(await this.classifyClaim(`claim_${index}`, text, prepared, signal, leadIn));
    }
    return summarize(
      claims,
      this.classifier ? 'deterministic_plus_semantic' : 'deterministic',
      qualificationNotMentioned(answer, claims, prepared),
    );
  }

  private async classifyClaim(
    id: string,
    rawText: string,
    prepared: readonly PreparedPassage[],
    signal?: AbortSignal,
    leadIn = '',
  ): Promise<VerifiedClaim> {
    const quotations = extractQuotations(rawText);
    const citedSections = extractCitedSections(rawText);
    // What the claim asserts, without references to the evidence itself
    // ("Based on the supplied FAQ, ...", "[the extract ends here]"): those
    // words are about the source, not the law, and only dilute the match.
    const text = assertedText(rawText);
    const base = {
      id,
      text: rawText,
      citedSection: citedSections[0] ?? null,
      citedSections,
      quotation: quotations[0] ?? null,
    };

    // Citation binding. A claim that cites sections is judged only against the
    // passages of those sections. A cited section the evidence never provided
    // is a fabricated citation unless another cited, retrieved passage itself
    // refers to it (for example "section 135 ... report under section 134").
    //
    // Statutory sentences also mention other sections ("nothing in this
    // sub-section and in section 174 shall apply"). Such a sentence is bound to
    // the retrieved passage that names those sections, but only when that
    // passage supports it near-verbatim (contradictionThreshold), so a loose
    // paraphrase cannot borrow support from an unrelated passage.
    const claimTokens = new Set(contentTokens(text));
    let scope: readonly PreparedPassage[] = prepared;
    if (citedSections.length > 0) {
      // Page-level evidence (whole-document corpora labelled "Page N") has no
      // section identifiers. There a cited section binds to a retrieved page
      // whose own text names it, as "section 21" or as a statute heading such
      // as "21. (1)"; section-structured evidence keeps strict identifier
      // binding.
      const pageNamed = (item: PreparedPassage) =>
        item.evidence.sectionIdentifier.startsWith('Page ')
          ? citedSections.filter((section) => pageNamesSection(item.evidence.text, section))
          : [];
      const retrieved = new Set([
        ...prepared.map((item) => item.evidence.sectionIdentifier.toUpperCase()),
        ...prepared.flatMap(pageNamed),
      ]);
      const bound = prepared.filter(
        (item) =>
          citedSections.includes(item.evidence.sectionIdentifier.toUpperCase()) ||
          pageNamed(item).length > 0,
      );
      const referencedByBound = new Set(
        bound.flatMap((item) => extractCitedSections(item.evidence.text)),
      );
      const missing = citedSections.filter(
        (section) => !retrieved.has(section) && !referencedByBound.has(section),
      );
      const boundSupport = bestSupport(claimTokens, bound);
      if (
        bound.length === 0 ||
        missing.length > 0 ||
        !boundSupport ||
        boundSupport.score < this.supportThreshold
      ) {
        // The citation phrase itself, with its neighbouring words, must occur in
        // the passage: "and in section 174 shall apply" is quoted source text,
        // while "Under Section 174, <text of section 173>" is a framing citation.
        const citationPhrases = citationContexts(text);
        const mentioning = prepared.filter(
          (item) =>
            !bound.includes(item) &&
            citationPhrases.length > 0 &&
            citationPhrases.every((phrase) => stripPunctuation(item.normalized).includes(phrase)),
        );
        const quoted = bestSupport(claimTokens, mentioning);
        if (quoted && quoted.score >= this.contradictionThreshold) scope = mentioning;
        else if (bound.length === 0 || missing.length > 0)
          return verdict(base, 'unverified_citation', ['cited_section_not_retrieved'], 0, [], null);
        else scope = bound;
      } else scope = bound;

      // Wrong citation: the cited section only loosely supports the claim
      // while another retrieved section states it almost word for word
      // ("Under Section 5, <the text of section 4>"). Neighbouring sections
      // share vocabulary, so a loose match to the cited one is not enough.
      if (scope === bound) {
        const asserted = new Set(contentTokens(text.replace(FRAMING_PHRASE, '')));
        const tokens = asserted.size > 0 ? asserted : claimTokens;
        const cited = bestSupport(tokens, bound);
        const elsewhere = bestSupport(
          tokens,
          prepared.filter((item) => !bound.includes(item)),
        );
        if (
          cited &&
          elsewhere &&
          elsewhere.score >= WRONG_CITATION_MATCH &&
          elsewhere.score - cited.score >= WRONG_CITATION_MARGIN
        )
          return verdict(
            base,
            'unverified_citation',
            ['cited_section_mismatch'],
            cited.score,
            [],
            null,
          );
      }
    }

    // A quoted span must appear verbatim in a bound passage. A genuine quotation
    // does not make the rest of the sentence true, so checking continues.
    for (const quotation of quotations) {
      // Trailing punctuation inside the quotation marks is not part of the
      // quoted source words ("...in India." vs the source's "...in India:").
      // An ellipsis ("... shall endeavour ...") marks omitted words: each
      // quoted fragment must occur in the same bound passage.
      // Nested quotation marks are compared without their style: a quotation
      // may render the source's “tax year” as ‘tax year’.
      const fragments = withoutQuoteMarks(normalizeForMatch(cleanStatuteText(quotation)))
        .split(/\s*(?:\.{3}|…)\s*/u)
        .map((part) => part.replace(/^[.,;:!?\s]+|[.,;:!?\s]+$/gu, ''))
        .filter((part) => part.length >= 8);
      if (
        fragments.length === 0 ||
        !scope.some((item) =>
          quotationSources(item.evidence.text).some((source) =>
            fragments.every((part) => source.includes(part)),
          ),
        )
      )
        return verdict(base, 'unverified_quotation', ['quotation_not_found'], 0, [], null);
    }

    const best = bestSupport(claimTokens, scope);
    const unsupportedReason: ClaimReason =
      citedSections.length > 0 ? 'cited_passage_does_not_support' : 'no_lexical_support';
    if (!best || best.score < this.supportThreshold)
      return verdict(base, 'unsupported', [unsupportedReason], best?.score ?? 0, [], null);

    const matched = [best.passage];
    const reasons: ClaimReason[] = [];
    let status: ClaimStatus = 'supported';
    const downgrade = (next: ClaimStatus, reason: ClaimReason) => {
      reasons.push(reason);
      if (severity(next) > severity(status)) status = next;
    };

    // Numbers and ordinals in the claim must occur in the source span that
    // supports it, not merely somewhere in the passage. A changed number next
    // to a closely matching sentence is a contradiction.
    // When another span supports the claim nearly as well (within 0.2) and
    // contains every number the claim states, that span is used instead: the
    // best-scoring window can be a neighbouring sentence that merely shares
    // words such as the instrument's name.
    const claimNumbers = extractNumbers(text);
    const windowNumbers = new Set(extractNumbers(best.windowText));
    // Years and calendar dates usually identify the instrument ("SEBI's
    // circular of April 23, 2020"); they count as stated when the cited
    // passage or its document title states them. Counts, amounts and periods
    // must still occur next to the supporting sentence.
    const passageDates = new Set(
      scope.flatMap((item) =>
        extractNumbers(`${item.evidence.title}\n${item.evidence.text}`).filter(isYearOrDate),
      ),
    );
    const missingNumbers = claimNumbers.filter(
      (value) => !windowNumbers.has(value) && !(isYearOrDate(value) && passageDates.has(value)),
    );
    // The alternative span is scored on what the claim asserts, without a
    // leading framing phrase that only names the source ("Under Section 96 of
    // the Companies Act, 2013, ..."): the operative proviso rarely repeats the
    // Act's name, while the section's opening sentence does.
    const assertedTokens = new Set(contentTokens(text.replace(FRAMING_PHRASE, '')));
    const alternativeTokens = assertedTokens.size > 0 ? assertedTokens : claimTokens;
    const numberAlternative =
      missingNumbers.length > 0 &&
      scope.some((passage) =>
        passage.units.some((unit, index) => {
          const window = passage.units.slice(index, index + 3);
          const tokens = new Set(window.flatMap((item) => [...item.tokens]));
          if (
            containmentScore(alternativeTokens, tokens) <
            Math.max(this.supportThreshold, best.score - 0.2)
          )
            return false;
          const numbers = new Set(extractNumbers(window.map((item) => item.text).join(' ')));
          return unit.text.length > 0 && claimNumbers.every((value) => numbers.has(value));
        }),
      );
    // A contradiction replaces a source number: the span holds a number of
    // the same kind (count, ordinal or date) that the claim does not state.
    // A claim that keeps every such source number and adds one ("1st April"
    // -> "1 April to 31 March") states something the source does not, which
    // is unsupported rather than contradicted.
    const replaced = missingNumbers.some((value) =>
      [...windowNumbers].some(
        (source) => source.slice(0, 2) === value.slice(0, 2) && !claimNumbers.includes(source),
      ),
    );
    if (missingNumbers.length > 0 && !numberAlternative)
      downgrade(replaced ? 'contradicted' : 'unsupported', 'number_not_in_source');

    // Polarity. "Not more than"-style quantity limits are not negations, and a
    // prohibition framed around an exception ("no company shall ... except
    // with consent") legitimately paraphrases as a positive requirement.
    // List items under an exclusion lead-in ("subject to these exclusions:")
    // restate what the source excludes; their own wording is affirmative while
    // the source's is negated, so polarity cannot be compared item by item and
    // is skipped. Numbers, support and modality are still checked.
    // When several source lines support the claim almost equally, a line with
    // the claim's own polarity is preferred before declaring a mismatch.
    // A statutory sentence often joins clauses of opposite polarity ("the
    // applicant shall send a counter-statement ..., and if he does not do so he
    // shall be deemed to have abandoned"; "... more than 182 days ... but does
    // not include"). Polarity is compared with the clause that best matches the
    // claim, and a clause is split off only where it restates a condition or a
    // contrast, so a negation in the matched clause itself is never discarded.
    // Verbatim copies decide polarity and modality directly. A claim that
    // repeats a source sentence word for word except for "not"/"no" or
    // "shall"/"may" contradicts it, whatever the paraphrase allowances below
    // would excuse ("unless ...", "not less than", mixed modality). A true
    // verbatim copy is consistent by construction and skips those checks.
    const copy = verbatimCopy(
      text,
      scope.map((item) => item.evidence.text),
    );
    if (copy === 'edited') downgrade('contradicted', 'verbatim_edit');
    const claimNegated = isNegated(text);
    const bestUnitScore = containmentScore(claimTokens, best.unit.tokens);
    const matchedClause = bestClause(claimTokens, best.unit.text);
    const sourceText =
      matchedClause && matchedClause.score >= bestUnitScore - 0.1
        ? matchedClause.text
        : best.unit.text;
    const sourceNegated = isNegated(sourceText);
    // A numeric cap written as a prohibition ("No person shall hold office
    // ... in more than twenty companies"; "shall not exceed ten") is the same
    // rule as "may hold office in up to 20 companies" or "the maximum is 10".
    // Only an affirmative claim stating a cap is excused, and only against a
    // source whose one negation is the cap: "a person can hold office in more
    // than twenty companies", "shall not appoint ... not exceeding seven" and
    // "no account may be taken" are still compared. Numbers are checked above.
    const sameCap = !claimNegated && statesPositiveCap(text) && isNegatedCapOnly(sourceText);
    const samePolarityAlternative =
      claimNegated !== sourceNegated &&
      scope.some((passage) =>
        passage.units.some((unit) =>
          clauses(unit.text).some(
            (candidate) =>
              (isNegated(candidate) === claimNegated ||
                // A definition by exclusion ("... means a transaction other
                // than a capital account transaction") restates as "a
                // transaction that is not a capital account transaction".
                (claimNegated && /\bmeans\b.*\bother than\b/iu.test(candidate))) &&
              containmentScore(claimTokens, new Set(contentTokens(candidate))) >=
                Math.max(this.supportThreshold, bestUnitScore - 0.2),
          ),
        ),
      );
    if (
      copy === null &&
      !samePolarityAlternative &&
      !sameCap &&
      !isExclusionaryLeadIn(leadIn) &&
      !(sourceNegated && isExclusionaryLeadIn(text)) &&
      claimNegated !== sourceNegated &&
      !(sourceNegated && isExceptionFramed(best.unit.text))
    )
      downgrade(
        best.score >= this.contradictionThreshold ? 'contradicted' : 'unsupported',
        'polarity_mismatch',
      );

    // Modality. A mandatory rule restated as permissive (or the reverse) is not
    // supported. Only checked when the source sentence has a single modality.
    const claimModality = modality(text);
    const sourceModality = modality(best.unit.text);
    if (
      copy === null &&
      !sameCap &&
      claimModality !== 'none' &&
      claimModality !== 'mixed' &&
      sourceModality !== 'none' &&
      sourceModality !== 'mixed' &&
      claimModality !== sourceModality
    )
      downgrade('unsupported', 'modality_mismatch');

    // A claim that explicitly denies any exception contradicts a bound passage
    // that states a proviso or exception.
    if (deniesQualification(text) && scope.some((item) => hasQualification(item.evidence.text)))
      downgrade('contradicted', 'denies_source_qualification');

    if (status === 'supported' && this.classifier) {
      try {
        const semantic = await this.classifier.classify(
          text,
          scope.map((item) => item.evidence),
          signal,
        );
        if (semantic === 'contradicted') downgrade('contradicted', 'semantic_contradicted');
        else if (semantic === 'unsupported') downgrade('unsupported', 'semantic_unsupported');
      } catch {
        if (signal?.aborted) throw signal.reason ?? new Error('Verification aborted');
        downgrade('unverified', 'semantic_unavailable');
      }
    }

    return verdict(base, status, reasons, best.score, matched, best.unit.text);
  }
}

function severity(status: ClaimStatus): number {
  switch (status) {
    case 'supported':
      return 0;
    case 'unverified':
      return 1;
    case 'unsupported':
      return 2;
    default:
      return 3;
  }
}

function verdict(
  base: Pick<VerifiedClaim, 'id' | 'text' | 'citedSection' | 'citedSections' | 'quotation'>,
  status: ClaimStatus,
  reasons: ClaimReason[],
  supportScore: number,
  matched: readonly PreparedPassage[],
  supportingText: string | null,
): VerifiedClaim {
  return {
    ...base,
    status,
    reasons,
    supportScore: round(supportScore),
    matchedChunkIds: matched.map((item) => item.evidence.chunkId),
    matchedSectionIdentifier: matched[0]?.evidence.sectionIdentifier ?? null,
    supportingText,
  };
}

function summarize(
  claims: VerifiedClaim[],
  verifierMode: AnswerVerificationReport['verifierMode'],
  qualificationNotMentionedSections: string[],
): AnswerVerificationReport {
  const count = (status: ClaimStatus) => claims.filter((item) => item.status === status).length;
  const supportedClaimCount = count('supported');
  const citable = claims.filter((item) => item.citedSections.length > 0 || item.quotation !== null);
  const citationSupported = citable.filter((item) => item.status === 'supported').length;
  return {
    verifierMode,
    claimCount: claims.length,
    supportedClaimCount,
    unsupportedClaimCount: count('unsupported'),
    unverifiedCitationCount: count('unverified_citation'),
    unverifiedQuotationCount: count('unverified_quotation'),
    contradictedClaimCount: count('contradicted'),
    unverifiedClaimCount: count('unverified'),
    supportedClaimRate: claims.length === 0 ? 0 : round(supportedClaimCount / claims.length),
    citationSupportRate: citable.length === 0 ? 1 : round(citationSupported / citable.length),
    qualificationNotMentionedSections,
    claims,
  };
}

// Sections whose bound passages contain a proviso or exception that the answer
// does not acknowledge anywhere. Omission cannot be judged per sentence.
function qualificationNotMentioned(
  answer: string,
  claims: readonly VerifiedClaim[],
  prepared: readonly PreparedPassage[],
): string[] {
  if (hasQualificationLanguage(answer)) return [];
  const usedChunks = new Set(claims.flatMap((item) => item.matchedChunkIds));
  return [
    ...new Set(
      prepared
        .filter((item) => usedChunks.has(item.evidence.chunkId))
        .filter((item) => hasQualification(item.evidence.text))
        .map((item) => item.evidence.sectionIdentifier.toUpperCase()),
    ),
  ];
}

function preparePassage(evidence: RagEvidence): PreparedPassage {
  const text = cleanStatuteText(evidence.text);
  const units = splitUnits(text).map((unit) => ({
    text: unit,
    tokens: new Set(contentTokens(unit)),
  }));
  return {
    evidence,
    normalized: normalizeForMatch(text),
    units,
    tokens: new Set(contentTokens(text)),
    numbers: new Set(extractNumbers(text)),
  };
}

// Consolidated statutes mark amendments with footnote numbers and brackets
// ("the 135 [***] top 1000 listed entities", "134 [Provided that ...]").
// They are editorial apparatus, not law, and they break sentence splitting and
// quotation matching, so they are removed before comparison.
export function cleanStatuteText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/(?:^|\s)\d{1,3}\s*\[\s*\*+\s*\]/gu, ' ')
    .replace(/\[\s*\*+\s*\]/gu, ' ')
    .replace(/(^|\s)\d{1,3}\s*\[(?=\s*[A-Za-z(])/gu, '$1')
    .replace(/[[\]]/gu, '')
    .replace(/[ \t]{2,}/gu, ' ');
}

// Finds the source span that best contains the claim. Windows of up to three
// consecutive units allow a claim that combines adjacent clauses; the single
// best unit inside the window is used for polarity and modality checks.
interface SupportMatch {
  passage: PreparedPassage;
  unit: SourceUnit;
  windowText: string;
  score: number;
}

function bestSupport(
  claimTokens: ReadonlySet<string>,
  scope: readonly PreparedPassage[],
): SupportMatch | null {
  let best: SupportMatch | null = null;
  for (const passage of scope) {
    for (let start = 0; start < passage.units.length; start += 1) {
      const window = new Set<string>();
      let bestUnit: SourceUnit | null = null;
      let bestUnitScore = -1;
      for (let size = 0; size < 3 && start + size < passage.units.length; size += 1) {
        const unit = passage.units[start + size]!;
        for (const token of unit.tokens) window.add(token);
        const unitScore = containmentScore(claimTokens, unit.tokens);
        if (unitScore > bestUnitScore) {
          bestUnitScore = unitScore;
          bestUnit = unit;
        }
        const score = containmentScore(claimTokens, window);
        if (bestUnit && (!best || score > best.score + 1e-9))
          best = {
            passage,
            unit: bestUnit,
            windowText: passage.units
              .slice(start, start + size + 1)
              .map((item) => item.text)
              .join(' '),
            score,
          };
      }
    }
  }
  return best;
}

// Whether a page of statute text names a section, either in running text
// ("section 21", "sections 20 and 21") or as a section heading at the start of
// a line or after a full stop ("21. (1) Any person", "7. Designated partners").
export function pageNamesSection(text: string, section: string): boolean {
  if (extractCitedSections(text).includes(section.toUpperCase())) return true;
  const escaped = section.replace(/[^0-9A-Za-z]/gu, '');
  return new RegExp(`(?:^|[\\n.;:\\]]\\s*)${escaped}\\.\\s*(?:\\(\\d|[A-Z])`, 'u').test(
    text.normalize('NFKC'),
  );
}

// Normalized "word word section N word word" spans around each citation.
function citationContexts(text: string): string[] {
  const words = normalizeForMatch(text)
    .replace(/[^a-z0-9() ]+/gu, ' ')
    .split(/\s+/u)
    .filter(Boolean);
  const phrases: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    if (!/^sections?$/u.test(words[index]!) || !/^\d{1,3}[a-z]{0,3}$/u.test(words[index + 1] ?? ''))
      continue;
    const before = words.slice(Math.max(0, index - 2), index);
    const after = words.slice(index + 2, index + 4);
    phrases.push([...before, words[index], words[index + 1], ...after].join(' '));
  }
  return phrases;
}

function splitUnits(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .replace(/\s+/gu, ' ')
      // A "(3)" starts a new unit only when it opens a sub-section, not when it
      // is an inline reference such as "clause (o) of sub-section (3) of section
      // 134"; splitting there separated "not" from the rest of its sentence.
      .split(
        /(?<=[.;:])\s+(?=[(A-Z—―"'])|\s(?=Provided\b)|(?<!\b(?:sub-section|section|sub-clause|clause|rule|item|paragraph|and|or|to))\s(?=\(\d{1,3}[A-Z]?\)\s)/iu,
      )
      .map((unit) => unit.trim())
      .filter((unit) => unit.length > 0)
  );
}

export function extractClaims(answer: string, minCharacters: number): string[] {
  return extractClaimContexts(answer, minCharacters).map((item) => item.text);
}

export interface ClaimContext {
  text: string;
  // The lead-in lines (ending with ":") of the list the claim sits in, for
  // example "subject to these exclusions:". Empty for top-level sentences.
  leadIn: string;
}

// Splits an answer into claims and records, for list items, the lead-in lines
// they depend on. Indentation decides nesting: a line closes every open
// lead-in indented at or deeper than itself.
export function extractClaimContexts(answer: string, minCharacters: number): ClaimContext[] {
  const claims: ClaimContext[] = [];
  const leads: Array<{ indent: number; text: string; isListItem: boolean }> = [];
  for (const rawLine of answer.normalize('NFKC').split(/\r?\n/u)) {
    if (!rawLine.trim()) continue;
    if (/^#{1,6}\s/u.test(rawLine.trim())) {
      leads.length = 0;
      continue;
    }
    const indent = /^\s*/u.exec(rawLine)![0].length;
    const isListItem = /^\s*(?:[-*+]|\d+\.|\[[ xX]\])\s+/u.test(rawLine);
    // A paragraph lead-in stays open for list items at its own indent; a list
    // item or paragraph closes lead-ins at the same or a deeper level.
    while (leads.length > 0) {
      const top = leads[leads.length - 1]!;
      if (top.indent > indent || (top.indent === indent && (top.isListItem || !isListItem)))
        leads.pop();
      else break;
    }
    const line = rawLine
      .replace(/^\s*(?:>\s*)+/u, '')
      .replace(/^\s*(?:[-*+]|\d+\.|\[[ xX]\])\s+/u, '')
      .replace(/\*\*|__/gu, '')
      .trim();
    const leadIn = leads.map((item) => item.text).join(' ');
    for (const sentence of splitSentences(line)) {
      const trimmed = sentence.trim();
      if (trimmed.length < minCharacters) continue;
      if (isDisclaimer(trimmed)) continue;
      if (!/[a-z]/iu.test(trimmed)) continue;
      claims.push({ text: trimmed, leadIn });
    }
    if (line.endsWith(':')) leads.push({ indent, text: line, isListItem });
  }
  return claims;
}

// A lead-in that introduces exclusions or exceptions, under which list items
// restate what is excluded rather than what applies.
function isExclusionaryLeadIn(leadIn: string): boolean {
  // A negated lead-in ("An individual is not treated as resident ... if:")
  // frames its list the same way an explicit exclusion list does.
  if (leadIn && isNegated(leadIn)) return true;
  return /\b(?:exclusions?|exclud(?:e|es|ed|ing)|except(?:ions?)?|unless|other than|otherwise than|does not include|do not include|not include|excluded|not apply|does not apply)\b/iu.test(
    leadIn,
  );
}

function splitSentences(text: string): string[] {
  // A sentence can end inside a closing quotation mark ('... to two hundred."').
  return text.split(/(?<=[.!?;:][”"’']?)\s+(?=[A-Z("'“])/u);
}

function isDisclaimer(sentence: string): boolean {
  const lowered = sentence.toLocaleLowerCase('en-US');
  return (
    DISCLAIMER_MARKERS.some((marker) => lowered.includes(marker)) ||
    // Model wording varies ("Legal currentness of the supplied extract is
    // unverified"); any sentence about currentness being unverified qualifies.
    /\bcurrentness\b.*\b(?:unverified|not verified)\b/u.test(lowered) ||
    // Statements about the evidence rather than the law: what the supplied
    // material leaves out, or that something should still be checked. They
    // assert nothing a source could support, and are shown to the user as
    // written. A sentence that also states a number or cites a section still
    // carries a legal claim and is checked.
    (extractNumbers(sentence).length === 0 &&
      extractCitedSections(sentence).length === 0 &&
      isMetaStatement(lowered))
  );
}

function isMetaStatement(lowered: string): boolean {
  return (
    /\b(?:supplied|provided|available|retrieved|cited)\s+(?:evidence|material|materials|extracts?|text|passages?|sources?|documents?|excerpts?)\b.*\b(?:does not|do not|did not|doesn't|don't)\s+(?:state|specify|cover|identify|mention|include|contain|provide|address|say|set out|give)\b/u.test(
      lowered,
    ) ||
    /\b(?:not (?:been )?independently (?:verified|checked|confirmed)|should be (?:independently )?(?:verified|checked|confirmed)|independently (?:checked|verified) for currentness)\b/u.test(
      lowered,
    ) ||
    // "This answer relies only on the supplied materials." / "The extract is
    // incomplete, so the full definition cannot be confirmed."
    /^(?:this|the) (?:answer|summary|response|information)\b.{0,40}\b(?:relies|is based|based|draws)\b.{0,20}\bon (?:the |this )?(?:supplied|provided|quoted|retrieved)\b/u.test(
      lowered,
    ) ||
    /\b(?:extract|excerpt|evidence|text|material)s? (?:is|are|was|appears to be) (?:incomplete|truncated|cut off)\b/u.test(
      lowered,
    ) ||
    /\bcannot be confirmed from the (?:supplied|provided|quoted|retrieved)\b/u.test(lowered)
  );
}

// Quoted spans of 15-400 characters. Curly quotes pair by direction; straight
// quotes pair in order (1st with 2nd, 3rd with 4th), so the words between two
// quotations ('"one year" were to be read as "six months"') are never taken
// for a quotation.
export function extractQuotations(text: string): string[] {
  const quoted = [...text.matchAll(/“([^“”]{15,400})”/gu)].map((match) => match[1]!.trim());
  const parts = text.split('"');
  for (let index = 1; index < parts.length - 1; index += 2) {
    const part = parts[index]!;
    if (part.length >= 15 && part.length <= 400) quoted.push(part.trim());
  }
  return quoted;
}

export function extractQuotation(text: string): string | null {
  return extractQuotations(text)[0] ?? null;
}

// Returns every section a sentence cites, including lists such as
// "sections 185 and 186". Sub-section markers are ignored. Four-digit numbers
// are read too, so an invented "Section 9212" is caught as a citation rather
// than ignored.
export function extractCitedSections(text: string): string[] {
  const sections = new Set<string>();
  const pattern =
    /\bsections?\s+(\d{1,4}[A-Z]{0,3})\b((?:\s*\([0-9A-Za-z]+\))*(?:\s*(?:,|and|or|to)\s*\d{1,3}[A-Z]{0,3}(?:\s*\([0-9A-Za-z]+\))*)*)/giu;
  for (const match of text.normalize('NFKC').matchAll(pattern)) {
    sections.add(match[1]!.toUpperCase());
    for (const extra of match[2]!.matchAll(/(?:,|and|or|to)\s*(\d{1,3}[A-Z]{0,3})\b/giu))
      sections.add(extra[1]!.toUpperCase());
  }
  return [...sections];
}

export function extractCitedSection(text: string): string | null {
  return extractCitedSections(text)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Polarity, modality and qualification signals.

const QUANTITY_LIMITS =
  /\bno[t]?\s+(?:more|less|later|earlier|fewer|exceeding|below|above)\b(?:\s+than)?/giu;
const NEGATION =
  /\b(?:not|no|never|nothing|neither|nor|none|cannot|can't|won't|shan't|isn't|aren't|doesn't|don't|need not)\b/iu;

export function isNegated(text: string): boolean {
  const cleaned = text
    .normalize('NFKC')
    .replace(QUANTITY_LIMITS, ' ')
    .replace(/\bno\.\s*\d/giu, ' ')
    .replace(/\bnot\s+only\b/giu, ' ');
  return NEGATION.test(cleaned);
}

const CAP_QUANTITY =
  '(?:rs\\.?\\s*|₹\\s*)?(?:\\d|once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)';

// A prohibition whose object is a quantity: "no person shall ... in more than
// twenty companies", "shall not exceed ninety days", "shall not be granted
// more than once". The negation and the limit sit in one clause, with no other
// negation between them.
const NEGATED_CAP = new RegExp(
  `\\b(?:no|not)\\b(?:(?!\\b(?:no|not)\\b)[^.;:]){0,200}?\\b(?:more than|exceed(?:s|ing)?|in excess of)\\s+${CAP_QUANTITY}`,
  'giu',
);

// True when the source clause is a quantity cap whose only negation is the cap
// itself: removing the cap's negating word leaves an affirmative clause.
function isNegatedCapOnly(text: string): boolean {
  const normalized = text.normalize('NFKC');
  NEGATED_CAP.lastIndex = 0;
  if (!NEGATED_CAP.test(normalized)) return false;
  return !isNegated(
    normalized.replace(NEGATED_CAP, (match) => match.replace(/^(?:no|not)\b/iu, ' ')),
  );
}

// An affirmative claim that states an upper limit in positive form: "up to
// 20", "not more than 20", "the maximum ... is 10", "only once".
function statesPositiveCap(text: string): boolean {
  return new RegExp(
    `\\b(?:up\\s?to|at most|limited to|no more than|not more than)\\s+${CAP_QUANTITY}|\\bonly once\\b|\\bmaximum\\b[^.;:]{0,120}\\b(?:is|of)\\s+${CAP_QUANTITY}`,
    'iu',
  ).test(text.normalize('NFKC'));
}

// "Under Section 96 of the Companies Act, 2013," / "As per regulation 17,":
// names the source rather than asserting anything about it.
const FRAMING_PHRASE =
  /^\s*(?:under|as per|according to|in terms of|pursuant to)\b[^,]{0,160}?(?:act|rules|regulations|code|section\s+[\w()]+|regulation\s+[\w()]+),?(?:\s+\d{4})?,\s*/iu;

function isExceptionFramed(text: string): boolean {
  return /\b(?:except|unless|other than|save as|without)\b/iu.test(text);
}

type Modality = 'obligation' | 'permission' | 'mixed' | 'none';

export function modality(text: string): Modality {
  const cleaned = text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\bas\s+may\s+be\s+\w+/gu, ' ')
    .replace(/\bmay\s+extend\s+to\b/gu, ' ')
    .replace(/\bmay\s+be\s+(?:prescribed|specified|notified)\b/gu, ' ');
  const obligation =
    /\b(?:must|shall|required|requires|require|has to|have to|needs to|need to|mandatory|obliged|obligated)\b/u.test(
      cleaned,
    );
  const permission = /\b(?:may|can|permitted|allowed|optional|entitled|discretion)\b/u.test(
    cleaned,
  );
  if (obligation && permission) return 'mixed';
  if (obligation) return 'obligation';
  if (permission) return 'permission';
  return 'none';
}

function deniesQualification(text: string): boolean {
  return /\b(?:without (?:any )?exceptions?|no exceptions?|in all cases|in every case|in all circumstances|regardless of|irrespective of|always)\b/iu.test(
    text,
  );
}

function hasQualification(text: string): boolean {
  return /\b(?:provided that|provided further|provided also|nothing in this|shall not apply|shall not be applicable|except|unless|other than)\b/iu.test(
    text.normalize('NFKC'),
  );
}

function hasQualificationLanguage(text: string): boolean {
  return /\b(?:provided|proviso|except|exception|exempt|unless|other than|does not apply|do not apply|not applicable|subject to|however|only if)\b/iu.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// Numbers. Cardinal words and digits become "n:<value>", ordinals "o:<value>".
// Section, sub-section and clause markers and the Act's year are not quantities.

const UNITS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};
const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  crore: 10_000_000,
  crores: 10_000_000,
};
const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

// "May" only when a year, day or the end of the phrase follows, so the modal in
// "two may be appointed" is not read as a date.
const DAY = '3[01]|[12]\\d|0?[1-9]';
const MONTHS =
  'january|february|march|april|may(?=[\\s,.]*(?:\\d|$|[;)]))|june|july|august|september|october|november|december';

export function extractNumbers(text: string): string[] {
  const cleaned = text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\b(?:sub-?)?sections?\s+\d{1,3}[a-z]{0,3}(?:\s*\([0-9a-z]+\))*/gu, ' ')
    .replace(
      /\b(?:sub-?)?(?:clause|rule|regulation|schedule|form|chapter|item|paragraph)s?\s+[\divxlc]+[a-z]?(?:\s*\([0-9a-z]+\))*/gu,
      ' ',
    )
    .replace(/\([0-9a-z]{1,5}\)/gu, ' ')
    // Form and return codes ("Form TM-6", "GSTR-3B", "DIR-12") are names.
    .replace(/\b[a-z]{2,6}-\d{1,3}[a-z]{0,2}\b/gu, ' ')
    // The year in an instrument's name ("Regulations, 2016") is not a quantity.
    .replace(/\b(?:act|acts|rules|regulations|code|ordinance),?\s+\d{4}\b/gu, ' ')
    // "₹100 crore" / "Rs. 20 lakh" become plain values so they compare equal to
    // "one hundred crore rupees" / "twenty lakh rupees".
    .replace(
      /(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|crores?|thousand)\b/gu,
      (_, digits: string, scale: string) =>
        String(
          Math.round(
            Number(digits.replaceAll(',', '')) *
              (scale.startsWith('lakh') ? 100_000 : scale.startsWith('crore') ? 10_000_000 : 1_000),
          ),
        ),
    )
    .replace(/\bone\s+person\s+compan(?:y|ies)\b/gu, ' ')
    .replace(/\bone\s+or\s+more\b/gu, ' ')
    // "between (the dates of) any two meetings" names a pair, not a quantity.
    .replace(/\bbetween\s+(?:the\s+\w+\s+of\s+)?(?:any\s+)?two\b/gu, 'between ')
    .replace(/\bno\.\s*\d+/gu, ' ');
  // Calendar days are "d:<month>-<day>", so "1st April", "1 April" and
  // "April 1" compare equal and a day never matches an unrelated count.
  const found = new Set<string>();
  // A day is 1-31 and not the tail of a reference number ("CIR/P/2020/69
  // April 23, 2020" has the date April 23, not "69 April").
  const dated = cleaned
    .replace(
      new RegExp(
        `(?<![\\d/])\\b(${DAY})(?:st|nd|rd|th)?\\s+(?:day\\s+of\\s+)?(${MONTHS})\\b`,
        'gu',
      ),
      (_, day: string, month: string) => {
        found.add(`d:${month}-${Number(day)}`);
        return ' ';
      },
    )
    .replace(
      new RegExp(`\\b(${MONTHS})\\s+(${DAY})(?:st|nd|rd|th)?\\b(?![\\d.])`, 'gu'),
      (_, month: string, day: string) => {
        found.add(`d:${month}-${Number(day)}`);
        return ' ';
      },
    );
  for (const match of dated.matchAll(/\b(\d{1,3}(?:,\d{2,3})+|\d+(?:\.\d+)?)(st|nd|rd|th)?\b/gu)) {
    const value = Number(match[1]!.replaceAll(',', ''));
    found.add(match[2] ? `o:${value}` : `n:${value}`);
  }
  const words = dated.match(/[a-z]+/gu) ?? [];
  let current: number | null = null;
  let total = 0;
  const flush = () => {
    if (current !== null || total > 0) found.add(`n:${total + (current ?? 0)}`);
    current = null;
    total = 0;
  };
  for (const word of words) {
    if (word in ORDINALS) {
      flush();
      found.add(`o:${ORDINALS[word]}`);
    } else if (word in UNITS) current = (current ?? 0) + UNITS[word]!;
    else if (word in TENS) current = (current ?? 0) + TENS[word]!;
    else if (word in SCALES) {
      const scale = SCALES[word]!;
      if (scale === 100) current = (current ?? 1) * 100;
      else {
        total += (current ?? 1) * scale;
        current = null;
      }
    } else if (word === 'and' && (current !== null || total > 0)) continue;
    else flush();
  }
  flush();
  return [...found];
}

// ---------------------------------------------------------------------------
// Tokens.

const MATCH_STOP_WORDS = new Set([
  'about',
  'above',
  'after',
  'again',
  'against',
  'and',
  'any',
  'are',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'came',
  'can',
  'come',
  'company',
  'could',
  'did',
  'does',
  'each',
  'for',
  'from',
  'further',
  'has',
  'have',
  'having',
  'her',
  'here',
  'his',
  'how',
  'into',
  'its',
  'itself',
  'like',
  'may',
  'more',
  'most',
  'must',
  'not',
  'now',
  'off',
  'one',
  'only',
  'other',
  'our',
  'out',
  'over',
  'own',
  'said',
  'same',
  'section',
  'shall',
  'she',
  'should',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'under',
  'until',
  'very',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'will',
  'with',
  'within',
  'would',
  'you',
  'your',
  'require',
  'requires',
  'required',
  'need',
  'needs',
  'act',
]);

export function contentTokens(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLocaleLowerCase('en-US')
      .match(/[a-z0-9]{3,}/gu) ?? []
  )
    .filter((token) => !MATCH_STOP_WORDS.has(token))
    .map(stem);
}

function stem(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith('s') && !token.endsWith('ss')) return token.slice(0, -1);
  return token;
}

function containmentScore(
  claimTokens: ReadonlySet<string>,
  evidenceTokens: ReadonlySet<string>,
): number {
  if (claimTokens.size === 0) return 0;
  let shared = 0;
  for (const token of claimTokens) if (evidenceTokens.has(token)) shared += 1;
  return shared / claimTokens.size;
}

function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[‘’′`]/gu, "'")
    .replace(/[“”―‖]|̳/gu, '"')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

// Splits a source sentence where a new condition, contrast or proviso begins.
// Returns the sentence itself when it has a single clause.
export function clauses(text: string): string[] {
  const parts = text
    .split(/\s*;\s*|,?\s+but\s+|,\s+and\s+if\s+|,?\s+provided\s+(?:further\s+|also\s+)?that\b/iu)
    .map((part) => part.trim())
    .filter((part) => /[a-z]{3}/iu.test(part));
  return parts.length > 0 ? parts : [text];
}

function bestClause(
  claimTokens: ReadonlySet<string>,
  text: string,
): { text: string; score: number } | null {
  const parts = clauses(text);
  if (parts.length < 2) return null;
  let best: { text: string; score: number } | null = null;
  for (const part of parts) {
    const score = containmentScore(claimTokens, new Set(contentTokens(part)));
    if (!best || score > best.score) best = { text: part, score };
  }
  return best;
}

function withoutQuoteMarks(normalized: string): string {
  return normalized
    .replace(/(?<![a-z])'|'(?![a-z])|"/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function stripPunctuation(text: string): string {
  return text
    .replace(/[^a-z0-9() ]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}
