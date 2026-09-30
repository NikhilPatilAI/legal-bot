import { describe, expect, it } from 'vitest';

import { LEGAL_ASSISTANT_SYSTEM_PROMPT } from '../../src/rag/generation/azure-openai.js';

describe('legal assistant capability contract', () => {
  it.each([
    'trademark and compliance guidance',
    'GST and ROC questions',
    'contract or agreement explanation',
    'document summarization',
    'legal draft templates',
    'compliance reminder or workflow checklists',
  ])('keeps the requested capability: %s', (capability) => {
    expect(LEGAL_ASSISTANT_SYSTEM_PROMPT).toContain(capability);
  });

  it('requires grounded drafts, honest abstention, and non-persistent reminder disclosure', () => {
    expect(LEGAL_ASSISTANT_SYSTEM_PROMPT).toContain(
      'Use only the supplied corpus evidence for legal claims',
    );
    expect(LEGAL_ASSISTANT_SYSTEM_PROMPT).toContain('Draft for professional review');
    expect(LEGAL_ASSISTANT_SYSTEM_PROMPT).toContain('LEGALBOT_ABSTAIN:');
    expect(LEGAL_ASSISTANT_SYSTEM_PROMPT).toContain(
      'does not schedule or send persistent reminders',
    );
    expect(LEGAL_ASSISTANT_SYSTEM_PROMPT).not.toContain('—');
  });
});
