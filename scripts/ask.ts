import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

import { loadConfig } from '../src/config.js';
import { createRagService } from '../src/rag/factory.js';

// Ask one question from the command line, using the same configuration and
// pipeline as the server.
//
//   pnpm ask "How many designated partners must an LLP have?" --retriever index
//   pnpm ask "What does section 188 cover?"                    # Companies Act sections

const { values, positionals } = parseArgs({
  args: process.argv.slice(2).filter((argument) => argument !== '--'),
  allowPositionals: true,
  options: {
    retriever: { type: 'string' },
    'as-of': { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
const question = positionals.join(' ').trim();
if (!question) {
  console.error(
    'Usage: pnpm ask "your question" [--retriever sections|index] [--as-of YYYY-MM-DD]',
  );
  process.exit(2);
}

const config = loadConfig({
  ...process.env,
  ...(values.retriever ? { RETRIEVER: values.retriever } : {}),
});
const service = await createRagService(config);
const result = await service.query(
  {
    question,
    legalCategory: 'all',
    jurisdiction: 'India',
    resultLimit: 5,
    ...(values['as-of'] ? { asOfDate: values['as-of'] } : {}),
  },
  randomUUID(),
);

if (values.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n${result.abstained ? '[declined] ' : ''}${result.answer}\n`);
  for (const [index, citation] of result.citations.entries())
    console.log(
      `  [${index + 1}] ${citation.title}, ${citation.sectionIdentifier}` +
        (citation.officialSourceUrl ? `  ${citation.officialSourceUrl}` : ''),
    );
  for (const warning of result.warnings) console.log(`  note: ${warning}`);
}
