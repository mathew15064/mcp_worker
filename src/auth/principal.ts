export class AuthorizationError extends Error {
  constructor(
    message: string,
    public status = 403,
    public code = 'FORBIDDEN',
  ) {
    super(message);
    this.name = 'AuthorizationError';
  }
}
export const SCOPES = Object.freeze({
  READ: 'bot_report.read',
  TERMINAL: 'bot_report.terminal',
} as const);
export interface PrincipalOptions {
  principalId: string;
  actorId?: string | null;
  scopes?: string[] | string;
  rawToken?: string | null;
  clientId?: string | null;
  profileId?: string | null;
  ownerUserId?: string | null;
}
export class AuthenticatedPrincipal {
  principal_id: string;
  actor_id: string;
  scopes: Set<string>;
  raw_token: string | null;
  client_id: string | null;
  profile_id: string | null;
  owner_user_id: string | null;
  declare client_name?: string | null;
  constructor({
    principalId,
    actorId = null,
    scopes = [],
    rawToken = null,
    clientId = null,
    profileId = null,
    ownerUserId = null,
  }: PrincipalOptions) {
    if (!principalId || typeof principalId !== 'string') {
      throw new AuthorizationError(
        'principalId is required for AuthenticatedPrincipal',
        401,
        'INVALID_PRINCIPAL',
      );
    }
    this.principal_id = principalId;
    this.actor_id = actorId || principalId;
    this.scopes = new Set(Array.isArray(scopes) ? scopes : [scopes]);
    this.raw_token = rawToken;
    this.client_id = clientId;
    this.profile_id = profileId;
    this.owner_user_id = ownerUserId || null;
  }
  get id(): string {
    return this.principal_id;
  }
  hasScope(scope?: string | null): boolean {
    return !scope || this.scopes.has(scope);
  }
  assertScope(scope?: string | null): void {
    if (!this.hasScope(scope)) {
      throw new AuthorizationError(
        `Principal '${this.principal_id}' lacks required scope '${scope}'.`,
        403,
        'INSUFFICIENT_SCOPE',
      );
    }
  }
}
