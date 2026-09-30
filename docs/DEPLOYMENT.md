# Deployment

## Container

```bash
docker build -t legal-bot .
docker run -p 3000:3000 -e API_KEYS="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" legal-bot
```

The image:

- builds the TypeScript and the sample index at build time (`pnpm ingest`), then keeps only production dependencies;
- runs as the unprivileged `node` user, works on a read-only filesystem (see `docker-compose.yml`), and has a `HEALTHCHECK` on `/ready`;
- starts with `NODE_ENV=production`, which **refuses to start without `API_KEYS`** unless `PUBLIC_DEMO=true` is set explicitly.

To serve a larger corpus, mount your index and point `INDEX_PATH` at it:

```bash
docker run -p 3000:3000 -v /srv/legal-index:/index:ro -e INDEX_PATH=/index/legal-bot.sqlite -e API_KEYS=... legal-bot
```

## Azure Container Apps (example)

```bash
az acr build -r <registry> -t legal-bot:1.0.0 .
az containerapp create -g <rg> -n legal-bot --environment <env> \
  --image <registry>.azurecr.io/legal-bot:1.0.0 --target-port 3000 --ingress external \
  --min-replicas 0 --max-replicas 3 \
  --secrets api-keys=<key> \
  --env-vars API_KEYS=secretref:api-keys TRUST_PROXY=true
```

For Azure OpenAI answers, enable a **system-assigned managed identity** on the app, grant it the **Cognitive Services OpenAI User** role on the Azure OpenAI resource, and set `COMPOSER=azure_openai`, `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_GENERATION_DEPLOYMENT`. No key is stored: `DefaultAzureCredential` uses the managed identity. Check the deployment's tokens-per-minute quota: about 4,000 input tokens per question means a 30K TPM deployment handles roughly 7 questions per minute.

## Operations checklist

| Area             | Setting / behaviour                                                                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication   | `API_KEYS` (comma-separated, 32+ characters each). Rotate by adding the new key, deploying, then removing the old one.                                                                                                                |
| Abuse limits     | `ASK_RATE_LIMIT_PER_MINUTE` per client IP (default 20); 120 requests/minute per client IP across all routes; 16 KB bodies; 4,000-character questions. Set `TRUST_PROXY=true` only behind a proxy you control, so client IPs are real. |
| Browser security | Strict CSP (`default-src 'self'`, no inline script), `X-Content-Type-Options`, frame denial; CORS closed unless `CORS_ORIGINS` is set.                                                                                                |
| Timeouts         | `ANSWER_TIMEOUT_MS` (default 30 s); client disconnects cancel the work.                                                                                                                                                               |
| Logging          | Method, status, latency and request id only. Questions and answers are never logged.                                                                                                                                                  |
| Probes           | `/health` (process up), `/ready` (corpus loaded).                                                                                                                                                                                     |
| Shutdown         | SIGTERM stops accepting connections and lets in-flight answers finish.                                                                                                                                                                |
| Model cost       | Extract composer: none. Azure OpenAI: about ₹0.04–0.11 per question at list price.                                                                                                                                                    |
| Data currency    | Indexed texts carry `legalStatus: unknown`; re-ingest when consolidations are updated.                                                                                                                                                |
