import type { SchemaBuilder } from '../schemaBuilder';
const migration = {
  async up(schema: SchemaBuilder) {
    await schema.createTable('mcp_request_audit', table => {
      table.string('id', 96).primary();
      table.string('request_id', 128);
      table.string('client_id', 128).nullable();
      table.string('principal_id', 160).nullable();
      table.string('actor_id', 160).nullable();
      table.string('mcp_method', 80);
      table.string('tool_name', 120).nullable();
      table.string('result', 20);
      table.integer('http_status');
      table.bigInteger('duration_ms');
      table.string('created_at', 40);
      table.index('created_at', 'idx_mcp_audit_created');
      table.index('client_id', 'idx_mcp_audit_client');
      table.index('tool_name', 'idx_mcp_audit_tool');
      table.index('result', 'idx_mcp_audit_result');
    });
  },
  async down(schema: SchemaBuilder) {
    await schema.dropTable('mcp_request_audit');
  }
};
export = migration;
