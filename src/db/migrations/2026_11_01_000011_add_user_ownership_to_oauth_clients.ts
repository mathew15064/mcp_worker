import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.table('mcp_oauth_clients', (table) => {
      table.addString('owner_user_id', 96, { nullable: true });
    });
    await schema.addIndexIfMissing('mcp_oauth_clients', 'idx_mcp_clients_owner_user', [
      'owner_user_id',
    ]);
    await schema.addForeignIfMissing(
      'mcp_oauth_clients',
      'fk_mcp_clients_owner_user',
      'owner_user_id',
      'users',
      'CASCADE',
    );
  },
  async down(schema: SchemaBuilder) {
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
