const express = require('express');
const crypto = require('crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const oauthResourceServer = require('../auth/oauthResourceServer');
const mcpOAuthRepository = require('../repositories/mcpOAuthRepository');
const databaseManager = require('../db/databaseManager');
const mcpConfig = require('../config/mcpConfig');
const { runWithPrincipal } = require('./context');
const { createMcpServer } = require('./server');
const { createResponseCapture, captureRequestPayload, captureResponsePayload } = require('../services/auditPayloadService');

async function recordSafeAudit({
  requestId,
  principal,
  method,
  toolName,
  res,
  startMs,
  requestCapture,
  responseCapture
}) {
  try {
    const durationMs = Math.max(0, Date.now() - startMs);
    const httpStatus = res.statusCode || 200;
    let result = 'SUCCESS';
    if (httpStatus === 401 || httpStatus === 403) {
      result = 'DENIED';
    } else if (httpStatus >= 400) {
      result = 'ERROR';
    }

    const responsePayload = responseCapture ? captureResponsePayload(responseCapture, res) : { payload: null, truncated: false };
    await mcpOAuthRepository.recordAudit({
      requestId,
      clientId: principal?.client_id || null,
      principalId: principal?.principal_id || null,
      actorId: principal?.actor_id || null,
      mcpMethod: method || 'UNKNOWN',
      toolName: toolName || null,
      result,
      httpStatus,
      durationMs,
      requestPayload: requestCapture?.payload || null,
      responsePayload: responsePayload.payload,
      requestTruncated: Boolean(requestCapture?.truncated),
      responseTruncated: Boolean(responsePayload.truncated)
    });
  } catch (_) {
    // Non-blocking: audit failure must not crash active transport.
  }
}

function createMcpRouter({ resourceServer = oauthResourceServer } = {}) {
  const router = express.Router();
  const authMiddleware = resourceServer.createMiddleware();
  router.use('/mcp', (req, res, next) => {
    if (!databaseManager.isOperational()) return res.status(503).json({ error: 'Database unavailable', code: databaseManager.status().state });
    if (!mcpConfig.enabled) return res.status(503).json({ error: 'MCP disabled', code: 'MCP_DISABLED' });
    next();
  });

  router.post('/mcp', authMiddleware, async (req, res) => {
    const requestId = `req_${crypto.randomUUID()}`;
    const startMs = Date.now();
    const method = req.body?.method || 'POST';
    const toolName = req.body?.params?.name || null;
    const requestCapture = captureRequestPayload(req.body);
    const responseCapture = createResponseCapture(res);

    // The finish hook is the single audit source of truth. Errors are converted
    // to an HTTP status below, so recording again in catch would duplicate rows.
    res.once('finish', () => {
      recordSafeAudit({
        requestId,
        principal: req.principal,
        method,
        toolName,
        res,
        startMs,
        requestCapture,
        responseCapture
      }).catch(() => {});
    });

    try {
      await runWithPrincipal(req.principal, async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined
        });
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
      }, { requestId, clientId: req.principal?.client_id });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal Server Error',
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred'
        });
      } else {
        // Do not attempt a second response after the transport has started.
        try { res.end(); } catch (_) {}
      }
    }
  });

  router.get('/mcp', authMiddleware, async (req, res) => {
    const requestId = `req_${crypto.randomUUID()}`;
    const startMs = Date.now();
    const method = 'GET';
    const requestCapture = captureRequestPayload({ method: 'GET', query: req.query || {} });
    const responseCapture = createResponseCapture(res);

    res.once('finish', () => {
      recordSafeAudit({
        requestId,
        principal: req.principal,
        method,
        toolName: null,
        res,
        startMs,
        requestCapture,
        responseCapture
      }).catch(() => {});
    });

    try {
      await runWithPrincipal(req.principal, async () => {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined
        });
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      }, { requestId, clientId: req.principal?.client_id });
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Internal Server Error',
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred'
        });
      } else {
        try { res.end(); } catch (_) {}
      }
    }
  });

  return { router };
}

module.exports = {
  createMcpRouter
};
