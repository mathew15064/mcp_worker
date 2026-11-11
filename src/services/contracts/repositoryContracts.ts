import type oauthRepository from '../../repositories/mcpOAuthRepository';
import type workerRepository from '../../repositories/workerRepository';

/** Explicit application ports: services depend only on methods they use,
 * not the full persistence implementation or a concrete database adapter. */
export type OAuthRepositoryContract = Pick<
  typeof oauthRepository,
  | 'consumeAuthCodeAndIssueTokens'
  | 'createAuthCode'
  | 'createClient'
  | 'findAccessTokenByHash'
  | 'findAuthCodeByHash'
  | 'findClientByClientId'
  | 'findClientById'
  | 'findRefreshTokenByHash'
  | 'recordClientAuthorization'
  | 'revokeAccessToken'
  | 'revokeRefreshToken'
  | 'revokeTokenFamily'
  | 'rotateRefreshTokenAndIssueAccess'
  | 'updateClientSecret'
>;

export type WorkerIdentityRepositoryContract = Pick<
  typeof workerRepository,
  'consumeEnrollmentToken' | 'createWorker' | 'findWorkerById'
>;
