class AuthorizationError extends Error {
  constructor(message, status = 403, code = 'FORBIDDEN') {
    super(message);
    this.name = 'AuthorizationError';
    this.status = status;
    this.code = code;
  }
}

const SCOPES = Object.freeze({
  READ: 'bot_report.read',
  TERMINAL: 'bot_report.terminal'
});

class AuthenticatedPrincipal {
  constructor({ principalId, actorId = null, scopes = [], rawToken = null, clientId = null, profileId = null, ownerUserId = null }) {
    if (!principalId || typeof principalId !== 'string') {
      throw new AuthorizationError('principalId is required for AuthenticatedPrincipal', 401, 'INVALID_PRINCIPAL');
    }
    this.principal_id = principalId;
    this.actor_id = actorId || principalId;
    this.scopes = new Set(Array.isArray(scopes) ? scopes : [scopes]);
    this.raw_token = rawToken;
    this.client_id = clientId;
    this.profile_id = profileId;
    this.owner_user_id = ownerUserId || null;
  }

  get id() { return this.principal_id; }
  hasScope(scope) { return !scope || this.scopes.has(scope); }
  assertScope(scope) {
    if (!this.hasScope(scope)) {
      throw new AuthorizationError(
        `Principal '${this.principal_id}' lacks required scope '${scope}'.`,
        403,
        'INSUFFICIENT_SCOPE'
      );
    }
  }
}

module.exports = { SCOPES, AuthenticatedPrincipal, AuthorizationError };
