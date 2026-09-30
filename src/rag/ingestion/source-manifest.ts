import { createHash } from 'node:crypto';

import { z } from 'zod';

export const OFFICIAL_HOSTS_BY_AUTHORITY = {
  india_code: ['indiacode.gov.in'],
  ministry_of_corporate_affairs: ['mca.gov.in', 'www.mca.gov.in'],
  gazette_of_india: ['egazette.gov.in', 'www.egazette.gov.in'],
  technology_development_board: ['tdb.gov.in', 'www.tdb.gov.in'],
  sebi: ['sebi.gov.in', 'www.sebi.gov.in'],
  cbic: ['cbic.gov.in', 'www.cbic.gov.in'],
  gst: ['gst.gov.in', 'www.gst.gov.in'],
  ip_india: ['ipindia.gov.in', 'www.ipindia.gov.in'],
  ibbi: ['ibbi.gov.in', 'www.ibbi.gov.in'],
  rbi: ['rbi.org.in', 'www.rbi.org.in'],
  income_tax_department: ['incometax.gov.in', 'www.incometax.gov.in'],
} as const;

export type OfficialAuthority = keyof typeof OFFICIAL_HOSTS_BY_AUTHORITY;

const authoritySchema = z.enum(
  Object.keys(OFFICIAL_HOSTS_BY_AUTHORITY) as [OfficialAuthority, ...OfficialAuthority[]],
);
const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO calendar date')
  .refine(isCalendarDate, 'Expected a real ISO calendar date');
const dateSchema = calendarDateSchema.nullable();
const dateTimeSchema = z.string().datetime({ offset: true }).nullable();
const httpsUrlSchema = z.url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== 'https:')
    context.addIssue({ code: 'custom', message: 'Official source URLs must use HTTPS' });
  if (url.username || url.password)
    context.addIssue({
      code: 'custom',
      message: 'Official source URLs must not contain credentials',
    });
  if (url.port && url.port !== '443')
    context.addIssue({
      code: 'custom',
      message: 'Official source URLs must use the default HTTPS port',
    });
});

const optionalArtifactPath = z.string().min(1).nullable();

export const sourceManifestSchema = z
  .object({
    documentId: z.string().regex(/^legal_[a-f0-9]{24}$/),
    title: z.string().trim().min(1).max(500),
    authority: authoritySchema,
    jurisdiction: z.string().trim().min(1).max(200),
    legalCategory: z.enum(['corporate', 'llp', 'sebi', 'gst', 'trademark', 'ibbi', 'rbi', 'tax']),
    documentType: z.enum([
      'act',
      'rules',
      'regulation',
      'circular',
      'notification',
      'order',
      'instruction',
      'manual',
      'faq',
      'form_guidance',
    ]),
    officialLandingUrl: httpsUrlSchema,
    originalDownloadUrl: httpsUrlSchema,
    publicationDate: dateSchema,
    effectiveDate: dateSchema,
    amendmentDate: dateSchema,
    retrievedAt: dateTimeSchema,
    version: z.string().trim().min(1).max(200),
    legalStatus: z.enum(['current', 'historical', 'amended', 'superseded', 'unknown']),
    supersedes: z.array(z.string().regex(/^legal_[a-f0-9]{24}$/)),
    supersededBy: z.array(z.string().regex(/^legal_[a-f0-9]{24}$/)),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    mimeType: z.literal('application/pdf').nullable(),
    originalFilename: z.string().refine(isSafePdfFilename, 'Expected a safe leaf PDF filename'),
    pageCount: z.number().int().positive().nullable(),
    sourceAccessStatus: z.enum(['authorized', 'blocked', 'failed', 'downloaded']),
    localPath: optionalArtifactPath,
    azureBlobPath: optionalArtifactPath,
    extractionStatus: z.enum(['not_started', 'extracted', 'ocr_required', 'failed', 'blocked']),
    indexingStatus: z.enum(['not_started', 'indexed', 'failed', 'blocked']),
    knownGaps: z.array(z.string().trim().min(1).max(1_000)),
  })
  .strict()
  .superRefine((manifest, context) => {
    const allowedHosts = OFFICIAL_HOSTS_BY_AUTHORITY[manifest.authority];
    for (const [field, value] of [
      ['officialLandingUrl', manifest.officialLandingUrl],
      ['originalDownloadUrl', manifest.originalDownloadUrl],
    ] as const) {
      const hostname = new URL(value).hostname.toLowerCase();
      if (!(allowedHosts as readonly string[]).includes(hostname)) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `Host is not approved for authority ${manifest.authority}`,
        });
      }
    }

    if (
      manifest.supersedes.includes(manifest.documentId) ||
      manifest.supersededBy.includes(manifest.documentId)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['supersedes'],
        message: 'A document cannot supersede itself',
      });
    }

    if (manifest.sourceAccessStatus === 'downloaded') {
      if (!manifest.sha256 || !manifest.retrievedAt || !manifest.localPath) {
        context.addIssue({
          code: 'custom',
          message: 'Downloaded documents require checksum, retrieval time, and local path',
        });
      }
      if (
        manifest.sha256 &&
        manifest.localPath &&
        !manifest.localPath.endsWith(`/${manifest.sha256}.pdf`)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['localPath'],
          message: 'Downloaded local path must end with its immutable checksum filename',
        });
      }
    }

    if (manifest.sourceAccessStatus === 'blocked' && manifest.knownGaps.length === 0) {
      context.addIssue({
        code: 'custom',
        path: ['knownGaps'],
        message: 'Blocked sources require a recorded reason',
      });
    }

    if (manifest.localPath)
      validateArtifactPath(manifest.localPath, ['.rag-corpus/'], 'localPath', context);
    if (manifest.azureBlobPath)
      validateArtifactPath(
        manifest.azureBlobPath,
        ['legal-raw/', 'legal-extracted/', 'legal-manifests/'],
        'azureBlobPath',
        context,
      );
  });

export type SourceManifest = z.infer<typeof sourceManifestSchema>;

export function createDocumentId(
  input: Pick<SourceManifest, 'authority' | 'officialLandingUrl' | 'version'>,
): string {
  const canonical = `${input.authority}\n${new URL(input.officialLandingUrl).toString()}\n${input.version.normalize('NFC')}`;
  return `legal_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

export function parseSourceManifest(input: unknown): SourceManifest {
  const parsed = sourceManifestSchema.parse(input);
  if (createDocumentId(parsed) !== parsed.documentId) {
    throw new Error(
      'Manifest documentId is not deterministic for its authority, landing URL, and version',
    );
  }
  return {
    ...parsed,
    supersedes: [...new Set(parsed.supersedes)].sort(),
    supersededBy: [...new Set(parsed.supersededBy)].sort(),
    knownGaps: [...new Set(parsed.knownGaps)].sort(),
  };
}

export function validateManifestCollection(inputs: readonly unknown[]): SourceManifest[] {
  const manifests = inputs.map(parseSourceManifest);
  const ids = new Set<string>();
  const contentKeys = new Set<string>();
  const versionKeys = new Set<string>();

  for (const manifest of manifests) {
    if (ids.has(manifest.documentId))
      throw new Error(`Duplicate documentId: ${manifest.documentId}`);
    ids.add(manifest.documentId);

    const versionKey = `${manifest.authority}|${manifest.officialLandingUrl}|${manifest.version}`;
    if (versionKeys.has(versionKey))
      throw new Error(`Duplicate authoritative version: ${versionKey}`);
    versionKeys.add(versionKey);

    if (manifest.sha256) {
      const contentKey = `${manifest.authority}|${manifest.sha256}`;
      if (contentKeys.has(contentKey))
        throw new Error(`Duplicate authoritative content: ${contentKey}`);
      contentKeys.add(contentKey);
    }
  }

  return manifests.sort((left, right) => left.documentId.localeCompare(right.documentId));
}

function validateArtifactPath(
  value: string,
  requiredPrefixes: readonly string[],
  field: string,
  context: z.RefinementCtx,
): void {
  const normalized = value.replaceAll('\\', '/');
  const segments = normalized.split('/');
  if (
    normalized !== value ||
    normalized.startsWith('/') ||
    segments.includes('..') ||
    segments.includes('.') ||
    segments.includes('') ||
    !requiredPrefixes.some((prefix) => normalized.startsWith(prefix))
  ) {
    context.addIssue({ code: 'custom', path: [field], message: `Unsafe or unexpected ${field}` });
  }
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() + 1 === month &&
    parsed.getUTCDate() === day
  );
}

export function isSafePdfFilename(value: string): boolean {
  if (
    value.length < 5 ||
    value.length > 255 ||
    !value.toLowerCase().endsWith('.pdf') ||
    value.includes('/') ||
    value.includes('\\')
  )
    return false;
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 32 && codePoint !== 127;
  });
}
