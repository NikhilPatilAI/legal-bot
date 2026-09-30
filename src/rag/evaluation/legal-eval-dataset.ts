import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { z } from 'zod';

// Held-out legal evaluation dataset.
//
// Each case is a question with the provision(s) a correct answer must rely on
// and the concrete facts that answer should contain. The dataset deliberately
// mixes case types so a change that helps one dimension but hurts another (for
// example, retrieving more provisions at the cost of refusing answerable
// questions) is visible in the metrics rather than hidden.
//
// Provenance and honesty: expected provisions, headings, and fact strings were
// checked against the bundled official reproduction of the Companies Act, 2013
// (the same 499-section source the retriever uses) and cross-checked against
// public background sources. This is a curated engineering benchmark reviewed
// against the source text; it is not a lawyer-certified accuracy standard, and
// currentness of the underlying source remains unverified.

export const evalCaseTypeSchema = z.enum([
  // A single section directly answers the question.
  'direct_lookup',
  // A correct answer needs more than one connected provision.
  'multi_provision',
  // The rule has an exception/proviso that a naive answer would omit.
  'exception_sensitive',
  // The named section does not exist in the corpus; the system must refuse.
  'nonexistent_section',
  // The corpus cannot support an answer; the system must refuse.
  'insufficient_evidence',
  // A version/as-of-date question that depends on the temporal registry.
  'temporal',
]);

export type EvalCaseType = z.infer<typeof evalCaseTypeSchema>;

export const caseProvenanceSchema = z
  .object({
    // Where the expected sections/facts were checked: the indexed corpus source,
    // the historical provision store, or nothing (refusal cases).
    source: z.enum(['tdb-companies-act-2013', 'provision-history', 'full-corpus-index', 'none']),
    locators: z.array(z.string().min(1).max(200)).default([]),
    // How the case was reviewed. No case in this repository is lawyer-reviewed.
    reviewStatus: z.enum(['ai_source_verified', 'ai_drafted_unverified']),
    reviewMethod: z.string().min(1).max(600),
    ambiguity: z.string().max(600).nullable().default(null),
  })
  .strict();

export const legalEvalCaseSchema = z
  .object({
    id: z.string().min(1),
    // Frozen split. Development cases may be inspected while tuning; test cases
    // are reported, never tuned against.
    split: z.enum(['dev', 'test', 'heldout']).optional(),
    // Leakage group: cases about the same provision, template or amendment
    // family share a family and must share a split.
    family: z.string().min(1).optional(),
    type: evalCaseTypeSchema,
    question: z.string().min(1),
    legalCategory: z.string().min(1),
    jurisdiction: z.string().min(1),
    // Sections a correct answer must rely on. Empty for refusal cases.
    expectedSections: z.array(z.string().regex(/^\d{1,3}[A-Z]{0,3}$/u)),
    // Sections that should also be surfaced because they qualify the primary
    // rule (exceptions, definitions, cross-references). Scored separately.
    connectedSections: z.array(z.string().regex(/^\d{1,3}[A-Z]{0,3}$/u)).default([]),
    // Full-corpus cases: indexed document ids any of which is an acceptable
    // source. The answer must cite at least one of them.
    acceptableDocuments: z.array(z.string().regex(/^legal_[a-f0-9]{24}$/u)).default([]),
    // Short factual strings a correct answer is expected to contain. Used for
    // answer-fact coverage, not for grading legal quality.
    expectedFacts: z.array(z.string().min(2)).default([]),
    // For refusal cases: the answer must abstain (no citations).
    expectAbstention: z.boolean().default(false),
    // For temporal cases only.
    asOfDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    expectedVersionId: z.string().optional(),
    note: z.string().default(''),
    provenance: caseProvenanceSchema.optional(),
  })
  .strict();

export type LegalEvalCase = z.infer<typeof legalEvalCaseSchema>;

export const legalEvalDatasetSchema = z
  .object({
    schemaVersion: z.enum(['legal-bot-legal-eval-v1', 'legal-bot-legal-eval-v2']),
    act: z.string().min(1),
    // Which retrieval corpus the cases are written against.
    corpus: z
      .enum(['companies-act-sections', 'full-corpus-index'])
      .default('companies-act-sections'),
    reviewStatus: z.enum(['verified', 'source_reviewed', 'unverified_curated']),
    reviewNote: z.string().min(1),
    cases: z.array(legalEvalCaseSchema).min(1),
  })
  .strict()
  .superRefine((dataset, context) => {
    const ids = new Set<string>();
    const familySplits = new Map<string, string>();
    for (const [index, testCase] of dataset.cases.entries()) {
      if (dataset.schemaVersion === 'legal-bot-legal-eval-v2') {
        if (!testCase.split || !testCase.family || !testCase.provenance)
          context.addIssue({
            code: 'custom',
            path: ['cases', index],
            message: 'v2 cases require split, family and provenance',
          });
        if (testCase.family && testCase.split) {
          const existing = familySplits.get(testCase.family);
          if (existing && existing !== testCase.split)
            context.addIssue({
              code: 'custom',
              path: ['cases', index, 'split'],
              message: `Family ${testCase.family} spans more than one split`,
            });
          familySplits.set(testCase.family, testCase.split);
        }
      }
      if (ids.has(testCase.id))
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'id'],
          message: 'Duplicate case id',
        });
      ids.add(testCase.id);
      const refusal =
        testCase.type === 'nonexistent_section' || testCase.type === 'insufficient_evidence';
      if (refusal && !testCase.expectAbstention)
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'expectAbstention'],
          message: 'Refusal case types must set expectAbstention',
        });
      if (
        !refusal &&
        testCase.type !== 'temporal' &&
        testCase.expectedSections.length === 0 &&
        testCase.acceptableDocuments.length === 0
      )
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'expectedSections'],
          message: 'Answerable cases must list expected sections or acceptable documents',
        });
      if (testCase.type === 'temporal' && !testCase.asOfDate)
        context.addIssue({
          code: 'custom',
          path: ['cases', index, 'asOfDate'],
          message: 'Temporal cases require an asOfDate',
        });
    }
  });

export type LegalEvalDataset = z.infer<typeof legalEvalDatasetSchema>;

export async function loadLegalEvalDataset(path: string): Promise<LegalEvalDataset> {
  return legalEvalDatasetSchema.parse(JSON.parse(await readFile(resolve(path), 'utf8')));
}

export function summarizeDataset(dataset: LegalEvalDataset): Record<EvalCaseType, number> {
  const counts = {
    direct_lookup: 0,
    multi_provision: 0,
    exception_sensitive: 0,
    nonexistent_section: 0,
    insufficient_evidence: 0,
    temporal: 0,
  } satisfies Record<EvalCaseType, number>;
  for (const testCase of dataset.cases) counts[testCase.type] += 1;
  return counts;
}
