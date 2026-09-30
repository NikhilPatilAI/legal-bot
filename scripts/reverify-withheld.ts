import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import type { RagEvidence } from '../src/rag/rag-service.js';
import { DeterministicClaimVerifier } from '../src/rag/verification/claim-verifier.js';

// Re-runs the current claim verifier on drafts that an evaluation run
// withheld, against the same evidence, without calling the model again. Used
// for error analysis on development sets only.
//
//   pnpm exec tsx scripts/reverify-withheld.ts -- --report reports/dev.json --index <index>

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: { report: { type: 'string' }, index: { type: 'string' } },
});
if (!values.report || !values.index) throw new Error('--report and --index are required');

const report = JSON.parse(await readFile(values.report, 'utf8')) as {
  runs: Array<{
    cases: Array<{
      id: string;
      verification?: { draft?: string; evidenceChunkIds?: string[] } | null;
    }>;
  }>;
};
const database = new DatabaseSync(values.index, { readOnly: true });
const chunk = database.prepare(
  'SELECT chunk_id, document_id, title, authority, page_start, page_end, text, source_sha256 FROM corpus_chunks WHERE chunk_id = ?',
);
const verifier = new DeterministicClaimVerifier();
let passing = 0;
let total = 0;
for (const run of report.runs)
  for (const item of run.cases) {
    const draft = item.verification?.draft;
    if (!draft) continue;
    total += 1;
    const evidence = (item.verification?.evidenceChunkIds ?? []).map((id) => {
      const row = chunk.get(id) as {
        chunk_id: string;
        document_id: string;
        title: string;
        authority: string;
        page_start: number;
        page_end: number;
        text: string;
        source_sha256: string;
      };
      return {
        chunkId: row.chunk_id,
        documentId: row.document_id,
        title: row.title,
        authority: row.authority,
        sectionIdentifier: `Page ${row.page_start}`,
        sectionHeading: null,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        officialSourceUrl: null,
        effectiveDate: null,
        retrievalDate: '2026-09-02T11:52:00.000Z',
        sha256: row.source_sha256,
        legalStatus: 'unknown',
        text: row.text,
        score: 1,
      } satisfies RagEvidence;
    });
    const result = await verifier.verify(draft, evidence);
    const blocking = result.claims.filter((claim) =>
      ['contradicted', 'unverified_citation', 'unverified_quotation'].includes(claim.status),
    );
    const passes = blocking.length === 0 && result.supportedClaimCount >= result.claimCount * 0.5;
    if (passes) passing += 1;
    console.log(
      `${passes ? 'PASS' : 'HOLD'} ${item.id} (${result.supportedClaimCount}/${result.claimCount})`,
    );
    for (const claim of result.claims.filter((entry) => entry.status !== 'supported'))
      console.log(`   ${claim.status} ${claim.reasons.join(',')} | ${claim.text.slice(0, 150)}`);
  }
console.log(`\n${passing}/${total} withheld drafts would now pass.`);
