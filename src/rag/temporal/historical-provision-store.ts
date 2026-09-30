import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

import type { RagEvidence } from '../rag-service.js';

// Historical provision text for as-of-date questions.
//
// Each record holds the verbatim text of one provision fragment for one
// half-open interval [effectiveFrom, effectiveTo), plus separate evidence for
// the text and for the interval dates. Text and dates are reviewed separately
// because a Gazette amendment Act can prove the wording while the date it took
// effect comes from a different commencement notification.
//
// Resolution never guesses: only records whose text is verified against a
// primary source and whose dates meet the configured evidence level are used.
// A date before the first usable record, inside a gap, or covered only by an
// unverified record yields a non-match so the service abstains.

const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine(
    (value) => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value),
    'Expected a real calendar date',
  );

export const evidenceLevelSchema = z.enum([
  // Checked verbatim against an official government publication (Gazette text,
  // official consolidated Act).
  'primary_source_verified',
  // Consistent across at least two independent reputable secondary sources, and
  // the governing mechanism (for example "comes into force on a notified date")
  // is itself verified in a primary source. Not independently legal-reviewed.
  'secondary_corroborated',
  // Recorded for research only; never used to answer.
  'unverified',
]);
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

const sourceSchema = z
  .object({
    sourceId: z.string().regex(/^[a-z0-9-]{3,80}$/u),
    title: z.string().min(1).max(300),
    publisher: z.string().min(1).max(200),
    kind: z.enum([
      'gazette_act',
      'gazette_notification',
      'official_reproduction',
      'secondary_reproduction',
      'secondary_report',
    ]),
    official: z.boolean(),
    url: z.string().url(),
    retrievedAt: z.iso.datetime().nullable(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    note: z.string().max(600).default(''),
  })
  .strict();

const locatorSchema = z
  .object({
    sourceId: z.string(),
    locator: z.string().min(1).max(200),
    pageStart: z.number().int().positive().nullable().default(null),
    pageEnd: z.number().int().positive().nullable().default(null),
    excerpt: z.string().max(600).nullable().default(null),
  })
  .strict();

const versionSchema = z
  .object({
    versionId: z.string().regex(/^[a-z0-9-]{3,80}$/u),
    effectiveFrom: calendarDate,
    effectiveTo: calendarDate.nullable(),
    text: z.string().min(20).max(8_000),
    textEvidence: z.array(locatorSchema).min(1),
    textReview: evidenceLevelSchema,
    effectiveFromEvidence: z.array(locatorSchema).min(1),
    effectiveToEvidence: z.array(locatorSchema).default([]),
    dateReview: evidenceLevelSchema,
    reviewMethod: z.string().min(1).max(600),
    reviewedAt: calendarDate,
    ambiguity: z.string().max(800).nullable(),
  })
  .strict()
  .refine((version) => !version.effectiveTo || version.effectiveFrom < version.effectiveTo, {
    message: 'effectiveFrom must precede effectiveTo',
  });

const fragmentSchema = z
  .object({
    fragmentId: z.string().regex(/^[a-z0-9-]{3,80}$/u),
    section: z.string().regex(/^\d{1,3}[A-Z]{0,3}$/u),
    heading: z.string().min(1).max(300),
    label: z.string().min(1).max(200),
    // Date the fragment itself came into force (section commencement, or the
    // date an inserted sub-section commenced). Earlier dates are reported as
    // "not in force" rather than "unknown".
    inForceFrom: z
      .object({ date: calendarDate, review: evidenceLevelSchema, evidence: z.array(locatorSchema) })
      .strict()
      .nullable(),
    versions: z.array(versionSchema).min(1),
  })
  .strict();

export const provisionHistorySchema = z
  .object({
    schemaVersion: z.literal('legal-bot-provision-history-v1'),
    act: z.string().min(1),
    documentId: z.string().min(1),
    reviewNote: z.string().min(1).max(2_000),
    sources: z.array(sourceSchema).min(1),
    fragments: z.array(fragmentSchema).min(1),
  })
  .strict()
  .superRefine((document, context) => {
    const sourceIds = new Set(document.sources.map((source) => source.sourceId));
    const versionIds = new Set<string>();
    for (const [fragmentIndex, fragment] of document.fragments.entries()) {
      const sorted = [...fragment.versions].sort((left, right) =>
        left.effectiveFrom.localeCompare(right.effectiveFrom),
      );
      for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1]!;
        if (previous.effectiveTo === null || previous.effectiveTo > sorted[index]!.effectiveFrom)
          context.addIssue({
            code: 'custom',
            path: ['fragments', fragmentIndex, 'versions'],
            message: `Overlapping intervals in ${fragment.fragmentId}`,
          });
      }
      for (const version of fragment.versions) {
        if (versionIds.has(version.versionId))
          context.addIssue({
            code: 'custom',
            path: ['fragments', fragmentIndex],
            message: `Duplicate versionId ${version.versionId}`,
          });
        versionIds.add(version.versionId);
        for (const locator of [
          ...version.textEvidence,
          ...version.effectiveFromEvidence,
          ...version.effectiveToEvidence,
        ])
          if (!sourceIds.has(locator.sourceId))
            context.addIssue({
              code: 'custom',
              path: ['fragments', fragmentIndex],
              message: `Unknown sourceId ${locator.sourceId}`,
            });
        if (version.textReview === 'primary_source_verified') {
          const primary = version.textEvidence.some(
            (locator) =>
              document.sources.find((source) => source.sourceId === locator.sourceId)?.official,
          );
          if (!primary)
            context.addIssue({
              code: 'custom',
              path: ['fragments', fragmentIndex],
              message: `${version.versionId} claims primary text review without an official source`,
            });
        }
      }
    }
  });

export type ProvisionHistoryDocument = z.infer<typeof provisionHistorySchema>;
export type ProvisionFragment = ProvisionHistoryDocument['fragments'][number];
export type HistoricalVersion = ProvisionFragment['versions'][number];

export type HistoricalResolution =
  | {
      kind: 'match';
      fragment: ProvisionFragment;
      version: HistoricalVersion;
      nextVersion: HistoricalVersion | null;
    }
  | { kind: 'not_in_force'; fragment: ProvisionFragment; commencement: string }
  | { kind: 'unverified_version'; fragment: ProvisionFragment; version: HistoricalVersion }
  | { kind: 'unknown_date'; fragment: ProvisionFragment }
  | { kind: 'unknown_section'; section: string };

export interface HistoryPolicy {
  // Minimum evidence level accepted for interval dates. Text must always be
  // verified against a primary source.
  minimumDateEvidence: Exclude<EvidenceLevel, 'unverified'>;
}

const LEVEL_RANK: Record<EvidenceLevel, number> = {
  unverified: 0,
  secondary_corroborated: 1,
  primary_source_verified: 2,
};

export class HistoricalProvisionStore {
  private readonly bySection = new Map<string, ProvisionFragment[]>();

  constructor(
    readonly document: ProvisionHistoryDocument,
    private readonly policy: HistoryPolicy = { minimumDateEvidence: 'secondary_corroborated' },
  ) {
    for (const fragment of document.fragments) {
      const sorted = {
        ...fragment,
        versions: [...fragment.versions].sort((left, right) =>
          left.effectiveFrom.localeCompare(right.effectiveFrom),
        ),
      };
      const key = fragment.section.toUpperCase();
      this.bySection.set(key, [...(this.bySection.get(key) ?? []), sorted]);
    }
  }

  static async fromFile(path: string, policy?: HistoryPolicy): Promise<HistoricalProvisionStore> {
    const parsed = provisionHistorySchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')));
    return new HistoricalProvisionStore(parsed, policy);
  }

  static fromFileSync(path: string, policy?: HistoryPolicy): HistoricalProvisionStore {
    return new HistoricalProvisionStore(
      provisionHistorySchema.parse(JSON.parse(readFileSync(resolve(path), 'utf8'))),
      policy,
    );
  }

  covers(section: string): boolean {
    return this.bySection.has(section.toUpperCase());
  }

  fragments(section: string): ProvisionFragment[] {
    return this.bySection.get(section.toUpperCase()) ?? [];
  }

  isUsable(version: HistoricalVersion): boolean {
    return (
      version.textReview === 'primary_source_verified' &&
      LEVEL_RANK[version.dateReview] >= LEVEL_RANK[this.policy.minimumDateEvidence]
    );
  }

  // Resolves every recorded fragment of a section for an ISO date.
  resolve(section: string, asOfDate: string): HistoricalResolution[] {
    const fragments = this.fragments(section);
    if (fragments.length === 0)
      return [{ kind: 'unknown_section', section: section.toUpperCase() }];
    return fragments.map((fragment) => this.resolveFragment(fragment, asOfDate));
  }

  private resolveFragment(fragment: ProvisionFragment, asOfDate: string): HistoricalResolution {
    const commencement = fragment.inForceFrom;
    if (
      commencement &&
      LEVEL_RANK[commencement.review] >= LEVEL_RANK[this.policy.minimumDateEvidence] &&
      asOfDate < commencement.date
    )
      return { kind: 'not_in_force', fragment, commencement: commencement.date };
    const index = fragment.versions.findIndex(
      (version) =>
        asOfDate >= version.effectiveFrom &&
        (version.effectiveTo === null || asOfDate < version.effectiveTo),
    );
    if (index < 0) return { kind: 'unknown_date', fragment };
    const version = fragment.versions[index]!;
    if (!this.isUsable(version)) return { kind: 'unverified_version', fragment, version };
    return { kind: 'match', fragment, version, nextVersion: fragment.versions[index + 1] ?? null };
  }

  // Sections with more than one usable version, i.e. provisions the registry
  // knows were amended. Used to warn when an undated question retrieves text
  // from a corpus whose currentness is unknown.
  amendedSections(): string[] {
    return [...this.bySection.entries()]
      .filter(([, fragments]) =>
        fragments.some(
          (fragment) => fragment.versions.filter((version) => this.isUsable(version)).length > 1,
        ),
      )
      .map(([section]) => section);
  }

  toEvidence(fragment: ProvisionFragment, version: HistoricalVersion): RagEvidence {
    const textLocator = version.textEvidence[0]!;
    const textSource = this.document.sources.find(
      (source) => source.sourceId === textLocator.sourceId,
    )!;
    return {
      chunkId: `history_${version.versionId}`,
      documentId: this.document.documentId,
      title: `${this.document.act} (${fragment.label}, version in force ${describeInterval(version)})`,
      authority: textSource.publisher,
      sectionIdentifier: fragment.section,
      sectionHeading: `${fragment.heading} (${fragment.label})`,
      pageStart: textLocator.pageStart ?? 1,
      pageEnd: textLocator.pageEnd ?? textLocator.pageStart ?? 1,
      officialSourceUrl: textSource.url,
      effectiveDate: version.effectiveFrom,
      retrievalDate: textSource.retrievedAt ?? version.reviewedAt,
      sha256: textSource.sha256 ?? '0'.repeat(64),
      legalStatus: version.effectiveTo === null ? 'unknown' : 'historical',
      text: `Section ${fragment.section} — ${fragment.heading} (${fragment.label})\n${version.text}`,
      score: 1,
    };
  }
}

export function describeInterval(version: HistoricalVersion): string {
  return version.effectiveTo
    ? `from ${version.effectiveFrom} until ${version.effectiveTo}`
    : `from ${version.effectiveFrom}; no later version recorded`;
}
