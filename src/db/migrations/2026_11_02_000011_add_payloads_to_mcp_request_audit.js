module.exports = {
  async up(schema) {
    await schema.table('mcp_request_audit', table => {
      table.addLongText('request_payload', { nullable: true });
      table.addLongText('response_payload', { nullable: true });
      table.addBoolean('request_truncated', { nullable: false, defaultValue: false });
      table.addBoolean('response_truncated', { nullable: false, defaultValue: false });
    });
  },
  async down(schema) {
    await schema.table('mcp_request_audit', table => {
      table.dropColumn('response_truncated');
      table.dropColumn('request_truncated');
      table.dropColumn('response_payload');
      table.dropColumn('request_payload');
    });
  }
};
