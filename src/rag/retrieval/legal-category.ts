// Maps a question to the legal area it is about (GST, trade marks, LLP, ...).
// The index retriever refuses questions that match no supported area, which is
// how out-of-scope questions (passports, criminal law, foreign law) are
// declined before any search or model call.
//
// Each area lists its statute and regulator names and specific terms of its
// field, never generic words such as "bank" or "tax", so a question about
// another field does not slip through. Terms were added from the development
// sets only (see docs/EVALUATION.md), not from the frozen held-out questions.
const AREAS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:[cis]?gst|utgst|goods and services tax|input tax credit|itc|hsn|e-?way bill|reverse charge|place of supply|input service distributor|provisional assessment|consumer welfare fund|cbic)\b/iu,
    'gst',
  ],
  [
    /\b(?:trade\s?marks?|trademark|tm-o|brand opposition|madrid protocol|trade marks? registry)\b/iu,
    'trademarks',
  ],
  [/\b(?:llp|limited liability partnership|designated partner)\b/iu, 'llp'],
  [
    /\b(?:sebi|insider trading|securities and exchange board|listed securities|listed (?:entity|entities)|lodr|icdr|sast|buy-?back|mutual funds?|demat|commodity (?:futures|derivatives))\b/iu,
    'sebi',
  ],
  [
    /\b(?:ibbi|insolvency|bankruptcy|resolution professional|resolution process|liquidators?|liquidation|information utilit(?:y|ies)|committee of creditors|cirp)\b/iu,
    'ibbi',
  ],
  [
    /\b(?:fema|foreign exchange|reserve bank|rbi|current account transaction|capital account transaction|authori[sz]ed persons?|overseas investment|external commercial borrowings?|franchisee arrangements?|money chang\w*|liberalised remittance|non-debt instruments?|foreign investment)\b/iu,
    'rbi-fema',
  ],
  [
    /\b(?:income[ -]?tax|section 80c|tax deduction|finance act|tax year|advance tax|assessment year|capital gains|lower (?:or nil )?deduction certificate)\b/iu,
    'income-tax',
  ],
  [
    /\b(?:companies act|company law|roc|registrar of companies|board resolution|director|related[- ]party|independent directors?|accounting standards?|registered valuers?|nclt|nclat|national company law|memorandum of association|articles of association|one person compan(?:y|ies)|csr|key managerial|layers of subsidiaries)\b/iu,
    'companies',
  ],
  [/\b(?:case law|case-law|judg(?:e)?ment|supreme court|high court|civil appeal)\b/iu, 'case-law'],
];

export function inferLegalCategory(question: string): string | undefined {
  const normalized = question.normalize('NFKC').toLocaleLowerCase('en-US');
  return AREAS.find(([pattern]) => pattern.test(normalized))?.[1];
}
