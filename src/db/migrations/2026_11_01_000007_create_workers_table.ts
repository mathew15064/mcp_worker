import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('workers', table => {
      table.uuid('id').primary();
      table.string('name', 100);
      table.longText('public_key');
      table.longText('capabilities_json');
      table.boolean('enabled').default(1);
      table.string('status', 20).default('offline');
      table.string('last_seen_at', 40).nullable();
      table.timestamps();
      table.unique('name', 'uq_workers_name');
      table.index('status', 'idx_workers_status');
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('workers');
  }
};
export = migration;
