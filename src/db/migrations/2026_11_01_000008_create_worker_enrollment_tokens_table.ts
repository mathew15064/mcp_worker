import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('worker_enrollment_tokens', table => {
      table.uuid('id').primary();
      table.string('token_hash', 64);
      table.string('expires_at', 40);
      table.string('used_at', 40).nullable();
      table.string('created_at', 40);
      table.unique('token_hash', 'uq_worker_enrollment_token_hash');
      table.index('expires_at', 'idx_worker_enrollment_expires');
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('worker_enrollment_tokens');
  }
};
export = migration;
