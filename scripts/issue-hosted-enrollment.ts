/** Host-only operator helper. Never expose through HTTP or container user tools. */
import databaseManager from '../src/db/databaseManager';
import workerRepo from '../src/repositories/workerRepository';
import userRepo from '../src/repositories/userRepository';

async function main() {
  const userId = process.argv[2] || '';
  if (!/^usr_[0-9a-f-]{36}$/.test(userId)) throw new Error('Expected a valid user ID.');
  await databaseManager.initialize();
  if (!databaseManager.isSqlReady()) throw new Error('SQLite is not ready.');
  const user = await userRepo.findById(userId);
  if (!user || user.role !== 'user' || user.status !== 'active')
    throw new Error('Hosted enrollment requires an active user account.');
  const issued = await workerRepo.createEnrollmentToken({ ownerUserId: userId, ttlSeconds: 600 });
  // stdout is a secret-only pipe consumed by a trusted host operator script.
  process.stdout.write(issued.token);
  await databaseManager.close();
}

main().catch((error) => {
  console.error(
    'Hosted enrollment failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
});
