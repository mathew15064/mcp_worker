/** Minimal OAuth policy dependency. Injecting this contract avoids tying
 * service tests to the environment-backed singleton configuration. */
export interface OAuthConfig {
  readonly supportedScopes: readonly string[];
  readonly resourceUrl: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly authCodeTtlSeconds: number;
}
