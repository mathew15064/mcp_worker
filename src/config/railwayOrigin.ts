/** A stable Railway project HTTPS origin. Request headers are untrusted. */
export function canonicalRailwayOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const custom = env.MCP_PUBLIC_BASE_URL || '';
  const provided = custom || env.RAILWAY_PUBLIC_DOMAIN || '';
  if (!provided) return null;
  const url = new URL(provided.startsWith('https://') ? provided : 'https://' + provided);
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^[a-z0-9.-]+$/i.test(url.hostname)
  )
    throw new Error('Invalid canonical Railway origin.');
  // Railway-generated domains must be platform owned; custom domains are
  // explicitly supplied by the owner's own MCP_PUBLIC_BASE_URL setting.
  if (!custom && !url.hostname.endsWith('.railway.app'))
    throw new Error('Railway domain must be managed by Railway.');
  return url.origin;
}
