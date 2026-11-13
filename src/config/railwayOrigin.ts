/** A stable Railway project HTTPS origin. Request headers are untrusted. */
export function canonicalRailwayOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const custom = env.MCP_PUBLIC_BASE_URL || '';
  const provided = custom || env.RAILWAY_PUBLIC_DOMAIN || '';
  if (!provided) return null;
  // A custom origin must be an explicit HTTPS URL. Reject invisible whitespace
  // that URL() would otherwise silently trim from a configured authority.
  if (/\s|[\u0000-\u001f\u007f]/.test(provided) || (custom && !custom.startsWith('https://')))
    throw new Error('Invalid canonical Railway origin.');
  const url = new URL(provided.startsWith('https://') ? provided : 'https://' + provided);
  const hostname = url.hostname;
  // Reject empty, malformed and ambiguous DNS labels; URL normalizes host case
  // and internationalized domain names to their canonical ASCII spelling.
  const validHostname =
    hostname.length <= 253 &&
    hostname.includes('.') &&
    hostname.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  if (
    url.protocol !== 'https:' ||
    !validHostname ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid canonical Railway origin.');
  // Railway-generated domains must be platform owned; custom domains are
  // explicitly supplied by the owner's MCP_PUBLIC_BASE_URL setting.
  if (!custom && !hostname.endsWith('.railway.app'))
    throw new Error('Railway domain must be managed by Railway.');
  return url.origin;
}
