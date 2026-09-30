import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import type { PipelineCaseResult } from '../src/rag/evaluation/pipeline-eval.js';

// Risk-coverage analysis for selective answering, from one evaluation report.
//
//   pnpm exec tsx scripts/risk-coverage.ts -- --report docs/results/dev-3-azure-confidence.json
//
// For each confidence threshold it replays the answers the service gave (or
// suppressed as low-confidence) and reports coverage (share of answerable
// questions answered) and precision (share of answers that are fully correct:
// an accepted document cited and every expected fact present). Run it on a
// report made with --min-confidence 0 so every verified answer is available.

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    report: { type: 'string' },
    step: { type: 'string', default: '0.05' },
  },
});
if (!values.report) throw new Error('--report is required');

const report = JSON.parse(await readFile(values.report, 'utf8')) as {
  runs: Array<{ label: string; cases: PipelineCaseResult[] }>;
};

interface Candidate {
  confidence: number;
  fullyCorrect: boolean;
}

for (const run of report.runs) {
  const answerable = run.cases.filter((item) => !item.expectAbstention);
  // A candidate answer exists when the verifier passed a draft: either it was
  // shown, or it was suppressed only because of low confidence.
  const candidates: Candidate[] = [];
  for (const item of answerable) {
    if (item.confidence === null || item.errorCode) continue;
    if (!item.abstained)
      candidates.push({
        confidence: item.confidence,
        fullyCorrect: item.acceptableDocumentCited === true && item.factCoverage === 1,
      });
    else if (item.lowConfidence)
      candidates.push({
        confidence: item.confidence,
        // Suppressed answers carry the sources, so the document test uses them.
        fullyCorrect:
          item.suppressedDraftDocumentCited === true && item.suppressedDraftFactCoverage === 1,
      });
  }
  console.log(
    `\n${run.label}: ${answerable.length} answerable, ${candidates.length} verified drafts`,
  );
  console.log('threshold  answered  coverage  correct  precision');
  const step = Number(values.step);
  for (let threshold = 0; threshold <= 1 + 1e-9; threshold += step) {
    const shown = candidates.filter((item) => item.confidence >= threshold - 1e-9);
    const correct = shown.filter((item) => item.fullyCorrect).length;
    console.log(
      [
        threshold.toFixed(2).padStart(9),
        String(shown.length).padStart(9),
        `${((100 * shown.length) / answerable.length).toFixed(0)}%`.padStart(9),
        String(correct).padStart(8),
        (shown.length ? `${((100 * correct) / shown.length).toFixed(0)}%` : '-').padStart(10),
      ].join(' '),
    );
  }
}
