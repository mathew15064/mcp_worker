# ==============================================================================
# Multi-Stage Production Dockerfile for mcp_worker
# Runtime: configurable Node.js Alpine (musl libc); default pinned Node 22.22.3
# Architecture: Single non-root container listening on 0.0.0.0:80
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Native Dependency Builder
# ------------------------------------------------------------------------------
ARG MCP_WORKER_NODE_IMAGE=node:22.22.3-alpine@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd
FROM ${MCP_WORKER_NODE_IMAGE} AS builder

WORKDIR /app

# Install native build tools required for compiling better-sqlite3 C++ addons on Alpine
RUN apk add --no-cache python3 make g++

# Copy package manifests for reproducible dependency installation
COPY package.json package-lock.json ./

# Install only production dependencies (better-sqlite3 compiled against Alpine musl)
RUN npm ci
COPY tsconfig.json ./
COPY web/package*.json ./web/
RUN npm --prefix web ci
COPY web/ ./web/
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
COPY playwright.config.ts ./
RUN npm run build && npm prune --omit=dev && npm cache clean --force

# Verify native addon binary integrity inside Alpine
RUN node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('SELECT 1 AS result').get(); db.close();"

# ------------------------------------------------------------------------------
# Stage 2: Cross-platform standalone Worker builder
# ------------------------------------------------------------------------------
FROM golang:1.26.10-alpine@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696 AS worker-builder

WORKDIR /src
COPY worker-go/go.mod worker-go/go.sum ./worker-go/
RUN cd worker-go && go mod download
COPY worker-go/ ./worker-go/
COPY scripts/build-worker-go.sh ./scripts/build-worker-go.sh
ARG MCP_WORKER_GIT_SHA=unknown
ARG MCP_WORKER_WORKER_VERSION=2.3.4
RUN chmod +x ./scripts/build-worker-go.sh && VERSION="$MCP_WORKER_WORKER_VERSION" COMMIT="$MCP_WORKER_GIT_SHA" ./scripts/build-worker-go.sh --runtime-only

# ------------------------------------------------------------------------------
# Stage 3: Minimal Production Runtime
# ------------------------------------------------------------------------------
FROM ${MCP_WORKER_NODE_IMAGE} AS runner

WORKDIR /app

# Optional build provenance. Deploy tooling injects these; direct/manual builds may leave them as unknown.
ARG MCP_WORKER_GIT_SHA=unknown
ARG MCP_WORKER_BUILD_TIME=unknown
ARG MCP_WORKER_TREE_SHA=unknown
ARG MCP_WORKER_NODE_IMAGE
LABEL org.opencontainers.image.revision="${MCP_WORKER_GIT_SHA}" \
      org.opencontainers.image.created="${MCP_WORKER_BUILD_TIME}" \
      org.opencontainers.image.source="https://github.com/mathew15064/mcp_worker" \
      org.mcp_worker.source-tree="${MCP_WORKER_TREE_SHA}" \
      org.mcp_worker.image-flavor="standalone" \
      org.mcp_worker.build-origin="local-pc-only" \
      org.mcp_worker.go-base="golang:1.26.10-alpine@sha256:87c65a688975c0b1d4585d204874c45ca78354670e3a5f11368c5a492303d696" \
      org.mcp_worker.node-base="${MCP_WORKER_NODE_IMAGE}"

# Persistent SQLite lives under /app/data; no external database service.
ENV NODE_ENV=production \
    PORT=80 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/mcp_worker.sqlite \
    MCP_WORKER_GIT_SHA=${MCP_WORKER_GIT_SHA} \
    MCP_WORKER_BUILD_TIME=${MCP_WORKER_BUILD_TIME}

# Copy compiled production node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy MCP-only application source, CLI helpers, and manifests
COPY package.json ./
COPY --from=builder /app/dist/src ./dist/src/
COPY --from=builder /app/dist/scripts ./dist/scripts/
COPY --from=builder /app/dist/package.json ./dist/package.json
# Compatibility paths used by the standalone installer and release harness.
RUN ln -s dist/src src && ln -s dist/scripts scripts && ln -s dist/worker worker
COPY --from=worker-builder /src/worker/bin ./dist/worker/bin

# Copy entrypoint script and ensure execution permissions
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Ensure data directory exists and assign ownership to non-root node user (UID: 1000, GID: 1000)
# npm and corepack are build tools, not required by the running Node server.
# Remove their CLI entrypoints and runtime files without adding a Docker layer.
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && mkdir -p /app/data && chown -R node:node /app

# Switch to standard non-root user provided by node:22.22.3-alpine
USER node

# Health check targeting internal HTTP port 80 using Node.js built-in fetch
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:80/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Entrypoint with existing database safety guard
ENTRYPOINT ["docker-entrypoint.sh"]

# Production command
CMD ["node", "dist/src/server.js"]
