import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { loadConfig } from '../../src/config.js';
import type { LegalRagClient } from '../../src/rag/rag-service.js';

const status = {
  state: 'ready' as const,
  indexSchemaVersion: 'legal-bot-corpus-index-v1',
  lastSuccessfulIngestionAt: '2026-09-02T00:00:00.000Z',
  categories: [{ category: 'companies', documents: 1, chunks: 499, state: 'enabled' as const }],
  limitations: ['Legal currentness is unverified.'],
};

const apiKey = 'k'.repeat(40);
const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(environment: Record<string, string> = {}) {
  const ragService = {
    status: vi.fn().mockResolvedValue(status),
    query: vi.fn().mockResolvedValue({ answer: 'Grounded answer', abstained: false }),
  } as unknown as LegalRagClient;
  const config = loadConfig({ NODE_ENV: 'test', ...environment });
  const app = await buildApp({ config, ragService });
  apps.push(app);
  return { app, ragService };
}

describe('HTTP API', () => {
  it('reports liveness and readiness without authentication', async () => {
    const { app } = await createApp({ API_KEYS: apiKey });
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toEqual({ status: 'ok' });
    expect((await app.inject({ method: 'GET', url: '/ready' })).json()).toEqual({
      status: 'ready',
    });
  });

  it('requires a valid API key when keys are configured', async () => {
    const { app, ragService } = await createApp({ API_KEYS: apiKey });
    const missing = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      payload: { question: 'What does section 188 cover?' },
    });
    const wrong = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers: { authorization: `Bearer ${'x'.repeat(40)}` },
      payload: { question: 'What does section 188 cover?' },
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.headers['content-type']).toContain('application/problem+json');
    expect(missing.json()).toMatchObject({ code: 'authentication_required' });
    expect(wrong.statusCode).toBe(401);
    expect(ragService.query).not.toHaveBeenCalled();

    const allowed = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: { question: 'What does section 188 cover?' },
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers['cache-control']).toBe('no-store');
    expect(ragService.query).toHaveBeenCalledWith(
      expect.objectContaining({ legalCategory: 'all', jurisdiction: 'India', resultLimit: 5 }),
      expect.any(String),
      expect.any(AbortSignal),
    );
  });

  it('rejects malformed questions with a problem document', async () => {
    const { app } = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      payload: { question: '', extra: true },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: 'validation_failed',
      type: 'urn:legal-bot:problem:validation-failed',
    });
  });

  it('streams progress events from the answer pipeline', async () => {
    const { app, ragService } = await createApp();
    vi.mocked(ragService.query).mockImplementation(
      async (_input, _requestId, _signal, reportProgress) => {
        reportProgress?.({ stage: 'checking_scope', message: 'Checking the question' });
        reportProgress?.({ stage: 'retrieving_sources', message: 'Retrieving sources' });
        reportProgress?.({ stage: 'drafting_answer', message: 'Drafting an answer' });
        return { answer: 'Grounded answer', abstained: false } as never;
      },
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ask',
      headers: { accept: 'application/x-ndjson' },
      payload: { question: 'What does section 188 cover?' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
    const events = response.body
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; data?: { stage?: string } });
    expect(events.map((event) => event.type)).toEqual([
      'progress',
      'progress',
      'progress',
      'result',
    ]);
  });

  it('echoes a valid request id and sets security headers', async () => {
    const { app } = await createApp();
    const id = '0f6f6c2e-5a3b-4c47-9f7e-3a5c0d9a1b2c';
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': id },
    });
    expect(response.headers['x-request-id']).toBe(id);
    expect(response.headers['content-security-policy']).toContain("default-src 'self'");
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('configuration', () => {
  it('refuses production without API keys unless it is an explicit public demo', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/API_KEYS/u);
    expect(loadConfig({ NODE_ENV: 'production', PUBLIC_DEMO: 'true' }).auth.publicDemo).toBe(true);
    expect(() => loadConfig({ API_KEYS: 'short' })).toThrow(/at least 32/u);
  });

  it('requires Azure settings when the Azure composer is selected', () => {
    expect(() => loadConfig({ COMPOSER: 'azure_openai' })).toThrow(/AZURE_OPENAI_ENDPOINT/u);
  });

  it('enables selective answering by default only for the model composer', () => {
    const azure = {
      COMPOSER: 'azure_openai',
      AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com/',
      AZURE_OPENAI_GENERATION_DEPLOYMENT: 'model',
    };
    expect(loadConfig({}).rag.confidenceThreshold).toBe(0);
    expect(loadConfig(azure).rag.confidenceThreshold).toBe(0.7);
    expect(loadConfig({ ...azure, CONFIDENCE_THRESHOLD: '0' }).rag.confidenceThreshold).toBe(0);
    expect(() => loadConfig({ CONFIDENCE_THRESHOLD: '2' })).toThrow();
  });
});
