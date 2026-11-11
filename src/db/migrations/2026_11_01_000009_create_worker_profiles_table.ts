import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('worker_profiles', table => {
      table.uuid('id').primary();
      table.string('name', 100);
      table.string('description', 500).nullable();
      table.uuid('worker_id');
      table.string('tmux_session', 80);
      table.boolean('enabled').default(1);
      table.timestamps();
      table.unique('name', 'uq_worker_profiles_name');
      table.index('worker_id', 'idx_worker_profiles_worker');
      table.foreign('worker_id', 'workers', 'id', { onDelete: 'CASCADE' });
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('worker_profiles');
  }
};
export = migration;
