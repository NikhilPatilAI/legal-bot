# syntax=docker/dockerfile:1

# ---- build: install, compile TypeScript, build the sample search index ----
FROM node:22.18.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src src
COPY scripts scripts
COPY data data
RUN pnpm build \
 && NODE_NO_WARNINGS=1 node dist/scripts/ingest.js --report /tmp/ingest-report.json \
 && pnpm prune --prod

# ---- runtime: compiled code, production dependencies and data only ----
FROM node:22.18.0-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    NODE_NO_WARNINGS=1
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules node_modules
COPY --from=build --chown=node:node /app/dist dist
COPY --from=build --chown=node:node /app/data data
COPY --chown=node:node web web
# Runs as the unprivileged "node" user; the index and data are read-only at runtime.
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
