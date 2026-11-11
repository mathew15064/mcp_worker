import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { SqliteAdapter } from '../src/db/adapters/sqliteAdapter';
import { runMigrations } from '../src/db/migrations';
import workerRepository from '../src/repositories/workerRepository';
import workerAuthService from '../src/services/workerAuthService';
import { decodeWorkerMessage, type WorkerJobEnvelope } from '../src/services/workerProtocol';

void test('typed Worker protocol validates envelopes without changing job wire fields', () => {
  const outbound: WorkerJobEnvelope = {
    type: 'job',
    job_id: 'job_012',
    operation: 'workspace.exec',
    payload: { command: 'pwd', timeout_ms: 30000 },
    timeout_ms: 30000,
  };
  assert.deepEqual(decodeWorkerMessage(JSON.stringify(outbound)), outbound);
  assert.equal(decodeWorkerMessage('{broken'), null);
  assert.equal(decodeWorkerMessage('null'), null);
  assert.equal(decodeWorkerMessage('[]'), null);
});

void test('typed Ed25519 Worker enrollment and connect reject replay', async () => {
  const raw = new Database(':memory:');
  try {
    runMigrations(raw);
    const repo = new workerRepository.WorkerRepository(new SqliteAdapter(raw));
    const auth = new workerAuthService.WorkerAuthService({ repository: repo });
    const keypair = crypto.generateKeyPairSync('ed25519');
    const enrollment = await repo.createEnrollmentToken();
    const worker = await auth.enroll({
      token: enrollment.token,
      name: 'typed-wire-test',
      publicKey: keypair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      capabilities: ['workspace.exec', 'not-a-real-capability'],
    });
    assert.ok(worker);
    assert.deepEqual(worker.capabilities, ['workspace.exec']);
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(32).toString('base64url');
    const signature = crypto
      .sign(
        null,
        Buffer.from(
          workerAuthService.canonicalConnectMessage({
            workerId: worker.id,
            timestamp,
            nonce,
          }),
        ),
        keypair.privateKey,
      )
      .toString('base64');
    const headers = {
      'x-br-worker-id': worker.id,
      'x-br-worker-timestamp': timestamp,
      'x-br-worker-nonce': nonce,
      'x-br-worker-signature': signature,
    };
    assert.equal((await auth.authenticateConnect(headers)).id, worker.id);
    await assert.rejects(auth.authenticateConnect(headers), { code: 'WORKER_AUTH_REPLAY' });
  } finally {
    raw.close();
  }
});
