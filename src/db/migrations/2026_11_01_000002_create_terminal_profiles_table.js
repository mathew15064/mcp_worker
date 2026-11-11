module.exports = {
  async up(schema) {
    await schema.createTable('terminal_profiles', table => {
      table.uuid('id').primary();
      table.string('name', 100);
      table.string('description', 500).nullable();
      table.string('host', 255);
      table.integer('port');
      table.string('username', 100);
      table.longText('credential_envelope');
      table.string('host_key_fingerprint', 255).nullable();
      table.string('tmux_session', 80);
      table.boolean('enabled').default(1);
      table.timestamps();
      table.unique('name', 'uq_terminal_profiles_name');
    });
  },
  async down(schema) {
    await schema.dropTable('terminal_profiles');
  }
};
