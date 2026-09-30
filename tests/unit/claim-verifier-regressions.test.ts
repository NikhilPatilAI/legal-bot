import { describe, expect, it } from 'vitest';

import type { RagEvidence } from '../../src/rag/rag-service.js';
import {
  DeterministicClaimVerifier,
  type ClaimSupportClassifier,
} from '../../src/rag/verification/claim-verifier.js';

// Regression fixtures for verifier failure modes observed in the deterministic
// lexical verifier. Every evidence text below is either a SYNTHETIC ENGINEERING
// FIXTURE (clearly not a legal statement) or a short excerpt of the bundled
// Companies Act, 2013 reproduction. The claims are deliberately perturbed; the
// expected labels follow from the perturbation, not from legal review.

function evidence(overrides: Partial<RagEvidence>): RagEvidence {
  return {
    chunkId: 'chunk_fixture',
    documentId: 'legal_fixture',
    title: 'Fixture source',
    authority: 'fixture',
    sectionIdentifier: '1',
    sectionHeading: null,
    pageStart: 1,
    pageEnd: 1,
    officialSourceUrl: null,
    effectiveDate: null,
    retrievalDate: '2026-09-28T00:00:00.000Z',
    sha256: 'b'.repeat(64),
    legalStatus: 'unknown',
    text: '',
    score: 1,
    ...overrides,
  };
}

// Synthetic engineering fixture: not a statement of any real law.
const syntheticObligation = evidence({
  chunkId: 'chunk_synthetic_obligation',
  sectionIdentifier: '901',
  text: 'Section 901. The applicant must submit the annual compliance report to the registrar within thirty days after the close of the financial year.',
});

// Excerpts of the bundled Companies Act, 2013 reproduction (Sections 149, 173, 188).
const section149 = evidence({
  chunkId: 'chunk_149',
  sectionIdentifier: '149',
  sectionHeading: 'Company to have Board of Directors',
  text: 'Section 149 — Company to have Board of Directors. (1) Every company shall have a Board of Directors consisting of individuals as directors and shall have a minimum number of three directors in the case of a public company, two directors in the case of a private company, and one director in the case of a One Person Company; and a maximum of fifteen directors: Provided that a company may appoint more than fifteen directors after passing a special resolution.',
});
const section173 = evidence({
  chunkId: 'chunk_173',
  sectionIdentifier: '173',
  sectionHeading: 'Meetings of Board',
  text: 'Section 173 — Meetings of Board. (1) Every company shall hold the first meeting of the Board of Directors within thirty days of the date of its incorporation and thereafter hold a minimum number of four meetings of its Board of Directors every year in such a manner that not more than one hundred and twenty days shall intervene between two consecutive meetings of the Board.',
});
const section188 = evidence({
  chunkId: 'chunk_188',
  sectionIdentifier: '188',
  sectionHeading: 'Related party transactions',
  text: 'Section 188 — Related party transactions. (1) Except with the consent of the Board of Directors given by a resolution at a meeting of the Board, no company shall enter into any contract or arrangement with a related party with respect to sale, purchase or supply of any goods or materials: Provided also that nothing in this sub-section shall apply to any transactions entered into by the company in its ordinary course of business other than transactions which are not on an arm length basis.',
});

async function statusOf(
  answer: string,
  sources: RagEvidence[],
  verifier = new DeterministicClaimVerifier(),
) {
  const report = await verifier.verify(answer, sources);
  expect(report.claimCount).toBe(1);
  return report.claims[0]!;
}

describe('claim verifier regressions (synthetic perturbations)', () => {
  it('control: accepts the affirmative synthetic obligation', async () => {
    const claim = await statusOf(
      'The applicant must submit the annual compliance report to the registrar.',
      [syntheticObligation],
    );
    expect(claim.status).toBe('supported');
  });

  it('rejects a negated obligation that reverses the source', async () => {
    const claim = await statusOf(
      'The applicant must not submit the annual compliance report to the registrar.',
      [syntheticObligation],
    );
    expect(claim.status).not.toBe('supported');
  });

  it('rejects an altered deadline', async () => {
    const claim = await statusOf(
      'The applicant must submit the annual compliance report within ninety days after the close of the financial year.',
      [syntheticObligation],
    );
    expect(claim.status).not.toBe('supported');
  });

  it('rejects an altered numeric threshold from real statutory text', async () => {
    const claim = await statusOf('A public company must have a minimum number of five directors.', [
      section149,
    ]);
    expect(claim.status).not.toBe('supported');
  });

  it('rejects a mandatory rule restated as merely permissive', async () => {
    const claim = await statusOf(
      'A company may hold four meetings of its Board of Directors every year.',
      [section173],
    );
    expect(claim.status).not.toBe('supported');
  });

  it('rejects a claim that denies the exception present in the cited passage', async () => {
    const claim = await statusOf(
      'Under Section 188, every related party contract requires consent of the Board of Directors without exception.',
      [section188],
    );
    expect(claim.status).not.toBe('supported');
  });

  it('rejects a claim bound to the wrong cited passage even when another passage matches', async () => {
    const claim = await statusOf(
      'Section 149 requires every company to hold a minimum number of four meetings of its Board every year.',
      [section149, section173],
    );
    expect(claim.status).not.toBe('supported');
  });

  it('does not accept a cited section on incidental lexical overlap', async () => {
    const claim = await statusOf(
      'Section 149 requires every company to file quarterly greenhouse emission audits.',
      [section149],
    );
    expect(claim.status).not.toBe('supported');
  });

  it('does not accept an unsupported conclusion wrapped around a genuine quotation', async () => {
    const claim = await statusOf(
      'Because Section 149 provides "a maximum of fifteen directors", a private company needs no directors at all.',
      [section149],
    );
    expect(claim.status).not.toBe('supported');
  });

  it('still flags a fabricated section citation', async () => {
    const claim = await statusOf('Section 402 requires a company to appoint three directors.', [
      section149,
    ]);
    expect(claim.status).toBe('unverified_citation');
  });

  it('reports an unavailable semantic classifier as unverified, not supported', async () => {
    const failing: ClaimSupportClassifier = {
      classify: async () => {
        throw new Error('provider unavailable');
      },
    };
    const claim = await statusOf(
      'A public company must have a minimum number of three directors.',
      [section149],
      new DeterministicClaimVerifier({ classifier: failing }),
    );
    expect(claim.status).not.toBe('supported');
  });

  it('accepts a verbatim source sentence that mentions a section which was not retrieved', async () => {
    const section173Proviso = evidence({
      chunkId: 'chunk_173_5',
      sectionIdentifier: '173',
      text: 'Section 173 — Meetings of Board. (5) A One Person Company, small company and dormant company shall be deemed to have complied with the provisions of this section if at least one meeting of the Board of Directors has been conducted in each half of a calendar year: Provided that nothing contained in this sub-section and in section 174 shall apply to One Person Company in which there is only one director on its Board of Directors.',
    });
    const claim = await statusOf(
      'Provided that nothing contained in this sub-section and in section 174 shall apply to One Person Company in which there is only one director on its Board of Directors.',
      [section173Proviso],
    );
    expect(claim.status).toBe('supported');
  });

  it('still rejects a loosely related claim that cites a section only mentioned in the evidence', async () => {
    const section173Proviso = evidence({
      chunkId: 'chunk_173_5',
      sectionIdentifier: '173',
      text: 'Section 173 — Meetings of Board. Provided that nothing contained in this sub-section and in section 174 shall apply to One Person Company in which there is only one director on its Board of Directors.',
    });
    const claim = await statusOf(
      'Section 174 requires a quorum of one third of the total strength of the Board.',
      [section173Proviso],
    );
    expect(claim.status).toBe('unverified_citation');
  });

  it('binds a section citation to page-level evidence whose text contains that section', async () => {
    const page = evidence({
      chunkId: 'chunk_page_12',
      sectionIdentifier: 'Page 12',
      text: '21. (1) Any person may, within three months from the date of the advertisement of an application for registration, give notice in writing to the Registrar of opposition to the registration.',
    });
    const claim = await statusOf(
      'Under Section 21, any person may give notice of opposition within three months from the date of the advertisement.',
      [page],
    );
    expect(claim.status).toBe('supported');
  });

  it('still rejects a page-level citation of a section the page never names', async () => {
    const page = evidence({
      chunkId: 'chunk_page_12',
      sectionIdentifier: 'Page 12',
      text: '21. (1) Any person may, within three months from the date of the advertisement of an application for registration, give notice in writing to the Registrar of opposition to the registration.',
    });
    const claim = await statusOf(
      'Under Section 57, any person may give notice of opposition within three months from the date of the advertisement.',
      [page],
    );
    expect(claim.status).toBe('unverified_citation');
  });

  it('accepts list items that restate exclusions under an exclusion lead-in', async () => {
    // Synthetic engineering fixture shaped like a definition with exclusions.
    const definition = evidence({
      chunkId: 'chunk_definition',
      sectionIdentifier: 'Page 7',
      text: '(v) "resident person" means a person residing in the territory for more than one hundred and eighty-two days during the preceding year but does not include a person who has gone out of the territory for taking up employment outside the territory.',
    });
    const report = await new DeterministicClaimVerifier().verify(
      [
        'A resident person is someone residing in the territory for more than one hundred and eighty-two days during the preceding year, subject to these exclusions:',
        '- a person who has gone out of the territory for taking up employment outside the territory.',
      ].join('\n'),
      [definition],
    );
    expect(report.claims.map((claim) => claim.status)).toEqual(['supported', 'supported']);
  });

  it('still rejects a top-level negation of an affirmative source', async () => {
    const claim = await statusOf(
      'The applicant must not submit the annual compliance report to the registrar.',
      [syntheticObligation],
    );
    expect(claim.status).not.toBe('supported');
  });

  // Synthetic engineering fixtures modelled on drafts the verifier withheld in
  // the 2026-09-29 tuning runs (dev/test splits, Azure composer).
  const mixedClauses = evidence({
    chunkId: 'chunk_mixed',
    sectionIdentifier: 'Page 3',
    text: '(2) Within two months from the receipt of the notice of objection, the applicant shall send to the registrar a counter-statement of the grounds on which he relies, and if he does not do so he shall be deemed to have abandoned his application.',
  });

  it('compares polarity with the clause the claim restates, not the whole sentence', async () => {
    const positive = await statusOf(
      'The applicant shall send to the registrar a counter-statement of the grounds on which he relies within two months from the receipt of the notice of objection.',
      [mixedClauses],
    );
    expect(positive.status).toBe('supported');
    const negated = await statusOf(
      'The applicant shall not send to the registrar a counter-statement of the grounds on which he relies within two months from the receipt of the notice of objection.',
      [mixedClauses],
    );
    expect(negated.status).not.toBe('supported');
  });

  it('accepts a verbatim block quotation of a definition followed by "but does not include"', async () => {
    const definition = evidence({
      chunkId: 'chunk_quote',
      sectionIdentifier: 'Page 7',
      text: '(v) "resident person" means (i) a person residing in the territory for more than one hundred and eighty-two days during the preceding year but does not include a person who has gone out of the territory.',
    });
    const report = await new DeterministicClaimVerifier().verify(
      '> (i) a person residing in the territory for more than one hundred and eighty-two days during the preceding year”',
      [definition],
    );
    expect(report.claims.map((claim) => claim.status)).toEqual(['supported']);
  });

  const periodDefinition = evidence({
    chunkId: 'chunk_period',
    sectionIdentifier: 'Page 2',
    text: '(1) For the purposes of this Code, “reporting period” means the twelve months period of the year commencing on the 1st April.',
  });

  it('reads "1st April" and "1 April" as the same date and matches quotes of either style', async () => {
    const report = await new DeterministicClaimVerifier().verify(
      [
        'A reporting period means the twelve months period of the year commencing on 1 April.',
        '> “For the purposes of this Code, ‘reporting period’ means the twelve months period of the year commencing on the 1st April.”',
      ].join('\n'),
      [periodDefinition],
    );
    expect(report.claims.map((claim) => claim.status)).toEqual(['supported', 'supported']);
  });

  it('treats an added date as unsupported and a changed date as contradicted', async () => {
    const added = await statusOf(
      'A reporting period means the twelve months period of the year commencing on 1 April and ending on 31 March.',
      [periodDefinition],
    );
    expect(added.status).toBe('unsupported');
    const changed = await statusOf(
      'A reporting period means the twelve months period of the year commencing on 1 July.',
      [periodDefinition],
    );
    expect(changed.status).toBe('contradicted');
  });

  it('does not check statements about the supplied material, unless they carry a legal claim', async () => {
    const report = await new DeterministicClaimVerifier().verify(
      [
        'The supplied evidence does not state the applicable transfer deadline.',
        'Those details should be verified against the current statutory text.',
        'The penalty is two hundred rupees per day, which should be verified.',
      ].join('\n'),
      [syntheticObligation],
    );
    expect(report.claims.map((claim) => claim.text)).toEqual([
      'The penalty is two hundred rupees per day, which should be verified.',
    ]);
    expect(report.claims[0]!.status).not.toBe('supported');
  });

  it('accepts "not" as a restatement of a definition by exclusion, and nowhere else', async () => {
    const definition = evidence({
      chunkId: 'chunk_exclusion',
      sectionIdentifier: 'Page 4',
      text: '(j) "routine filing" means a filing other than an annual filing and includes a correction filing.',
    });
    expect(
      (
        await statusOf('A routine filing means a filing that is not an annual filing.', [
          definition,
        ])
      ).status,
    ).toBe('supported');
    expect(
      (
        await statusOf(
          'The applicant must not submit the annual compliance report to the registrar.',
          [syntheticObligation],
        )
      ).status,
    ).not.toBe('supported');
  });

  it('does not read form codes such as "Form AB-6" as quantities', async () => {
    const form = evidence({
      chunkId: 'chunk_form',
      sectionIdentifier: 'Page 9',
      text: 'The counter-statement shall be filed in Form AB-6 with the prescribed fee.',
    });
    expect(
      (
        await statusOf(
          'The counter-statement shall be filed in Form AB-6 with the prescribed fee.',
          [form],
        )
      ).status,
    ).toBe('supported');
  });

  const cap = evidence({
    chunkId: 'chunk_cap',
    sectionIdentifier: 'Page 11',
    text: '(1) No person shall hold office as a member, including any alternate membership, in more than twenty boards at the same time: Provided that the maximum number of public boards in which a person can be appointed as a member shall not exceed ten.',
  });

  it('accepts a numeric cap restated positively and still rejects a lifted cap', async () => {
    expect(
      (
        await statusOf(
          'A person may hold office as a member, including alternate membership, in up to 20 boards at the same time.',
          [cap],
        )
      ).status,
    ).toBe('supported');
    expect(
      (
        await statusOf(
          'The maximum number of public boards in which a person may be appointed as a member is 10.',
          [cap],
        )
      ).status,
    ).toBe('supported');
    expect(
      (
        await statusOf(
          'A person may hold office as a member, including alternate membership, in more than twenty boards at the same time.',
          [cap],
        )
      ).status,
    ).not.toBe('supported');
    expect(
      (
        await statusOf(
          'A person may hold office as a member, including alternate membership, in up to 30 boards at the same time.',
          [cap],
        )
      ).status,
    ).not.toBe('supported');
  });

  it('does not let a cap hide a separate negation or modality change', async () => {
    const committee = evidence({
      chunkId: 'chunk_committee',
      sectionIdentifier: 'Page 12',
      text: 'The interim manager shall appoint a panel of members with such number of members as he may determine, but not exceeding seven.',
    });
    expect(
      (
        await statusOf(
          'The interim manager shall not appoint a panel of members with such number of members as he may determine, but not exceeding seven.',
          [committee],
        )
      ).status,
    ).not.toBe('supported');
    const reckoning = evidence({
      chunkId: 'chunk_reckoning',
      sectionIdentifier: 'Page 13',
      text: 'In reckoning any such period of thirty days, no account shall be taken of any period during which the council is adjourned for more than four consecutive days.',
    });
    expect(
      (
        await statusOf(
          'In reckoning any such period of thirty days, no account may be taken of any period during which the council is adjourned for more than four consecutive days.',
          [reckoning],
        )
      ).status,
    ).not.toBe('supported');
  });

  it('finds a number in a proviso when the claim opens by naming the source', async () => {
    const meeting = evidence({
      chunkId: 'chunk_meeting',
      sectionIdentifier: 'Page 71',
      text: '96. Annual general meeting. (1) Every society shall in each year hold, in addition to any other meetings, a general meeting as its annual general meeting and shall specify the meeting as such in the notices calling it. Provided also that not more than fifteen months shall elapse between the date of one annual general meeting of a society and that of the next.',
    });
    expect(
      (
        await statusOf(
          'Under Section 96 of the Societies Code, 2013, the maximum gap between the dates of two annual general meetings is 15 months.',
          [meeting],
        )
      ).status,
    ).toBe('supported');
    expect(
      (
        await statusOf(
          'Under Section 96 of the Societies Code, 2013, the maximum gap between the dates of two annual general meetings is 18 months.',
          [meeting],
        )
      ).status,
    ).not.toBe('supported');
  });

  it('ends a sentence at a closing quotation mark', async () => {
    const report = await new DeterministicClaimVerifier().verify(
      'The definition "limits the number of its members to two hundred." The supplied evidence does not state the minimum number of persons.',
      [cap],
    );
    expect(report.claims.map((claim) => claim.text)).toEqual([
      'The definition "limits the number of its members to two hundred."',
    ]);
  });

  it('control: accepts a faithful restatement bound to the right cited section', async () => {
    const claim = await statusOf(
      'Section 173 requires every company to hold a minimum number of four meetings of its Board every year.',
      [section149, section173],
    );
    expect(claim.status).toBe('supported');
  });

  // Synthetic engineering fixtures for the verbatim-edit and wrong-citation
  // rules; not statements of any real law.
  const approval = evidence({
    chunkId: 'chunk_approval',
    sectionIdentifier: '913',
    text: '913. Shifting of office.— (1) The alteration of the charter relating to the place of the registered office from one region to another shall not have any effect unless it is approved by the Central Registry on an application in such form and manner as may be prescribed.',
  });
  const neighbour = evidence({
    chunkId: 'chunk_neighbour',
    sectionIdentifier: '914',
    text: '914. Effect of alteration.— (1) Every alteration of the charter of a society shall be registered with the Central Registry within thirty days of the alteration and the charter as altered shall be the charter of the society.',
  });

  it('rejects a verbatim copy with its negation removed, despite an "unless" clause', async () => {
    const claim = await statusOf(
      'The alteration of the charter relating to the place of the registered office from one region to another shall have any effect unless it is approved by the Central Registry.',
      [approval],
    );
    expect(claim.status).toBe('contradicted');
    expect(claim.reasons).toContain('verbatim_edit');
  });

  it('rejects a verbatim copy with "shall" changed to "may" and keeps the exact copy', async () => {
    expect(
      (
        await statusOf(
          'Every alteration of the charter of a society may be registered with the Central Registry within thirty days of the alteration.',
          [neighbour],
        )
      ).status,
    ).not.toBe('supported');
    expect(
      (
        await statusOf(
          'Every alteration of the charter of a society shall be registered with the Central Registry within thirty days of the alteration.',
          [neighbour],
        )
      ).status,
    ).toBe('supported');
  });

  it('rejects a verbatim sentence attributed to the neighbouring section', async () => {
    const wrong = await statusOf(
      'Under Section 914, the alteration of the charter relating to the place of the registered office from one region to another shall not have any effect unless it is approved by the Central Registry.',
      [approval, neighbour],
    );
    expect(wrong.status).toBe('unverified_citation');
    expect(wrong.reasons).toContain('cited_section_mismatch');
    const right = await statusOf(
      'Under Section 913, the alteration of the charter relating to the place of the registered office from one region to another shall not have any effect unless it is approved by the Central Registry.',
      [approval, neighbour],
    );
    expect(right.status).toBe('supported');
  });

  it('reads a four-digit invented section as a citation', async () => {
    const claim = await statusOf(
      'Under Section 9913, every alteration of the charter of a society shall be registered with the Central Registry within thirty days of the alteration.',
      [neighbour],
    );
    expect(claim.status).toBe('unverified_citation');
  });

  const circular = evidence({
    chunkId: 'chunk_circular',
    title: 'Relaxation in the Fixture Regulations',
    sectionIdentifier: 'Page 1',
    text: 'CIRCULAR REG/HO/CIR/P/2020/69 April 23, 2020 To All Listed Entities. Accordingly the words "one year" shall be read as "six months" in the said regulation.',
  });

  it('accepts an instrument date stated in the passage header, not a changed period', async () => {
    expect(
      (
        await statusOf(
          'Under the April 23, 2020 circular, the words "one year" were to be read as "six months".',
          [circular],
        )
      ).status,
    ).toBe('supported');
    expect(
      (
        await statusOf(
          'Under the April 23, 2020 circular, the words "one year" were to be read as "three months".',
          [circular],
        )
      ).status,
    ).not.toBe('supported');
  });

  it('matches a quotation that omits an amendment insertion, but not one that adds words', async () => {
    const rule = evidence({
      chunkId: 'chunk_insertion',
      sectionIdentifier: 'Page 90',
      text: '(9) Any amount deducted under section 51 and claimed [in FORM X-02] 143 by the registered person shall be credited to his electronic cash ledger on the 1 st April.',
    });
    const quoted = await new DeterministicClaimVerifier().verify(
      '"Any amount deducted under section 51 and claimed by the registered person shall be credited to his electronic cash ledger on the 1st April."',
      [rule],
    );
    expect(quoted.claims[0]!.status).not.toBe('unverified_quotation');
    const invented = await new DeterministicClaimVerifier().verify(
      '"Any amount deducted under section 51 and claimed by the registered person shall be credited to his electronic cash ledger within seven days."',
      [rule],
    );
    expect(invented.claims[0]!.status).toBe('unverified_quotation');
  });

  it('ignores references to the evidence itself when matching a claim', async () => {
    const claim = await statusOf(
      'Based on the supplied transition FAQ, every alteration of the charter of a society shall be registered with the Central Registry within thirty days of the alteration.',
      [neighbour],
    );
    expect(claim.status).toBe('supported');
    const report = await new DeterministicClaimVerifier().verify(
      'This answer relies only on the supplied materials.',
      [neighbour],
    );
    expect(report.claimCount).toBe(0);
  });
});
