# ==============================================================================
# Multi-Stage Production Dockerfile for Bot Report
# Runtime: configurable Node.js Alpine (musl libc); default Node 26.13.0
# Architecture: Single non-root container listening on 0.0.0.0:80
# ==============================================================================

# ------------------------------------------------------------------------------
# Stage 1: Native Dependency Builder
# ------------------------------------------------------------------------------
ARG BOT_REPORT_NODE_IMAGE=node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
FROM ${BOT_REPORT_NODE_IMAGE} AS builder

WORKDIR /app

# Install native build tools required for compiling better-sqlite3 C++ addons on Alpine
RUN apk add --no-cache python3 make g++

# Copy package manifests for reproducible dependency installation
COPY package.json package-lock.json ./

# Install only production dependencies (better-sqlite3 compiled against Alpine musl)
RUN npm ci --omit=dev && npm cache clean --force

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
ARG BOT_REPORT_GIT_SHA=unknown
ARG BOT_REPORT_WORKER_VERSION=2.3.4
RUN chmod +x ./scripts/build-worker-go.sh && VERSION="$BOT_REPORT_WORKER_VERSION" COMMIT="$BOT_REPORT_GIT_SHA" ./scripts/build-worker-go.sh

# ------------------------------------------------------------------------------
# Stage 3: Minimal Production Runtime
# ------------------------------------------------------------------------------
FROM ${BOT_REPORT_NODE_IMAGE} AS runner

WORKDIR /app

# Upgrade the npm CLI shipped by the Node base without changing Node itself.
# Verify the exact npm registry tarball integrity before installing.
RUN set -eux; cd /tmp; npm pack npm@11.21.2 --silent; \
    node -e "const fs=require('node:fs'),c=require('node:crypto');if(c.createHash('sha512').update(fs.readFileSync('npm-11.21.2.tgz')).digest('base64')!=='7HPApk+AflMUavSseL1Pm6CnYqMIHk53x+KmuhqmTDqPkjPMgxIpTPcTqsE91EKNw4gFBJV9fnXiSdGm1DXq9A==')process.exit(1)"; \
    npm install -g --ignore-scripts /tmp/npm-11.21.2.tgz; \
    test "$(npm --version)" = 11.21.2; rm /tmp/npm-11.21.2.tgz; npm cache clean --force

# Optional build provenance. Deploy tooling injects these; direct/manual builds may leave them as unknown.
ARG BOT_REPORT_GIT_SHA=unknown
ARG BOT_REPORT_BUILD_TIME=unknown
ARG BOT_REPORT_NODE_IMAGE
LABEL org.opencontainers.image.revision="${BOT_REPORT_GIT_SHA}" \
      org.opencontainers.image.created="${BOT_REPORT_BUILD_TIME}" \
      org.bot-report.node-base="${BOT_REPORT_NODE_IMAGE}"

# Set production bootstrap defaults. MySQL connection details are configured from
# the Admin UI and persisted encrypted under /app/data. DATABASE_PATH remains only
# as the optional legacy SQLite import source for existing installations.
ENV NODE_ENV=production \
    PORT=80 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/bot_report.sqlite \
    BOT_REPORT_GIT_SHA=${BOT_REPORT_GIT_SHA} \
    BOT_REPORT_BUILD_TIME=${BOT_REPORT_BUILD_TIME}

# Copy compiled production node_modules from builder stage
COPY --from=builder /app/node_modules ./node_modules

# Copy MCP-only application source, CLI helpers, and manifests
COPY package.json ./
COPY src/ ./src/
COPY scripts/ ./scripts/
# Public v2 worker distribution served by /worker/install.sh and /worker/dist/*
COPY worker/package.json worker/package-lock.json worker/agent.js worker/cli.js worker/lifecycle.js ./worker/
COPY --from=worker-builder /src/worker/bin ./worker/bin

# Copy entrypoint script and ensure execution permissions
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Ensure data directory exists and assign ownership to non-root node user (UID: 1000, GID: 1000)
RUN mkdir -p /app/data && chown -R node:node /app

# Switch to standard non-root user provided by node:26.13.0-alpine
USER node

# Health check targeting internal HTTP port 80 using Node.js built-in fetch
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:80/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Entrypoint with existing database safety guard
ENTRYPOINT ["docker-entrypoint.sh"]

# Production command
CMD ["node", "src/server.js"]
