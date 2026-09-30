import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { loadLegalEvalDataset } from '../../src/rag/evaluation/legal-eval-dataset.js';
import { HistoricalProvisionStore } from '../../src/rag/temporal/historical-provision-store.js';

// Guards against invented reference answers: every expected fact must be a
// verbatim substring of the source text it cites. Corpus-backed cases are
// checked against the bundled Companies Act section corpus.

const DATASET = 'data/eval/companies-act-2013.eval.json';
const CORPUS = 'data/sections/companies-act-2013.sections.json';

const normalize = (text: string) =>
  text.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[‘’]/gu, "'").replace(/\s+/gu, ' ');

describe('legal evaluation dataset', () => {
  it('parses as v2 with frozen, leakage-free splits and provenance on every case', async () => {
    const dataset = await loadLegalEvalDataset(DATASET);
    expect(dataset.schemaVersion).toBe('legal-bot-legal-eval-v2');
    expect(dataset.cases.every((item) => item.split && item.family && item.provenance)).toBe(true);
    const families = new Map<string, Set<string>>();
    for (const item of dataset.cases)
      families.set(item.family!, (families.get(item.family!) ?? new Set()).add(item.split!));
    expect([...families.values()].every((splits) => splits.size === 1)).toBe(true);
    expect(
      dataset.cases.some((item) => item.provenance?.reviewStatus !== 'ai_source_verified'),
    ).toBe(false);
  });

  it('temporal expected facts and versions come from the history store', async () => {
    const dataset = await loadLegalEvalDataset(DATASET);
    const store = await HistoricalProvisionStore.fromFile(
      'data/history/companies-act-2013.history.json',
    );
    for (const item of dataset.cases.filter((entry) => entry.expectedVersionId)) {
      const texts = store
        .resolve(item.expectedSections[0]!, item.asOfDate!)
        .flatMap((resolution) => (resolution.kind === 'match' ? [resolution.version] : []));
      expect(
        texts.map((version) => version.versionId),
        item.id,
      ).toContain(item.expectedVersionId);
      const joined = normalize(texts.map((version) => version.text).join(' '));
      for (const fact of item.expectedFacts)
        expect(joined, `${item.id}: ${fact}`).toContain(normalize(fact));
    }
  });

  it.skipIf(!existsSync(CORPUS))(
    'corpus expected facts are verbatim in the cited sections',
    async () => {
      const dataset = await loadLegalEvalDataset(DATASET);
      const corpus = JSON.parse(readFileSync(CORPUS, 'utf8')) as {
        chunks: Array<{ sectionNumber: string; text: string }>;
      };
      for (const item of dataset.cases.filter(
        (entry) => entry.provenance?.source === 'tdb-companies-act-2013',
      )) {
        const sections = [...item.expectedSections, ...item.connectedSections];
        const text = normalize(
          corpus.chunks
            .filter((chunk) => sections.includes(chunk.sectionNumber))
            .map((chunk) => chunk.text)
            .join(' '),
        );
        for (const fact of item.expectedFacts)
          expect(text, `${item.id}: ${fact}`).toContain(normalize(fact));
      }
    },
  );
});
