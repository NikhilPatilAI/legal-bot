import { z } from 'zod';

// The ingestion manifest lists every PDF to index with its provenance. A
// document is only indexed when its source is recorded, so every answer can
// cite where the text came from.

/** Hosts that publish Indian primary legal texts. */
export const OFFICIAL_LEGAL_HOSTS = new Set([
  'cbic-gst.gov.in',
  'cbic.gov.in',
  'egazette.gov.in',
  'gst.gov.in',
  'gstcouncil.gov.in',
  'ibbi.gov.in',
  'indiacode.gov.in',
  'indiacode.nic.in',
  'incometax.gov.in',
  'incometaxindia.gov.in',
  'ipindia.gov.in',
  'legislative.gov.in',
  'mca.gov.in',
  'nclat.nic.in',
  'nclt.gov.in',
  'rbi.org.in',
  'rbidocs.rbi.org.in',
  'sci.gov.in',
  'sebi.gov.in',
  'tdb.gov.in',
]);

/** Legal areas understood by the question router (see legal-category.ts). */
export const LEGAL_CATEGORIES = [
  'companies',
  'llp',
  'sebi',
  'gst',
  'trademarks',
  'ibbi',
  'rbi-fema',
  'income-tax',
  'case-law',
] as const;

export function isOfficialLegalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/^www\./u, '');
    return url.protocol === 'https:' && OFFICIAL_LEGAL_HOSTS.has(host);
  } catch {
    return false;
  }
}

const isoDate = z.iso.date().nullable().default(null);

export const manifestEntrySchema = z
  .object({
    /** PDF path relative to the manifest file. */
    file: z
      .string()
      .min(1)
      .refine((value) => !value.split(/[\\/]/u).includes('..'), 'file must stay inside the folder'),
    title: z.string().min(1).max(300),
    authority: z.string().min(1).max(200),
    legalCategory: z.enum(LEGAL_CATEGORIES),
    documentType: z.string().min(1).nullable().default(null),
    documentNumber: z.string().min(1).nullable().default(null),
    publicationDate: isoDate,
    effectiveDate: isoDate,
    amendmentDate: isoDate,
    language: z.string().min(1).default('English'),
    /** Direct link to the PDF on the publisher's site. */
    finalPdfUrl: z.url().nullable().default(null),
    /** The publisher's page for the document. */
    officialLandingUrl: z.url().nullable().default(null),
    notes: z.string().nullable().default(null),
  })
  .strict();

export const manifestSchema = z
  .object({
    schemaVersion: z.literal('legal-bot-manifest-v1'),
    documents: z.array(manifestEntrySchema).min(1),
  })
  .strict();

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type Manifest = z.infer<typeof manifestSchema>;

/**
 * Provenance problems for one entry. By default every document needs an
 * official HTTPS source; `allowUnofficial` accepts other sources (they are
 * still recorded, and flagged in the chunk metadata).
 */
export function provenanceProblems(entry: ManifestEntry, allowUnofficial: boolean): string[] {
  const urls = [entry.finalPdfUrl, entry.officialLandingUrl].filter(
    (value): value is string => value !== null,
  );
  if (urls.length === 0) return ['no source URL recorded'];
  if (!allowUnofficial && !urls.some(isOfficialLegalUrl))
    return ['no official https source on the allow-list (use --allow-unofficial to override)'];
  return [];
}
