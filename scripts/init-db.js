const { runMigrations } = require('../src/db/migrations');
const { seedInitialAdmin } = require('../src/db/seed');
const { closeDb } = require('../src/db/connection');

console.log('[INIT-DB] Running migrations and seeding...');
runMigrations();
seedInitialAdmin();
closeDb();
console.log('[INIT-DB] Complete.');
