import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { splitStatuteSections } from '../src/rag/evaluation/statute-sections.js';
import { manifestSchema } from '../src/rag/ingestion/manifest.js';
import { LocalPdfJsExtractor } from '../src/rag/ingestion/pdfjs-local-extractor.js';

// Extracts the sections of the bundled sample Acts (LLP, Trade Marks, FEMA,
// CGST) into data/eval/unseen-laws.sections.json. The claim verifier was
// designed and tuned on the Companies Act only, so benchmark items built from
// these Acts measure how it generalises to laws it has never seen.
//
//   pnpm exec tsx scripts/build-unseen-sections.ts

const manifestPath = resolve('data/sample-pdfs/manifest.json');
const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
const acts = [];
for (const entry of manifest.documents) {
  const path = resolve(dirname(manifestPath), entry.file);
  const sha256 = createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
  const documentId = `legal_${sha256.slice(0, 24)}`;
  const extracted = await new LocalPdfJsExtractor().extract({
    documentId,
    sourcePath: path,
    sourceSha256: sha256,
  });
  const sections = splitStatuteSections(extracted.pages.map((page) => page.text));
  acts.push({
    act: entry.title,
    documentId,
    sha256,
    officialSourceUrl: entry.finalPdfUrl ?? entry.officialLandingUrl,
    sections,
  });
  console.log(`${entry.title}: ${sections.length} sections`);
}
await writeFile(
  'data/eval/unseen-laws.sections.json',
  `${JSON.stringify({ schemaVersion: 'legal-bot-unseen-sections-v1', acts }, null, 2)}\n`,
);
