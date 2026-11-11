import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('users', table => {
      table.string('id', 96).primary();
      table.string('username', 64).unique();
      table.string('email', 254).nullable().unique();
      table.string('display_name', 120);
      table.string('password_hash', 128);
      table.string('role', 20).default('user');
      table.string('status', 20).default('active');
      table.string('principal_id', 160).unique();
      table.string('profile_id', 96).unique();
      table.integer('session_version').default(1);
      table.string('last_login_at', 40).nullable();
      table.string('created_at', 40);
      table.string('updated_at', 40);
      table.index('status', 'idx_users_status');
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('users');
  }
};
export = migration;
