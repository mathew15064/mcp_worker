import workerRepository = require('./workerRepository');
type WorkerProfiles = Pick<typeof workerRepository, 'listProfilesByOwner' | 'listAdminProfiles'>;

class ExecutionProfileRepository {
  workers: WorkerProfiles;
  constructor({ workers = workerRepository }: {workers?: WorkerProfiles} = {}) {
    this.workers = workers;
  }

  async findAll({ ownerUserId = null }: {ownerUserId?: string | null} = {}) {
    let workerProfiles: Awaited<ReturnType<WorkerProfiles["listAdminProfiles"]>> = [];
    try {
      workerProfiles = ownerUserId
        ? await this.workers.listProfilesByOwner(ownerUserId)
        : await this.workers.listAdminProfiles();
    } catch (error) {
      const legacySqliteWithoutWorkerTables = error instanceof Error && 'code' in error && error.code === 'SQLITE_ERROR' && /no such table:\s*worker_profiles/i.test(error.message || '');
      if (!legacySqliteWithoutWorkerTables) throw error;
    }
    return workerProfiles
      .filter(profile => profile !== null)
      .map(profile => ({ ...profile, transport: 'worker' }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async findWithCredentialById() {
    return null;
  }
}

const instance = Object.assign(new ExecutionProfileRepository(), {ExecutionProfileRepository});
export = instance;
