import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { Type } from '@sinclair/typebox';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';

import type { AppConfig } from './config.js';
import { AppError, toProblem } from './errors.js';
import { httpLoggerOptions, SafeHttpLogController } from './observability/http-logging.js';
import type {
  LegalRagClient,
  RagProgressEvent,
  RagQueryInput,
  RagQueryResult,
} from './rag/rag-service.js';

export interface AppDependencies {
  config: AppConfig;
  ragService: LegalRagClient;
  /** Directory of the browser UI; omitted in tests that only exercise the API. */
  webRoot?: string;
}

const AskBody = Type.Object(
  {
    question: Type.String({ minLength: 1, maxLength: 4_000 }),
    // Optional filter: "gst", "trademarks", "companies", ... or "all".
    legalCategory: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    // Answer as the law stood on this date (point-in-time questions).
    asOfDate: Type.Optional(Type.String({ format: 'date' })),
    resultLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, default: 5 })),
  },
  { additionalProperties: false },
);

type AskInput = {
  question: string;
  legalCategory?: string;
  asOfDate?: string;
  resultLimit?: number;
};

/**
 * HTTP API:
 *   GET  /health       liveness (process is up)
 *   GET  /ready        readiness (corpus loaded)
 *   GET  /v1/status    corpus coverage and limitations
 *   POST /v1/ask       answer a question (JSON, or NDJSON progress stream)
 *   GET  /             browser UI
 */
export async function buildApp({ config, ragService, webRoot }: AppDependencies) {
  const production = config.environment === 'production';
  const app = Fastify({
    logger:
      config.environment === 'test'
        ? false
        : { ...httpLoggerOptions(), level: config.http.logLevel },
    // Logs carry method, status and request id only: never questions, answers
    // or headers.
    logController: new SafeHttpLogController(),
    bodyLimit: 16_384,
    trustProxy: config.http.trustProxy,
    requestTimeout: config.rag.answerTimeoutMs + 5_000,
    genReqId: (request) =>
      typeof request.headers['x-request-id'] === 'string' &&
      /^[0-9a-f-]{36}$/iu.test(request.headers['x-request-id'])
        ? request.headers['x-request-id']
        : randomUUID(),
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
      },
    },
  });
  if (config.http.corsOrigins.length > 0)
    await app.register(cors, {
      origin: config.http.corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['authorization', 'content-type', 'accept', 'x-request-id'],
      exposedHeaders: ['x-request-id'],
    });
  await app.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  const authorize = apiKeyGuard(config.auth.apiKeys);

  app.get('/health', async () => ({ status: 'ok' as const }));
  app.get('/ready', async (_request, reply) => {
    try {
      const status = await ragService.status();
      return status.state === 'ready'
        ? { status: 'ready' as const }
        : reply.code(503).send({ status: 'not_ready' });
    } catch {
      return reply.code(503).send({ status: 'not_ready' });
    }
  });
  app.get('/v1/status', async (request) => {
    authorize(request);
    return { data: await ragService.status() };
  });
  app.post(
    '/v1/ask',
    {
      config: { rateLimit: { max: config.http.askRateLimitPerMinute, timeWindow: '1 minute' } },
      schema: { body: AskBody },
    },
    async (request, reply) => {
      authorize(request);
      const body = request.body as AskInput;
      // Cancel retrieval and generation when the client disconnects.
      const cancellation = new AbortController();
      request.raw.once('aborted', () => cancellation.abort());
      const input: RagQueryInput = {
        question: body.question,
        legalCategory: body.legalCategory ?? 'all',
        jurisdiction: 'India',
        resultLimit: body.resultLimit ?? 5,
        ...(body.asOfDate ? { asOfDate: body.asOfDate } : {}),
      };
      reply.header('cache-control', 'no-store');
      if (!request.headers.accept?.includes('application/x-ndjson'))
        return { data: await ragService.query(input, request.id, cancellation.signal) };
      return streamProgress(reply, request.id, input, ragService, cancellation.signal, production);
    },
  );

  if (webRoot) await app.register(fastifyStatic, { root: resolve(webRoot), index: ['index.html'] });

  app.setErrorHandler(async (error, request, reply) => {
    let mapped: unknown = error;
    if ((error as { validation?: unknown }).validation)
      mapped = new AppError(422, 'validation_failed', 'Request validation failed');
    else if ((error as { statusCode?: number }).statusCode === 429)
      mapped = new AppError(429, 'rate_limited', 'Too many questions; try again in a minute');
    const problem = toProblem(
      mapped,
      request.id,
      request.routeOptions.url ?? '/unmatched',
      production,
    );
    if (problem.status >= 500)
      request.log.error({ code: problem.code, requestId: request.id }, 'request failed');
    return reply.type('application/problem+json').code(problem.status).send(problem);
  });
  await app.ready();
  return app;
}

// Bearer API keys, compared by SHA-256 digest in constant time so response
// timing does not reveal how much of a guessed key was right. With no keys
// configured (local development or an explicit public demo) access is open.
function apiKeyGuard(keys: readonly string[]) {
  const digests = keys.map((key) => createHash('sha256').update(key).digest());
  return (request: FastifyRequest) => {
    if (digests.length === 0) return;
    const header = request.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer\s+(\S+)$/u.exec(header) : null;
    if (!match) throw new AppError(401, 'authentication_required', 'An API key is required');
    const presented = createHash('sha256').update(match[1]!).digest();
    if (!digests.some((digest) => timingSafeEqual(digest, presented)))
      throw new AppError(401, 'authentication_required', 'The API key is not valid');
  };
}

// Streams progress events ("retrieving sources", "drafting answer") and the
// final result as newline-delimited JSON, so the UI can show what is happening
// during a slow model call.
function streamProgress(
  reply: FastifyReply,
  requestId: string,
  input: RagQueryInput,
  ragService: LegalRagClient,
  signal: AbortSignal,
  production: boolean,
): FastifyReply {
  const stream = new PassThrough();
  const write = (
    value:
      | { type: 'progress'; data: RagProgressEvent }
      | { type: 'result'; data: RagQueryResult }
      | { type: 'error'; error: ReturnType<typeof toProblem> },
  ) => {
    if (!stream.destroyed) stream.write(`${JSON.stringify(value)}\n`);
  };
  void ragService
    .query(input, requestId, signal, (event) => write({ type: 'progress', data: event }))
    .then((result) => write({ type: 'result', data: result }))
    .catch((error: unknown) =>
      write({ type: 'error', error: toProblem(error, requestId, '/v1/ask', production) }),
    )
    .finally(() => stream.end());
  return reply
    .header('cache-control', 'no-store, no-transform')
    .header('x-accel-buffering', 'no')
    .type('application/x-ndjson; charset=utf-8')
    .send(stream);
}
