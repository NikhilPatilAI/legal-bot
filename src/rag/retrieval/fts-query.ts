// Builds a safe SQLite FTS5 MATCH expression from free text: every term is
// quoted (no FTS operators can be injected), prefix-matched and de-duplicated;
// question words that carry no legal meaning are dropped.
export function buildFtsQuery(query: string, operator: 'AND' | 'OR' = 'AND'): string {
  const tokens =
    query
      .normalize('NFKC')
      .match(/[\p{L}\p{N}]{2,}/gu)
      ?.filter((token) => !searchStopWords.has(token.toLocaleLowerCase('en-US')))
      .slice(0, 20) ?? [];
  if (tokens.length === 0) throw new Error('Query contains no searchable terms');
  return [...new Set(tokens.map((token) => token.toLocaleLowerCase('en-US')))]
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(` ${operator} `);
}

const searchStopWords = new Set([
  'about',
  'according',
  'and',
  'are',
  'does',
  'evidence',
  'explain',
  'for',
  'from',
  'give',
  'how',
  'into',
  'key',
  'list',
  'main',
  'materials',
  'me',
  'of',
  'should',
  'state',
  'steps',
  'the',
  'this',
  'under',
  'what',
  'when',
  'where',
  'which',
  'with',
]);
