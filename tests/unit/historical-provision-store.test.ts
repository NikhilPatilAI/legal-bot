import { describe, expect, it } from 'vitest';

import {
  HistoricalProvisionStore,
  provisionHistorySchema,
  type ProvisionHistoryDocument,
} from '../../src/rag/temporal/historical-provision-store.js';

const STORE_PATH = 'data/history/companies-act-2013.history.json';

function kinds(store: HistoricalProvisionStore, date: string): string[] {
  return store
    .resolve('135', date)
    .map((item) =>
      item.kind === 'match' || item.kind === 'unverified_version'
        ? `${item.kind}:${item.version.versionId}`
        : item.kind,
    );
}

describe('HistoricalProvisionStore (committed Section 135 history)', () => {
  it('selects the pre-amendment proviso the day before S.O. 324(E) commenced', async () => {
    const store = await HistoricalProvisionStore.fromFile(STORE_PATH);
    expect(kinds(store, '2021-01-21')[0]).toBe('match:s135-5-p2-2014');
  });

  it('selects the amended proviso on and after 22 January 2021 (half-open interval)', async () => {
    const store = await HistoricalProvisionStore.fromFile(STORE_PATH);
    expect(kinds(store, '2021-01-22')[0]).toBe('match:s135-5-p2-2021');
    expect(kinds(store, '2021-01-23')[0]).toBe('match:s135-5-p2-2021');
    expect(kinds(store, '2021-01-22')[1]).toBe('match:s135-6-2021');
  });

  it('reports not-in-force before commencement and never uses the unverified set-off proviso', async () => {
    const store = await HistoricalProvisionStore.fromFile(STORE_PATH);
    expect(kinds(store, '2014-03-31').slice(0, 2)).toEqual(['not_in_force', 'not_in_force']);
    expect(kinds(store, '2021-06-01')[2]).toBe('unverified_version:s135-5-set-off-2021');
  });

  it('reports unknown sections', async () => {
    const store = await HistoricalProvisionStore.fromFile(STORE_PATH);
    expect(store.resolve('149', '2016-01-01')[0]?.kind).toBe('unknown_section');
  });

  it('excludes secondary-corroborated dates under a primary-only policy', async () => {
    const store = await HistoricalProvisionStore.fromFile(STORE_PATH, {
      minimumDateEvidence: 'primary_source_verified',
    });
    expect(kinds(store, '2020-06-01')[0]).toBe('unverified_version:s135-5-p2-2014');
    expect(kinds(store, '2021-06-01')[0]).toBe('match:s135-5-p2-2021');
  });
});

describe('provisionHistorySchema validation', () => {
  const base = (): ProvisionHistoryDocument => ({
    schemaVersion: 'legal-bot-provision-history-v1',
    act: 'Fixture Act',
    documentId: 'fixture',
    reviewNote: 'Synthetic engineering fixture.',
    sources: [
      {
        sourceId: 'gazette-fixture',
        title: 'Fixture Gazette',
        publisher: 'Fixture',
        kind: 'gazette_act',
        official: true,
        url: 'https://example.gov/fixture.pdf',
        retrievedAt: null,
        sha256: null,
        note: '',
      },
    ],
    fragments: [
      {
        fragmentId: 'fixture-1',
        section: '1',
        heading: 'Fixture',
        label: 'fixture fragment',
        inForceFrom: null,
        versions: [
          version('v-one', '2020-01-01', '2021-01-01'),
          version('v-two', '2021-01-01', null),
        ],
      },
    ],
  });

  function version(versionId: string, effectiveFrom: string, effectiveTo: string | null) {
    const locator = {
      sourceId: 'gazette-fixture',
      locator: 'p1',
      pageStart: null,
      pageEnd: null,
      excerpt: null,
    };
    return {
      versionId,
      effectiveFrom,
      effectiveTo,
      text: 'Synthetic fixture text long enough to validate.',
      textEvidence: [locator],
      textReview: 'primary_source_verified' as const,
      effectiveFromEvidence: [locator],
      effectiveToEvidence: [],
      dateReview: 'primary_source_verified' as const,
      reviewMethod: 'fixture',
      reviewedAt: '2026-09-28',
      ambiguity: null,
    };
  }

  it('accepts adjacent half-open intervals', () => {
    expect(provisionHistorySchema.safeParse(base()).success).toBe(true);
  });

  it('rejects overlapping intervals', () => {
    const document = base();
    document.fragments[0]!.versions[1] = version('v-two', '2020-06-01', null);
    expect(provisionHistorySchema.safeParse(document).success).toBe(false);
  });

  it('rejects primary text review without an official source', () => {
    const document = base();
    document.sources[0]!.official = false;
    expect(provisionHistorySchema.safeParse(document).success).toBe(false);
  });

  it('leaves a gap between intervals unresolved', () => {
    const document = base();
    document.fragments[0]!.versions[1] = version('v-two', '2021-06-01', null);
    const store = new HistoricalProvisionStore(provisionHistorySchema.parse(document));
    expect(store.resolve('1', '2021-03-01')[0]?.kind).toBe('unknown_date');
  });
});
