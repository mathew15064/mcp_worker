const workerRepository = require('./workerRepository');

class ExecutionProfileRepository {
  constructor({ workers = workerRepository } = {}) {
    this.workers = workers;
  }

  async findAll({ ownerUserId = null } = {}) {
    let workerProfiles = [];
    try {
      workerProfiles = ownerUserId
        ? await this.workers.listProfilesByOwner(ownerUserId)
        : await this.workers.listAdminProfiles();
    } catch (error) {
      const legacySqliteWithoutWorkerTables = error?.code === 'SQLITE_ERROR' && /no such table:\s*worker_profiles/i.test(error.message || '');
      if (!legacySqliteWithoutWorkerTables) throw error;
    }
    return workerProfiles
      .map(profile => ({ ...profile, transport: 'worker' }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }

  async findWithCredentialById() {
    return null;
  }
}

module.exports = new ExecutionProfileRepository();
module.exports.ExecutionProfileRepository = ExecutionProfileRepository;
