'use strict';

const workerRepository = require('../repositories/workerRepository');
const workerBroker = require('./workerConnectionBroker');
const terminalAuditRepository = require('../repositories/terminalAuditRepository');

function lifecycleError(code, message, status = 422) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

class WorkerLifecycleService {
  constructor({ repository = workerRepository, broker = workerBroker, audit = terminalAuditRepository } = {}) {
    this.repository = repository;
    this.broker = broker;
    this.audit = audit;
  }

  async safeAudit(entry) {
    try { await this.audit.log(entry); } catch (_) {}
  }

  async decommission(worker, { actorId, ownerUserId = null } = {}) {
    if (!worker?.id) throw lifecycleError('WORKER_NOT_FOUND', 'Worker not found.', 404);

    const auditBase = { profileName: worker.name, actorId: actorId || null };
    await this.safeAudit({ ...auditBase, eventType: 'WORKER_REMOTE_REMOVE_REQUESTED', outcome: 'ATTEMPT', detailCode: 'REMOTE_UNINSTALL' });

    try {
      if (!this.broker.isOnline(worker.id)) throw lifecycleError('WORKER_OFFLINE', 'Worker must be online before it can be removed remotely.', 409);
      const result = await this.broker.dispatchControl(
        worker.id,
        'worker.self_uninstall',
        { confirm: 'REMOVE_THIS_WORKER' },
        { timeoutMs: 15_000 }
      );
      if (result?.code !== 'UNINSTALLED') {
        throw lifecycleError('WORKER_UNINSTALL_INVALID_ACK', 'Worker did not acknowledge a completed uninstall.');
      }

      const deleted = ownerUserId
        ? await this.repository.deleteWorker(worker.id, { ownerUserId })
        : await this.repository.deleteWorker(worker.id);
      if (!deleted) throw lifecycleError('WORKER_REMOVE_FINALIZE_FAILED', 'Worker uninstalled remotely, but its server record could not be removed. Refresh and remove the stale record again.');

      this.broker.disconnect(worker.id, { code: 4004, reason: 'worker-removed' });
      await this.safeAudit({ ...auditBase, eventType: 'WORKER_REMOTE_REMOVE_COMPLETED', outcome: 'SUCCESS', detailCode: result.code });
      return result;
    } catch (error) {
      await this.safeAudit({
        ...auditBase,
        eventType: 'WORKER_REMOTE_REMOVE_FAILED',
        outcome: 'FAILED',
        detailCode: String(error.code || 'WORKER_REMOTE_REMOVE_FAILED').slice(0, 100)
      });
      throw error;
    }
  }

  async forceRemove(worker, { actorId, ownerUserId = null } = {}) {
    if (!worker?.id) throw lifecycleError('WORKER_NOT_FOUND', 'Worker not found.', 404);
    const auditBase = { profileName: worker.name, actorId: actorId || null };
    await this.safeAudit({ ...auditBase, eventType: 'WORKER_FORCE_REMOVE_REQUESTED', outcome: 'ATTEMPT', detailCode: worker.status || 'unknown' });
    try {
      const deleted = ownerUserId
        ? await this.repository.deleteWorker(worker.id, { ownerUserId })
        : await this.repository.deleteWorker(worker.id);
      if (!deleted) throw lifecycleError('WORKER_NOT_FOUND', 'Worker not found.', 404);
      this.broker.disconnect(worker.id, { code: 4004, reason: 'worker-removed' });
      await this.safeAudit({ ...auditBase, eventType: 'WORKER_FORCE_REMOVE_COMPLETED', outcome: 'SUCCESS', detailCode: 'SERVER_RECORD_DELETED' });
      return { code: 'FORCE_REMOVED' };
    } catch (error) {
      await this.safeAudit({ ...auditBase, eventType: 'WORKER_FORCE_REMOVE_FAILED', outcome: 'FAILED', detailCode: String(error.code || 'WORKER_FORCE_REMOVE_FAILED').slice(0, 100) });
      throw error;
    }
  }
}

module.exports = new WorkerLifecycleService();
module.exports.WorkerLifecycleService = WorkerLifecycleService;
module.exports.lifecycleError = lifecycleError;
