import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { loadLegalEvalDataset } from '../src/rag/evaluation/legal-eval-dataset.js';
import { documentVersion } from '../src/rag/retrieval/corpus-index-retriever.js';

// Builds data/eval/full-corpus-heldout-3.eval.json from the sampled provisions
// and the questions written for them.
//
//   - every expected fact must occur verbatim in the sampled provision's page;
//   - accepted documents are computed mechanically: every version of the same
//     instrument (same version family) whose text contains all the facts.
//
//   pnpm exec tsx scripts/build-heldout-3.ts -- --index <full corpus index>

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    index: { type: 'string' },
    sample: { type: 'string', default: 'data/eval/heldout-3.sample.json' },
    questions: { type: 'string', default: 'data/eval/heldout-3.questions.json' },
    out: { type: 'string', default: 'data/eval/full-corpus-heldout-3.eval.json' },
    prefix: { type: 'string', default: 'ho3' },
    split: { type: 'string', default: 'heldout' },
    title: {
      type: 'string',
      default: 'third held-out set, randomly sampled provisions',
    },
  },
});
if (!values.index) throw new Error('--index is required');

interface Sampled {
  area: string;
  documentId: string;
  title: string;
  page: number;
  chunkId: string;
  sentence: string;
}
const sample = (JSON.parse(await readFile(values.sample, 'utf8')) as { sample: Sampled[] }).sample;
const questions = JSON.parse(await readFile(values.questions, 'utf8')) as {
  answerable: Array<{ index: number; question: string; facts: string[] }>;
  refusals: Array<{ id: string; question: string; basis: string }>;
};

const normalize = (text: string) =>
  text
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[‘’]/gu, "'")
    .replace(/[“”]/gu, '"')
    .replace(/\s+/gu, ' ');

const database = new DatabaseSync(values.index, { readOnly: true });
const chunkText = database.prepare('SELECT text FROM corpus_chunks WHERE chunk_id = ?');
const documentChunks = database.prepare('SELECT text FROM corpus_chunks WHERE document_id = ?');
const allDocuments = database
  .prepare('SELECT document_id, title, relative_file_path FROM corpus_documents')
  .all() as Array<{ document_id: string; title: string; relative_file_path: string }>;
const familyOf = new Map(
  allDocuments.map((row) => [
    row.document_id,
    documentVersion(row.title, row.relative_file_path).family,
  ]),
);
const titles = new Map(allDocuments.map((row) => [row.document_id, row.title]));

const cases = [];
for (const item of questions.answerable) {
  const sampled = sample[item.index];
  if (!sampled) throw new Error(`No sampled provision #${item.index}`);
  const page = normalize((chunkText.get(sampled.chunkId) as { text: string }).text);
  for (const fact of item.facts)
    if (!page.includes(normalize(fact)))
      throw new Error(`#${item.index}: fact "${fact}" is not in the sampled provision`);
  const family = familyOf.get(sampled.documentId)!;
  const accepted = allDocuments
    .filter((row) => familyOf.get(row.document_id) === family)
    .filter((row) => {
      const text = normalize(
        (documentChunks.all(row.document_id) as Array<{ text: string }>)
          .map((chunk) => chunk.text)
          .join('\n'),
      );
      return item.facts.every((fact) => text.includes(normalize(fact)));
    })
    .map((row) => row.document_id)
    .sort();
  cases.push({
    split: values.split as 'dev' | 'test' | 'heldout',
    legalCategory: 'all',
    jurisdiction: 'India',
    expectedSections: [],
    connectedSections: [],
    expectAbstention: false,
    id: `${values.prefix}-${sampled.area}-${item.index}`,
    family: `${values.prefix}-${sampled.area}-${item.index}`,
    type: 'direct_lookup',
    question: item.question,
    expectedFacts: item.facts,
    acceptableDocuments: accepted,
    note: `Sampled provision #${item.index}: ${titles.get(sampled.documentId)}, page ${sampled.page}.`,
    provenance: {
      source: 'full-corpus-index',
      locators: [`${sampled.documentId}, page ${sampled.page}`],
      reviewStatus: 'ai_source_verified',
      reviewMethod:
        'Provision chosen by seeded random sampling; question written for it; facts matched verbatim in the sampled page; accepted documents are every version of the same instrument containing the facts (computed mechanically).',
      ambiguity: null,
    },
  });
}
for (const refusal of questions.refusals)
  cases.push({
    split: values.split as 'dev' | 'test' | 'heldout',
    legalCategory: 'all',
    jurisdiction: 'India',
    expectedSections: [],
    connectedSections: [],
    expectAbstention: true,
    id: `${values.prefix}-refusal-${refusal.id}`,
    family: `${values.prefix}-refusal-${refusal.id}`,
    type: 'insufficient_evidence',
    question: refusal.question,
    expectedFacts: [],
    acceptableDocuments: [],
    note: refusal.basis,
    provenance: {
      source: 'none',
      locators: [],
      reviewStatus: 'ai_source_verified',
      reviewMethod: `Refusal basis: ${refusal.basis}`,
      ambiguity: null,
    },
  });

const dataset = {
  schemaVersion: 'legal-bot-legal-eval-v2',
  act: `Indian regulatory corpus (5,082 official PDFs): ${values.title}`,
  corpus: 'full-corpus-index',
  reviewStatus: 'source_reviewed',
  reviewNote:
    'Third held-out set, built on 2026-09-29 from a seeded random sample of provisions (seed 20260929) across eight legal areas, with fixed exclusion rules (see heldout-3.questions.json). Frozen before any run. Facts are verbatim in the sampled provision; accepted documents were computed mechanically. Not lawyer-reviewed; facts describe the indexed text, not verified current law.',
  cases,
};
const text = `${JSON.stringify(dataset, null, 2)}\n`;
await writeFile(values.out, text);
await loadLegalEvalDataset(values.out);
console.log(
  `${cases.length} cases (${questions.answerable.length} answerable, ${questions.refusals.length} refusals). sha256 ${createHash('sha256').update(text).digest('hex')}`,
);
