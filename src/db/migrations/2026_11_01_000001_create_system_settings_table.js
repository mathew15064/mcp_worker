module.exports = {
  async up(schema) {
    await schema.createTable('system_settings', table => {
      table.string('key', 190).primary();
      table.longText('value');
      table.string('updated_at', 40);
    });
  },
  async down(schema) {
    await schema.dropTable('system_settings');
  }
};
