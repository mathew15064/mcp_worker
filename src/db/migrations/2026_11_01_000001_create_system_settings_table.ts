import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('system_settings', table => {
      table.string('key', 190).primary();
      table.longText('value');
      table.string('updated_at', 40);
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('system_settings');
  }
};
export = migration;
