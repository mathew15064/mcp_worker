/** Host-only post-Docker-attestation helper. Caller must verify actual container isolation. */
import databaseManager from '../src/db/databaseManager';
import userRepo from '../src/repositories/userRepository';
import workerRepo from '../src/repositories/workerRepository';

async function main() {
  const userId = process.argv[2] || '';
  const workerId = process.argv[3] || '';
  if (!/^usr_[0-9a-f-]{36}$/.test(userId) || !/^[0-9a-f-]{36}$/.test(workerId))
    throw new Error('Expected user and worker UUID.');
  await databaseManager.initialize();
  if (!databaseManager.isSqlReady()) throw new Error('SQLite is not ready.');
  const user = await userRepo.findById(userId);
  const worker = await workerRepo.findWorkerByIdForOwner(workerId, userId);
  const profiles = await workerRepo.listProfilesByOwner(userId);
  if (
    !user ||
    user.status !== 'active' ||
    !worker ||
    !worker.enabled ||
    worker.status !== 'online' ||
    !worker.name.startsWith('Hosted ') ||
    !profiles.some((profile) => profile?.worker_id === workerId && profile.enabled)
  )
    throw new Error('Cannot attest a disabled, unmatched or unprovisioned Worker.');
  const result = await workerRepo.db.execute(
    'UPDATE workers SET hosted_isolated = 1, updated_at = ? WHERE id = ? AND owner_user_id = ? AND enabled = 1',
    [new Date().toISOString(), workerId, userId],
  );
  if (result.changes !== 1) throw new Error('Hosted isolation attestation failed.');
  process.stdout.write('HOSTED_WORKER_ATTESTED\n');
  await databaseManager.close();
}

main().catch((error) => {
  console.error(
    'Hosted worker attestation failed:',
    error instanceof Error ? error.message : 'Unknown error',
  );
  process.exitCode = 1;
});
