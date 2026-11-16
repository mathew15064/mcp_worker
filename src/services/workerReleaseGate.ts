/**
 * Single source of truth for public signed Worker *binary distribution*.
 *
 * Until an owner-approved signed release exists, all public installer/binary
 * routes return HTTP 503. Authenticated Admin development enrollment may
 * independently issue short-lived one-use tokens for Workers manually built
 * from reviewed source; this never authorizes unsigned public downloads.
 *
 * Do not replace distribution approval with an environment variable toggle.
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
