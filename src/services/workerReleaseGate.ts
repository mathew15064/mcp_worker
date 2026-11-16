/**
 * Single source of truth for Worker distribution and onboarding.
 *
 * A signed Worker release has NOT been approved. Until owner-controlled
 * verification of a pinned release, public trust key and signed artifacts is
 * implemented and reviewed, Worker downloads must fail closed. The onboarding
 * UI must use the same gate as the HTTP routes rather than guessing from a
 * connected Worker or an HTTP HEAD response.
 *
 * Do not replace this with an environment variable toggle: an untrusted
 * runtime setting cannot authorize installation or public distribution.
 */
export function workerDistributionBlocked(): boolean {
  // Release trust is a source-reviewed decision, never a runtime platform flag.
  // Until an independently approved signed release exists, deny distribution
  // on all servers.
  return true;
}

/**
 * Read-only T2 -> Admin/onboarding contract; this is NOT an approval toggle.
 * Callers must not interpret a local test route as production-ready.
 * Only a future separately reviewed source change can supply production
 * trust material and alter the Worker distribution 503 gate.
 */
export type WorkerSignedReleaseReadiness = Readonly<{
  code: 'WORKER_SIGNED_RELEASE_PENDING';
  decision: 'NO_GO';
  signingKeyApproved: false;
  signedArtifactsApproved: false;
  productionDistributionApproved: false;
  installerHttpStatus: 503;
}>;

export function workerSignedReleaseReadiness(): WorkerSignedReleaseReadiness {
  return Object.freeze({
    code: 'WORKER_SIGNED_RELEASE_PENDING',
    decision: 'NO_GO',
    signingKeyApproved: false,
    signedArtifactsApproved: false,
    productionDistributionApproved: false,
    installerHttpStatus: 503,
  });
}
