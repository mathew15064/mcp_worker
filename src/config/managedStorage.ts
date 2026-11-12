/** Supported marketplace-provided credentials, without user-pasted URLs.
 * Both Upstash direct and Vercel KV integration variable names are accepted.
 */
import { Redis } from '@upstash/redis';

export function managedRedisConnection(env: NodeJS.ProcessEnv = process.env) {
  // Never mix the URL from one integration alias with the token from another.
  // A partially injected provider pair must fail closed rather than authenticate
  // a different Redis endpoint using unrelated credentials.
  const directUrl = env.UPSTASH_REDIS_REST_URL || '';
  const directToken = env.UPSTASH_REDIS_REST_TOKEN || '';
  const kvUrl = env.KV_REST_API_URL || '';
  const kvToken = env.KV_REST_API_TOKEN || '';
  const pair =
    directUrl && directToken
      ? { url: directUrl, token: directToken }
      : kvUrl && kvToken
        ? { url: kvUrl, token: kvToken }
        : null;
  if (!pair) return null;
  const { url, token } = pair;
  const parsed = new URL(url);
  if (
    parsed.protocol !== 'https:' &&
    !(
      parsed.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(parsed.hostname) &&
      env.VERCEL !== '1'
    )
  ) {
    throw new Error('Redis REST connection must use HTTPS.');
  }
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash)
    throw new Error('Invalid Redis REST endpoint.');
  return { url: parsed.origin, token };
}

export function managedRedis(env: NodeJS.ProcessEnv = process.env) {
  const connection = managedRedisConnection(env);
  if (!connection) throw new Error('Redis missing. Connect Upstash Redis to your Vercel project.');
  return new Redis(connection);
}

export function hasManagedPostgres(env: NodeJS.ProcessEnv = process.env) {
  return Boolean(env.POSTGRES_URL || env.DATABASE_URL);
}

export function canonicalVercelOrigin(env: NodeJS.ProcessEnv = process.env) {
  const name = env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  if (!name) return null;
  const value = name.startsWith('https://') ? name : 'https://' + name;
  const url = new URL(value);
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    !/^[a-z0-9.-]+$/i.test(url.hostname)
  )
    throw new Error('Invalid canonical Vercel origin.');
  return url.origin;
}
