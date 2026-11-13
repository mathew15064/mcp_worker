/**
 * Single source of truth for Railway Worker distribution and onboarding.
 *
 * A signed Worker release has NOT been approved. Until owner-controlled
 * verification of a pinned release, public trust key and signed artifacts is
 * implemented and reviewed, Railway downloads must fail closed. The onboarding
 * UI must use the same gate as the HTTP routes rather than guessing from a
 * connected Worker or an HTTP HEAD response.
 *
 * Do not replace this with an environment variable toggle: an untrusted
 * runtime setting cannot authorize installation or public distribution.
 */
export function railwayWorkerDistributionBlocked(): boolean {
  return process.env.MCP_PLATFORM === 'railway';
}
