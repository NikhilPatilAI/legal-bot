import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ingest } from '../src/rag/ingestion/ingest.js';

// Builds (or incrementally updates) the search index from a folder of PDFs.
//
//   pnpm ingest                                   # the bundled sample Acts
//   pnpm ingest -- --manifest path/to/manifest.json --index data/index/legal-bot.sqlite
//
// See docs/DATA.md for the manifest format.

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    manifest: { type: 'string', default: 'data/sample-pdfs/manifest.json' },
    index: { type: 'string', default: 'data/index/legal-bot.sqlite' },
    report: { type: 'string', default: 'reports/ingest-report.json' },
    'allow-unofficial': { type: 'boolean', default: false },
  },
});

const started = Date.now();
const report = await ingest({
  manifestPath: values.manifest,
  indexPath: values.index,
  allowUnofficial: values['allow-unofficial'],
  onProgress: ({ file, outcome }) => console.log(`${outcome.padEnd(8)} ${file}`),
});
await mkdir(dirname(resolve(values.report)), { recursive: true });
await writeFile(values.report, `${JSON.stringify(report, null, 2)}\n`);

console.log(
  `\nIndexed ${report.indexed}, already present ${report.alreadyIndexed}, failed ${report.failures.length}` +
    ` (${report.ocrRequired} need OCR). Index: ${report.totalDocuments} documents, ${report.totalChunks} chunks,` +
    ` built in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
);
for (const failure of report.failures) console.error(`  failed: ${failure.file}: ${failure.error}`);
if (report.failures.length > 0) process.exitCode = 1;
