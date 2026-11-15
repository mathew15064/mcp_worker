import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.table('workers', (table) => {
      table.addString('owner_user_id', 96, { nullable: true });
    });
    await schema.table('worker_enrollment_tokens', (table) => {
      table.addString('owner_user_id', 96, { nullable: true });
    });
    await schema.addIndexIfMissing('workers', 'idx_workers_owner_user', ['owner_user_id']);
    await schema.addIndexIfMissing('worker_enrollment_tokens', 'idx_worker_enrollment_owner_user', [
      'owner_user_id',
    ]);
    await schema.addForeignIfMissing(
      'workers',
      'fk_workers_owner_user',
      'owner_user_id',
      'users',
      'CASCADE',
    );
    await schema.addForeignIfMissing(
      'worker_enrollment_tokens',
      'fk_worker_enrollment_owner_user',
      'owner_user_id',
      'users',
      'CASCADE',
    );
    // Ownership is not a grant. Never overwrite an OAuth client's existing scopes.
    // Already-executed historical versions require a separate explicit grant audit.
  },
  async down(schema: SchemaBuilder) {
    // Rollback also preserves the scopes a client was explicitly granted.
    await schema.adapter.exec(
      'ALTER TABLE `worker_enrollment_tokens` DROP FOREIGN KEY `fk_worker_enrollment_owner_user`',
    );
    await schema.adapter.exec('ALTER TABLE `workers` DROP FOREIGN KEY `fk_workers_owner_user`');
    await schema.adapter.exec(
      'ALTER TABLE `worker_enrollment_tokens` DROP INDEX `idx_worker_enrollment_owner_user`',
    );
    await schema.adapter.exec('ALTER TABLE `workers` DROP INDEX `idx_workers_owner_user`');
    await schema.table('worker_enrollment_tokens', (table) => {
      table.dropColumn('owner_user_id');
    });
    await schema.table('workers', (table) => {
      table.dropColumn('owner_user_id');
    });
  },
};
export = migration;
