import { describe, expect, it } from 'vitest';

import { factPresent } from '../../src/rag/evaluation/pipeline-eval.js';
import { inferLegalCategory } from '../../src/rag/retrieval/legal-category.js';
import {
  definedTermAsked,
  documentVersion,
  headingMatch,
  instrumentNames,
} from '../../src/rag/retrieval/corpus-index-retriever.js';
import {
  cleanStatuteText,
  extractNumbers,
  isNegated,
} from '../../src/rag/verification/claim-verifier.js';

describe('documentVersion', () => {
  it('puts dated versions of one instrument in one family with a comparable date', () => {
    const a = documentVersion(
      'CGST Act, 2017 as amended up to 01.01.2022',
      '04-gst/CGST-Act-2017-amended-01012022.pdf',
    );
    const b = documentVersion(
      'IBBI (Insolvency Resolution Process for Corporate Persons) Regulations, 2016 (Amended upto 31 Dec 2017)',
      'x.pdf',
    );
    const c = documentVersion(
      'IBBI (Insolvency Resolution Process for Corporate Persons) Regulations, 2016 (Amended upto 09-06-2026)',
      'x.pdf',
    );
    expect(a).toEqual({ family: 'cgst act 2017', date: 20220101 });
    expect(b.family).toBe(c.family);
    expect(c.date! > b.date!).toBe(true);
  });

  it('keeps different Acts with the same name but different years apart', () => {
    expect(
      documentVersion('Income-tax Act, 1961 as amended by Finance Act, 2026', 'x.pdf').family,
    ).not.toBe(
      documentVersion('Income-tax Act, 2025 as amended by Finance Act, 2026', 'y.pdf').family,
    );
  });
});

describe('question analysis', () => {
  it('extracts named instruments and defined terms', () => {
    expect(instrumentNames('Under the Companies Act, 2013, what must a company do?')).toEqual([
      'companies act 2013',
    ]);
    expect(instrumentNames('Who is a taxable person under the CGST Act?')).toEqual(['cgst act']);
    expect(definedTermAsked('Who is a taxable person under the CGST Act?')).toBe('taxable person');
    expect(definedTermAsked('What does tax year mean under the Income-tax Act, 2025?')).toBe(
      'tax year',
    );
    expect(definedTermAsked('How many designated partners must an LLP have?')).toBeNull();
  });

  it('recognises CGST, IGST and SGST as GST questions and still rejects unrelated areas', () => {
    expect(inferLegalCategory('Who is a taxable person under the CGST Act?')).toBe('gst');
    expect(inferLegalCategory('How is IGST charged on imports?')).toBe('gst');
    expect(inferLegalCategory('What documents do I need for a passport?')).toBeUndefined();
  });

  it('scores section headings and defined terms that match the question', () => {
    const words = new Set(['designated', 'partner']);
    expect(
      headingMatch('7. Designated partners .—(1) Every limited liability partnership shall', words),
    ).toBe(2);
    expect(headingMatch('29 (a) to have been committed with the consent of a partner', words)).toBe(
      0,
    );
    expect(
      headingMatch(
        '(v) “person resident in India” means— (i) a person residing',
        new Set(['person', 'resident']),
      ),
    ).toBe(2);
  });
});

describe('statute text normalisation for verification', () => {
  it('removes footnote and bracket apparatus', () => {
    expect(
      cleanStatuteText(
        'directors; 134 [Provided that the Board of the 135 [***] top 1000 listed entities 136 [***]; 137 [***] (b)',
      ),
    ).toBe('directors; Provided that the Board of the top 1000 listed entities ; (b)');
  });

  it('compares rupee amounts in digits and words', () => {
    expect(extractNumbers('₹100 crore')).toEqual(extractNumbers('one hundred crore rupees'));
    expect(extractNumbers('Rs 20 lakh')).toEqual(extractNumbers('twenty lakh rupees'));
    expect(extractNumbers('Regulation 6(1) of the Regulations, 2016')).toEqual([]);
  });

  it('treats "no later than" as a time limit, not a negation', () => {
    expect(isNegated('no later than three days from appointment')).toBe(false);
    expect(isNegated('shall not trade in securities')).toBe(true);
  });
});

describe('factPresent', () => {
  it('accepts faithful paraphrases and rejects changed numbers', () => {
    expect(
      factPresent(
        'Payments connected with foreign trade',
        'payments due in connection with foreign trade',
      ),
    ).toBe(true);
    expect(factPresent('stays in India for 182 days', 'one hundred and eighty-two days')).toBe(
      true,
    );
    expect(factPresent('stays in India for 120 days', 'one hundred and eighty-two days')).toBe(
      false,
    );
    expect(
      factPresent('An LLP needs designated partners', 'at least two designated partners'),
    ).toBe(false);
  });
});
