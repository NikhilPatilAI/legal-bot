import { writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

import { textQuality } from '../src/rag/retrieval/corpus-index-retriever.js';

// Draws a seeded random sample of provisions from a corpus index, as the
// starting point for an evaluation set. Questions are then written for the
// sampled provisions, so the set is not biased towards provisions the author
// already knows the system answers well.
//
//   pnpm exec tsx scripts/sample-provisions.ts -- --index <path> --seed 20260929 --per-area 12
//
// Sampling frame: pages of primary instruments (titles with Act, Rules,
// Regulations or Code, excluding amendment notifications) in each legal area
// except case law; usable English text; not an arrangement-of-sections page.
// Candidate sentences state a rule ("shall" or "must") with a number, or
// define a term ("means"). At most one provision per document.

const { values } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  options: {
    index: { type: 'string' },
    seed: { type: 'string', default: '20260929' },
    'per-area': { type: 'string', default: '12' },
    spares: { type: 'string', default: '6' },
    out: { type: 'string', default: 'reports/sampled-provisions.json' },
  },
});
if (!values.index) throw new Error('--index is required');

const AREAS = ['companies', 'llp', 'sebi', 'gst', 'trademarks', 'ibbi', 'rbi-fema', 'income-tax'];
const perArea = Number(values['per-area']) + Number(values.spares);

// mulberry32: small, seedable, reproducible across machines.
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const next = random(Number(values.seed));
const shuffle = <T>(items: T[]): T[] => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(next() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
};

const database = new DatabaseSync(values.index, { readOnly: true });
const documentsInArea = database.prepare(
  `SELECT document_id, title FROM corpus_documents
   WHERE legal_category = ?
     AND (title LIKE '%Act%' OR title LIKE '%Rules%' OR title LIKE '%Regulations%' OR title LIKE '%Code%')
     AND title NOT LIKE '%mendment%'
   ORDER BY document_id`,
);
const documents = (area: string) => documentsInArea.all(area);
const pages = database.prepare(
  "SELECT chunk_id, page_start, text FROM corpus_chunks WHERE document_id = ? AND content_kind = 'page_text' ORDER BY page_start, chunk_id",
);

const RULE =
  /\b(?:shall|must)\b[^.;]*\b(?:\d+|one|two|three|four|five|six|seven|ten|fifteen|twenty|thirty|forty|forty-five|sixty|ninety|hundred|lakh|crore|per cent)\b/iu;
const DEFINITION = /[“"][^”"]{3,60}[”"]\s+means\b/u;

const sample: Array<{
  area: string;
  documentId: string;
  title: string;
  page: number;
  chunkId: string;
  sentence: string;
}> = [];
for (const area of AREAS) {
  const pool = shuffle(documents(area) as Array<{ document_id: string; title: string }>);
  let taken = 0;
  for (const document of pool) {
    if (taken >= perArea) break;
    const candidates: Array<{ chunkId: string; page: number; sentence: string }> = [];
    for (const page of pages.all(document.document_id) as Array<{
      chunk_id: string;
      page_start: number;
      text: string;
    }>) {
      if (textQuality(page.text) !== 'usable' || /arrangement\s+of\s+sections/iu.test(page.text))
        continue;
      for (const sentence of page.text
        .normalize('NFKC')
        .replace(/\s+/gu, ' ')
        .split(/(?<=[.;:])\s+(?=\(?[A-Z0-9“"])/u)) {
        const clean = sentence.trim();
        if (clean.length < 80 || clean.length > 360) continue;
        if (RULE.test(clean) || DEFINITION.test(clean))
          candidates.push({ chunkId: page.chunk_id, page: page.page_start, sentence: clean });
      }
    }
    if (candidates.length === 0) continue;
    const chosen = candidates[Math.floor(next() * candidates.length)]!;
    sample.push({ area, documentId: document.document_id, title: document.title, ...chosen });
    taken += 1;
  }
}
await writeFile(values.out, `${JSON.stringify({ seed: values.seed, sample }, null, 2)}\n`);
console.log(`Sampled ${sample.length} provisions`);
