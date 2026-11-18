export type Role = 'admin' | 'user' | null;

export interface Identity {
  id: string;
  username: string;
  role: 'admin' | 'user';
  display_name?: string | null;
  email?: string | null;
  principal_id?: string | null;
  profile_id?: string | null;
  status?: string;
}
export interface Client {
  id: string;
  client_id: string;
  display_name: string;
  principal_id: string;
  profile_id?: string | null;
  owner_user_id?: string | null;
  status: string;
  allowed_scopes: string[];
  redirect_uris: string[];
  last_authorized_at?: string | null;
  is_public?: boolean;
}
export interface User {
  id: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  role: string;
  status: string;
  last_login_at?: string | null;
  created_at?: string | null;
}
export interface Worker {
  id: string;
  name: string;
  owner_user_id?: string | null;
  owner_username?: string | null;
  status: string;
  enabled: boolean;
  connected: boolean;
  capabilities?: string[];
  hosted_isolated?: boolean;
  last_seen_at?: string | null;
}
export interface Profile {
  id: string;
  name: string;
  worker_id: string;
  worker_name?: string;
  description?: string | null;
  enabled: boolean | number;
  hosted_isolated?: boolean;
  worker_status?: string;
}
export interface Audit {
  id?: string;
  request_id?: string;
  created_at?: string;
  client_id?: string;
  client_display_name?: string;
  mcp_method?: string;
  tool_name?: string | null;
  result?: string;
  http_status?: number;
  duration_ms?: number;
}
export interface TelegramSettings {
  enabled: boolean;
  chatId: string;
  hasToken: boolean;
}
export interface McpSettings {
  enabled: boolean;
  publicBaseUrl: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  authCodeTtlSeconds: number;
  rateLimitPerMinute: number;
}
export interface Consent {
  clientName: string;
  redirectUri: string;
  scopes: string[];
  resource: string;
  state: string;
  client_id: string;
  redirect_uri: string;
  scope: string;
  code_challenge: string;
  code_challenge_method: string;
}
export interface Runtime {
  version: string;
  gitSha?: string | null;
  buildTime?: string | null;
  startedAt?: string;
  nodeEnv?: string;
  toolCount: number;
}
export interface Storage {
  state: string;
  operational?: boolean;
  lastError?: { message?: string } | null;
}
export interface PageData {
  users?: User[];
  clients?: Client[];
  workers?: Worker[];
  profiles?: Profile[];
  logs?: Audit[];
  toolNames?: string[];
  tools?: { name: string; description: string }[];
  mcp?: McpSettings;
  telegram?: TelegramSettings;
  registrationEnabled?: boolean;
  hostedExecutionEnabled?: boolean;
  hasWorker?: boolean;
  clientCount?: number;
  firstCall?: boolean;
  total?: number;
  perPage?: number;
  page?: number;
  filters?: { query: string; clientId: string; toolName: string; result: string };
  consent?: Consent;
  release?: { productionDistributionApproved: boolean; decision: string };
}
export interface UiState {
  role: Role;
  csrfToken: string;
  identity: Identity | null;
  endpoint: string;
  registrationEnabled: boolean;
  runtime: Runtime;
  storage: Storage;
  data: PageData;
  flash?: { success: string; error: string };
  secret?: { clientId: string; clientSecret: string } | null;
  enrollment?: { token: string; expires_at: string } | null;
}
