import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    if (schema.adapter.kind === 'libsql') {
      await schema.adapter.exec(
        'CREATE INDEX IF NOT EXISTS `idx_mcp_clients_owner_user` ON `mcp_oauth_clients` (`owner_user_id`)',
      );
      return;
    }
    await schema.table('mcp_oauth_clients', (table) => {
      table.addString('owner_user_id', 96, { nullable: true });
    });
    await schema.adapter.exec(
      'ALTER TABLE `mcp_oauth_clients` ADD INDEX `idx_mcp_clients_owner_user` (`owner_user_id`)',
    );
    await schema.adapter.exec(
      'ALTER TABLE `mcp_oauth_clients` ADD CONSTRAINT `fk_mcp_clients_owner_user` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE',
    );
  },
  async down(schema: SchemaBuilder) {
    if (schema.adapter.kind === 'libsql') {
      await schema.adapter.exec('DROP INDEX IF EXISTS `idx_mcp_clients_owner_user`');
      return;
    }
    await schema.adapter.exec(
      'ALTER TABLE `mcp_oauth_clients` DROP FOREIGN KEY `fk_mcp_clients_owner_user`',
    );
    await schema.adapter.exec(
      'ALTER TABLE `mcp_oauth_clients` DROP INDEX `idx_mcp_clients_owner_user`',
    );
    await schema.table('mcp_oauth_clients', (table) => {
      table.dropColumn('owner_user_id');
    });
  },
};
export = migration;
