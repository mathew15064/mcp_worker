import {runMigrations} from '../src/db/migrations';
import {seedInitialAdmin} from '../src/db/seed';
import {closeDb} from '../src/db/connection';

console.log('[INIT-DB] Running migrations and seeding...');
runMigrations();
seedInitialAdmin();
closeDb();
console.log('[INIT-DB] Complete.');
