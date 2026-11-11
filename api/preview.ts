import { createVercelPreviewHandler } from '../src/deployment/vercelPreview';

/**
 * Vercel Node.js Function at /api/preview.
 *
 * Only a preview database readiness probe, not the MCP server.
 * No database initialization, session creation, OAuth secrets or
 * shell/Worker execution occurs in this endpoint.
 */
export default {
  fetch: createVercelPreviewHandler(),
};
