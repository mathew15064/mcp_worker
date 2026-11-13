import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.table('workers', (table) => {
      table.addString('owner_user_id', 96, { nullable: true });
    });
    await schema.table('worker_enrollment_tokens', (table) => {
      table.addString('owner_user_id', 96, { nullable: true });
    });
    await schema.adapter.exec(
      'ALTER TABLE `workers` ADD INDEX `idx_workers_owner_user` (`owner_user_id`)',
    );
    await schema.adapter.exec(
      'ALTER TABLE `worker_enrollment_tokens` ADD INDEX `idx_worker_enrollment_owner_user` (`owner_user_id`)',
    );
    await schema.adapter.exec(
      'ALTER TABLE `workers` ADD CONSTRAINT `fk_workers_owner_user` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE',
    );
    await schema.adapter.exec(
      'ALTER TABLE `worker_enrollment_tokens` ADD CONSTRAINT `fk_worker_enrollment_owner_user` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE',
    );
    await schema.adapter.exec(
      "UPDATE `mcp_oauth_clients` SET `allowed_scopes_json` = JSON_ARRAY('bot_report.read', 'bot_report.terminal', 'offline_access') WHERE `owner_user_id` IS NOT NULL",
    );
  },
  async down(schema: SchemaBuilder) {
    await schema.adapter.exec(
      "UPDATE `mcp_oauth_clients` SET `allowed_scopes_json` = JSON_ARRAY('bot_report.read', 'offline_access') WHERE `owner_user_id` IS NOT NULL",
    );
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
