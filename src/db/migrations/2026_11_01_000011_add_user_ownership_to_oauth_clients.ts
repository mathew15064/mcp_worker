import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.table('mcp_oauth_clients', table => {
      table.addString('owner_user_id', 96, { nullable: true });
    });
    await schema.adapter.exec('ALTER TABLE `mcp_oauth_clients` ADD INDEX `idx_mcp_clients_owner_user` (`owner_user_id`)');
    await schema.adapter.exec('ALTER TABLE `mcp_oauth_clients` ADD CONSTRAINT `fk_mcp_clients_owner_user` FOREIGN KEY (`owner_user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE');
  },
  async down(schema: SchemaBuilder) {
    await schema.adapter.exec('ALTER TABLE `mcp_oauth_clients` DROP FOREIGN KEY `fk_mcp_clients_owner_user`');
    await schema.adapter.exec('ALTER TABLE `mcp_oauth_clients` DROP INDEX `idx_mcp_clients_owner_user`');
    await schema.table('mcp_oauth_clients', table => {
      table.dropColumn('owner_user_id');
    });
  }
};
export = migration;
