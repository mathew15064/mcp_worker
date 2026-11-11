'use strict';

import workerRepository = require('../repositories/workerRepository');
import workerBroker = require('./workerConnectionBroker');
import {errorFields} from './workerProtocol';
import terminalAuditRepository = require('../repositories/terminalAuditRepository');
interface WorkerRecord {id: string; name: string; status?: string | null}
interface LifecycleOptions {actorId?: string | null; ownerUserId?: string | null}
type Repository = Pick<typeof workerRepository, 'deleteWorker'>;
type Broker = Pick<typeof workerBroker, 'isOnline' | 'dispatchControl' | 'disconnect'>;
type Audit = Pick<typeof terminalAuditRepository, 'log'>;
type AuditEntry = Parameters<Audit['log']>[0];

function lifecycleError(code: string, message: string, status = 422) { return Object.assign(new Error(message), {code, status}); }

class WorkerLifecycleService {
  repository: Repository; broker: Broker; audit: Audit;
  constructor({ repository = workerRepository, broker = workerBroker, audit = terminalAuditRepository }: {repository?: Repository; broker?: Broker; audit?: Audit} = {}) {
    this.repository = repository;
    this.broker = broker;
    this.audit = audit;
  }

  async safeAudit(entry: AuditEntry) {
    try { await this.audit.log(entry); } catch (_) {}
  }

  async decommission(worker: WorkerRecord | null, { actorId, ownerUserId = null }: LifecycleOptions = {}) {
    if (!worker?.id) throw lifecycleError('WORKER_NOT_FOUND', 'Worker not found.', 404);

    const auditBase = { profileName: worker.name, actorId: actorId || null };
    await this.safeAudit({ ...auditBase, eventType: 'WORKER_REMOTE_REMOVE_REQUESTED', outcome: 'ATTEMPT', detailCode: 'REMOTE_UNINSTALL' });

    try {
      if (!this.broker.isOnline(worker.id)) throw lifecycleError('WORKER_OFFLINE', 'Worker must be online before it can be removed remotely.', 409);
      const result = await this.broker.dispatchControl<{code: string}>(
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
        detailCode: String(errorFields(error).code || 'WORKER_REMOTE_REMOVE_FAILED').slice(0, 100)
      });
      throw error;
    }
  }

  async forceRemove(worker: WorkerRecord | null, { actorId, ownerUserId = null }: LifecycleOptions = {}) {
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
      await this.safeAudit({ ...auditBase, eventType: 'WORKER_FORCE_REMOVE_FAILED', outcome: 'FAILED', detailCode: String(errorFields(error).code || 'WORKER_FORCE_REMOVE_FAILED').slice(0, 100) });
      throw error;
    }
  }
}

const instance = Object.assign(new WorkerLifecycleService(), {WorkerLifecycleService, lifecycleError});
export = instance;
