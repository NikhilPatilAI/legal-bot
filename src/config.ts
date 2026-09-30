import { z } from 'zod';

// All runtime settings come from environment variables and are validated once
// at start-up, so a misconfigured deployment fails immediately with a clear
// message instead of failing on the first user question.

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),

    // Where evidence comes from:
    //   index        - the SQLite FTS5 index built by `pnpm ingest` from PDFs;
    //   sections     - the bundled Companies Act, 2013 section corpus, with
    //                  connected-provision expansion and amendment history;
    //   azure_search - an Azure AI Search hybrid (keyword + vector) index.
    RETRIEVER: z.enum(['sections', 'index', 'azure_search']).default('index'),
    SECTIONS_PATH: z.string().default('data/sections/companies-act-2013.sections.json'),
    INDEX_PATH: z.string().default('data/index/legal-bot.sqlite'),
    // Index mode: also search stored embeddings and merge with BM25 (Reciprocal
    // Rank Fusion). Needs scripts/build-embeddings.ts and an embedding deployment.
    HYBRID_RETRIEVAL: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    // Point-in-time answers ("as of 1 March 2020") for provisions with recorded
    // amendment history. Empty disables historical lookups.
    HISTORY_PATH: z.string().default('data/history/companies-act-2013.history.json'),
    // Which amendment dates may be used: only dates confirmed by a primary
    // source (the Gazette notification itself), or also dates corroborated by
    // secondary official sources. Stricter means more "cannot establish" replies.
    HISTORY_MIN_DATE_EVIDENCE: z
      .enum(['primary_source_verified', 'secondary_corroborated'])
      .default('primary_source_verified'),

    // How answers are written: verbatim extracts (no model, free) or Azure
    // OpenAI generation over the retrieved evidence (billable per token).
    COMPOSER: z.enum(['extract', 'azure_openai']).default('extract'),
    // Every drafted answer is checked claim by claim against the evidence and
    // withheld when it fails. Only switch off to measure the verifier's effect.
    VERIFICATION: z.enum(['deterministic', 'off']).default('deterministic'),
    // Azure OpenAI latency varies under quota pressure; 30 s cut off 15% of
    // answers in the blind test, so the default is 60 s.
    ANSWER_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
    // Unset: 0.7 with the Azure OpenAI composer (chosen on the dev set), off otherwise.
    CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).optional(),

    AZURE_OPENAI_ENDPOINT: z.url().optional(),
    AZURE_OPENAI_GENERATION_DEPLOYMENT: z.string().min(1).optional(),
    AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z.string().min(1).optional(),
    AZURE_OPENAI_API_VERSION: z.string().min(1).default('2025-04-01-preview'),
    AZURE_SEARCH_ENDPOINT: z.url().optional(),
    AZURE_SEARCH_INDEX: z.string().min(1).optional(),

    // API protection. With API keys set, POST /v1/ask needs
    // "Authorization: Bearer <key>". Production requires keys unless the
    // deployment is explicitly a public demo.
    API_KEYS: z.string().optional(),
    PUBLIC_DEMO: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    CORS_ORIGINS: z.string().optional(),
    ASK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(600).default(20),
    TRUST_PROXY: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  })
  .superRefine((env, context) => {
    const issue = (path: string, message: string) =>
      context.addIssue({ code: 'custom', path: [path], message });
    const keys = list(env.API_KEYS);
    if (keys.some((key) => key.length < 32))
      issue('API_KEYS', 'Each API key must be at least 32 characters long');
    if (env.NODE_ENV === 'production' && keys.length === 0 && !env.PUBLIC_DEMO)
      issue('API_KEYS', 'Production requires API_KEYS, or PUBLIC_DEMO=true for an open demo');
    const needsGeneration = env.COMPOSER === 'azure_openai' || env.RETRIEVER === 'azure_search';
    if (needsGeneration && (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_GENERATION_DEPLOYMENT))
      issue(
        'AZURE_OPENAI_ENDPOINT',
        'Azure OpenAI needs AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_GENERATION_DEPLOYMENT',
      );
    if (
      env.HYBRID_RETRIEVAL &&
      (!env.AZURE_OPENAI_ENDPOINT || !env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT)
    )
      issue(
        'HYBRID_RETRIEVAL',
        'Hybrid retrieval needs AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
      );
    if (
      env.RETRIEVER === 'azure_search' &&
      (!env.AZURE_SEARCH_ENDPOINT ||
        !env.AZURE_SEARCH_INDEX ||
        !env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT)
    )
      issue(
        'AZURE_SEARCH_ENDPOINT',
        'Azure AI Search needs AZURE_SEARCH_ENDPOINT, AZURE_SEARCH_INDEX and AZURE_OPENAI_EMBEDDING_DEPLOYMENT',
      );
  });

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const env = parsed.data;
  return {
    environment: env.NODE_ENV,
    http: {
      host: env.HOST,
      port: env.PORT,
      logLevel: env.LOG_LEVEL,
      corsOrigins: list(env.CORS_ORIGINS),
      trustProxy: env.TRUST_PROXY,
      askRateLimitPerMinute: env.ASK_RATE_LIMIT_PER_MINUTE,
    },
    auth: { apiKeys: list(env.API_KEYS), publicDemo: env.PUBLIC_DEMO },
    rag: {
      retriever: env.RETRIEVER,
      sectionsPath: env.SECTIONS_PATH,
      indexPath: env.INDEX_PATH,
      hybrid: env.HYBRID_RETRIEVAL,
      historyPath: env.HISTORY_PATH || null,
      historyMinimumDateEvidence: env.HISTORY_MIN_DATE_EVIDENCE,
      composer: env.COMPOSER,
      verification: env.VERIFICATION,
      answerTimeoutMs: env.ANSWER_TIMEOUT_MS,
      confidenceThreshold:
        env.CONFIDENCE_THRESHOLD ??
        (env.COMPOSER === 'azure_openai' || env.RETRIEVER === 'azure_search' ? 0.7 : 0),
      azure: {
        openAiEndpoint: env.AZURE_OPENAI_ENDPOINT,
        generationDeployment: env.AZURE_OPENAI_GENERATION_DEPLOYMENT,
        embeddingDeployment: env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
        openAiApiVersion: env.AZURE_OPENAI_API_VERSION,
        searchEndpoint: env.AZURE_SEARCH_ENDPOINT,
        searchIndexName: env.AZURE_SEARCH_INDEX,
      },
    },
  };
}
