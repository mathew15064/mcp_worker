import runtimeSettings from './runtimeSettingsService';
import { encryptString, decryptString, readKey } from './applicationKeyService';
import { createHmac } from 'node:crypto';

const AAD = 'mcp_worker:turnstile-secret:v1';
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const KEY_PATTERN = /^[A-Za-z0-9_-]{12,128}$/;
const TEST_SITE_KEYS = new Set([
  '1x00000000000000000000AA',
  '2x00000000000000000000AB',
  '3x00000000000000000000FF',
]);

type SiteverifyResult = {
  success?: boolean;
  hostname?: string;
  action?: string;
  'error-codes'?: string[];
};
export type TurnstilePurpose = 'login' | 'register' | 'config-test';

export function configuration() {
  const siteKey = runtimeSettings.get('turnstile.site_key', '');
  const stored = runtimeSettings.get('turnstile.secret_key', '');
  const hasSecret = stored.startsWith('enc:v1:');
  const enabled = runtimeSettings.bool('turnstile.enabled', false);
  return { enabled, siteKey, hasSecret, active: enabled && !!siteKey && hasSecret };
}

export function publicChallenge() {
  const config = configuration();
  return { enabled: config.active, siteKey: config.active ? config.siteKey : '' };
}

export function monitoring() {
  return {
    ...configuration(),
    passed: runtimeSettings.int('turnstile.passed', 0, { min: 0 }),
    failed: runtimeSettings.int('turnstile.failed', 0, { min: 0 }),
    lastCheckedAt: runtimeSettings.get('turnstile.last_checked_at', ''),
    lastResult: runtimeSettings.get('turnstile.last_result', ''),
    lastError: runtimeSettings.get('turnstile.last_error', ''),
  };
}

function fingerprint(siteKey: string, secret: string): string {
  return createHmac('sha256', readKey())
    .update(siteKey, 'utf8')
    .update('\0', 'utf8')
    .update(secret, 'utf8')
    .digest('hex');
}

export async function markConfigurationVerified(siteKey: string, providedSecret: string) {
  const stored = runtimeSettings.get('turnstile.secret_key', '');
  const secret = providedSecret || decryptString(stored, AAD);
  await runtimeSettings.set('turnstile.verified_fingerprint', fingerprint(siteKey, secret));
}

export async function saveConfiguration(input: {
  siteKey: string;
  secret: string;
  enabled: boolean;
}) {
  const siteKey = input.siteKey.trim();
  if (siteKey && !KEY_PATTERN.test(siteKey)) throw new Error('Invalid Turnstile Site Key.');
  if (input.enabled && process.env.NODE_ENV === 'production' && TEST_SITE_KEYS.has(siteKey))
    throw new Error('Cloudflare test keys cannot be enabled in production.');
  if (
    input.secret &&
    (input.secret.length < 12 || input.secret.length > 512 || /\s/.test(input.secret))
  )
    throw new Error('Invalid Turnstile Secret Key.');
  const current = runtimeSettings.get('turnstile.secret_key', '');
  if (input.enabled && (!siteKey || (!input.secret && !current.startsWith('enc:v1:'))))
    throw new Error('Site Key and Secret Key are required to enable Turnstile.');
  if (input.enabled) {
    const actualSecret = input.secret || decryptString(current, AAD);
    if (
      fingerprint(siteKey, actualSecret) !== runtimeSettings.get('turnstile.verified_fingerprint')
    )
      throw new Error('Test configuration successfully with Cloudflare before enabling Turnstile.');
  }
  const entries: Record<string, string> = {
    'turnstile.enabled': input.enabled ? 'true' : 'false',
    'turnstile.site_key': siteKey,
  };
  if (input.secret) entries['turnstile.secret_key'] = encryptString(input.secret, AAD);
  await runtimeSettings.setMany(entries);
}

async function record(success: boolean, error: string) {
  const key = success ? 'turnstile.passed' : 'turnstile.failed';
  // Keep only bounded aggregate counters and sanitized Cloudflare error identifiers.
  const count = runtimeSettings.int(key, 0, { min: 0, max: Number.MAX_SAFE_INTEGER });
  await runtimeSettings.setMany({
    [key]: String(Math.min(Number.MAX_SAFE_INTEGER, count + 1)),
    'turnstile.last_checked_at': new Date().toISOString(),
    'turnstile.last_result': success ? 'passed' : 'failed',
    'turnstile.last_error': error.slice(0, 120),
  });
}

export async function validateToken(
  token: unknown,
  purpose: TurnstilePurpose,
  candidate?: { siteKey: string; secret: string },
): Promise<boolean> {
  const config = configuration();
  if (!candidate && !config.active) return true;
  const siteKey = candidate?.siteKey || config.siteKey;
  const secret =
    candidate?.secret || decryptString(runtimeSettings.get('turnstile.secret_key', ''), AAD);
  if (!siteKey || !secret || typeof token !== 'string' || !token.trim() || token.length > 2048) {
    await record(false, 'missing-or-invalid-token');
    return false;
  }
  let success = false;
  let error = 'unavailable';
  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Siteverify unavailable');
    const result = (await response.json()) as SiteverifyResult;
    const host = new URL(runtimeSettings.get('mcp.public_base_url', 'https://localhost')).hostname;
    const validHostname = TEST_SITE_KEYS.has(siteKey) || result.hostname === host;
    success = result.success === true && validHostname && result.action === purpose;
    const codes = (result['error-codes'] || [])
      .filter((v) => /^[a-z0-9-]{1,48}$/.test(v))
      .slice(0, 2);
    error = success
      ? ''
      : codes.join(',') || (!validHostname ? 'hostname-mismatch' : 'verification-failed');
  } catch {
    error = 'siteverify-unavailable';
  }
  await record(success, error);
  return success;
}
