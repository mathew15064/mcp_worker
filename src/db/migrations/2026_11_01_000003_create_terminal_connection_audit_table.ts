import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('terminal_connection_audit', table => {
      table.uuid('id').primary();
      table.uuid('terminal_profile_id').nullable();
      table.string('profile_name_snapshot', 100);
      table.string('actor_id', 160).nullable();
      table.string('event_type', 80);
      table.string('outcome', 40);
      table.string('detail_code', 100).nullable();
      table.string('created_at', 40);
      table.index(['terminal_profile_id', 'created_at'], 'idx_terminal_audit_profile_created');
      table.foreign('terminal_profile_id', 'terminal_profiles', 'id', { onDelete: 'SET NULL' });
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('terminal_connection_audit');
  }
};
export = migration;
