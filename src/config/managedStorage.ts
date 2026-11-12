/** Supported marketplace-provided credentials, without user-pasted URLs.
 * Both Upstash direct and Vercel KV integration variable names are accepted.
 */
import { Redis } from '@upstash/redis';

export function managedRedisConnection(env: NodeJS.ProcessEnv = process.env) {
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '';
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '';
  if (!url || !token) return null;
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
  return { url, token };
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
