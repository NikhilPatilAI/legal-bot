import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createRagService } from './rag/factory.js';

// Process entry point: validate configuration, build the answer pipeline,
// serve HTTP, and shut down gracefully on SIGINT/SIGTERM (container stop).
const config = loadConfig();
const ragService = await createRagService(config);
const app = await buildApp({ config, ragService, webRoot: 'web' });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, 'shutting down');
  // Stops accepting connections and waits for in-flight answers to finish.
  await app.close();
  process.exit(0);
}
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.http.host, port: config.http.port });
