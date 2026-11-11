import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('mcp_oauth_authorization_codes', table => {
      table.string('id', 96).primary();
      table.string('code_hash', 128).unique();
      table.string('client_id', 128);
      table.string('user_id', 160);
      table.string('principal_id', 160);
      table.string('redirect_uri', 2048);
      table.string('resource', 2048);
      table.longText('scopes_json');
      table.string('code_challenge', 255);
      table.string('code_challenge_method', 16);
      table.string('expires_at', 40);
      table.string('used_at', 40).nullable();
      table.string('created_at', 40);
      table.index('client_id', 'idx_mcp_auth_codes_client');
    });

    await schema.createTable('mcp_oauth_access_tokens', table => {
      table.string('id', 96).primary();
      table.string('token_hash', 128).unique();
      table.string('client_id', 128);
      table.string('principal_id', 160);
      table.string('resource', 2048);
      table.longText('scopes_json');
      table.string('expires_at', 40);
      table.string('revoked_at', 40).nullable();
      table.string('created_at', 40);
      table.string('last_used_at', 40).nullable();
      table.index('client_id', 'idx_mcp_access_tokens_client');
    });

    await schema.createTable('mcp_oauth_refresh_tokens', table => {
      table.string('id', 96).primary();
      table.string('token_hash', 128).unique();
      table.string('token_family_id', 128);
      table.string('client_id', 128);
      table.string('principal_id', 160);
      table.string('resource', 2048);
      table.longText('scopes_json');
      table.string('expires_at', 40);
      table.string('revoked_at', 40).nullable();
      table.string('replaced_by_hash', 128).nullable();
      table.string('created_at', 40);
      table.string('last_used_at', 40).nullable();
      table.index('token_family_id', 'idx_mcp_refresh_tokens_family');
      table.index('client_id', 'idx_mcp_refresh_tokens_client');
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('mcp_oauth_refresh_tokens');
    await schema.dropTable('mcp_oauth_access_tokens');
    await schema.dropTable('mcp_oauth_authorization_codes');
  }
};
export = migration;
