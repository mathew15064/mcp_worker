import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('mcp_oauth_clients', (table) => {
      table.string('id', 96).primary();
      table.string('client_id', 128).unique();
      table.string('client_secret_hash', 128);
      table.string('display_name', 120);
      table.string('principal_id', 160);
      table.string('profile_id', 96);
      table.longText('redirect_uris_json');
      table.longText('allowed_scopes_json');
      table.string('status', 20).default('active');
      table.string('created_at', 40);
      table.string('updated_at', 40);
      table.string('last_authorized_at', 40).nullable();
      table.index('status', 'idx_mcp_clients_status');
      // SQLite cannot add a FOREIGN KEY to an existing table via ALTER TABLE.
      // The column is present from creation; the later ownership migration
      // creates its index and updates the migration version.
      if (schema.adapter.kind === 'libsql') {
        table.string('owner_user_id', 96).nullable();
        table.foreign('owner_user_id', 'users', 'id', { onDelete: 'CASCADE' });
      }
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('mcp_oauth_clients');
  },
};
export = migration;
