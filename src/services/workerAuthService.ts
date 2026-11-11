import crypto from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import type { WorkerConnectRequest } from './workerProtocol';
import workerRepository from '../repositories/workerRepository';
const { workerError } = workerRepository;

const WORKER_CONNECT_PATH = '/worker/v1/connect';
const MAX_CLOCK_SKEW_MS = 60_000;
const NONCE_RE = /^[A-Za-z0-9_-]{16,120}$/;
const WORKER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_. -]{0,99}$/;

const ALLOWED_CAPABILITIES = Object.freeze([
  'tmux.inspect',
  'tmux.send',
  'tmux.read',
  'tmux.interrupt',
  'shell.inspect',
  'shell.send',
  'shell.read',
  'shell.interrupt',
  'shell.attach',
  'workspace.exec',
  'artifact.collect',
  'file.write',
  'process.start',
  'process.status',
  'process.logs',
  'process.stop',
]);

function canonicalConnectMessage({ workerId, timestamp, nonce }: WorkerConnectRequest) {
  return `${workerId}\n${timestamp}\n${nonce}\n${WORKER_CONNECT_PATH}`;
}

class WorkerAuthService {
  repository: InstanceType<typeof workerRepository.WorkerRepository>;
  now: () => number;
  seenNonces: Map<string, number>;
  constructor({
    repository = workerRepository,
    now = () => Date.now(),
  }: {
    repository?: InstanceType<typeof workerRepository.WorkerRepository>;
    now?: () => number;
  } = {}) {
    this.repository = repository;
    this.now = now;
    this.seenNonces = new Map<string, number>();
  }

  normalizeCapabilities(value: unknown): string[] {
    const requested = Array.isArray(value) ? value : [];
    return [
      ...new Set(
        requested.filter(
          (item): item is string => typeof item === 'string' && ALLOWED_CAPABILITIES.includes(item),
        ),
      ),
    ].sort();
  }

  validatePublicKey(publicKey: unknown) {
    if (typeof publicKey !== 'string' || publicKey.length < 64 || publicKey.length > 4096) {
      throw workerError('WORKER_PUBLIC_KEY_INVALID', 'Worker public key is invalid.');
    }
    try {
      const key = crypto.createPublicKey(publicKey);
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('not ed25519');
      return key.export({ type: 'spki', format: 'pem' }).toString();
    } catch (_) {
      throw workerError(
        'WORKER_PUBLIC_KEY_INVALID',
        'Worker public key must be a valid Ed25519 public key.',
      );
    }
  }

  validateName(name: unknown) {
    const normalized = String(name || '').trim();
    if (!WORKER_NAME_RE.test(normalized)) {
      throw workerError('WORKER_NAME_INVALID', 'Worker name must be 1-100 safe characters.');
    }
    return normalized;
  }

  async enroll({
    token,
    name,
    publicKey,
    capabilities = [],
  }: {
    token: string;
    name: string;
    publicKey: string;
    capabilities?: string[];
  }) {
    const normalizedName = this.validateName(name);
    const normalizedKey = this.validatePublicKey(publicKey);
    const normalizedCapabilities = this.normalizeCapabilities(capabilities);
    const enrollment = await this.repository.consumeEnrollmentToken(token);
    return this.repository.createWorker({
      name: normalizedName,
      publicKey: normalizedKey,
      capabilities: normalizedCapabilities,
      ownerUserId: enrollment?.owner_user_id || null,
    });
  }

  cleanupNonces() {
    const now = this.now();
    for (const [key, expiresAt] of this.seenNonces.entries()) {
      if (expiresAt <= now) this.seenNonces.delete(key);
    }
  }

  async authenticateConnect(headers: IncomingHttpHeaders = {}) {
    const workerId = String(headers['x-br-worker-id'] || '').trim();
    const timestamp = String(headers['x-br-worker-timestamp'] || '').trim();
    const nonce = String(headers['x-br-worker-nonce'] || '').trim();
    const signatureText = String(headers['x-br-worker-signature'] || '').trim();

    if (!workerId || !/^\d{10,16}$/.test(timestamp) || !NONCE_RE.test(nonce) || !signatureText) {
      throw workerError('WORKER_AUTH_INVALID', 'Worker authentication headers are invalid.', 401);
    }
    const timestampMs = Number(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(this.now() - timestampMs) > MAX_CLOCK_SKEW_MS) {
      throw workerError(
        'WORKER_AUTH_EXPIRED',
        'Worker authentication timestamp is outside the allowed clock skew.',
        401,
      );
    }

    this.cleanupNonces();
    const replayKey = `${workerId}:${nonce}`;
    if (this.seenNonces.has(replayKey))
      throw workerError('WORKER_AUTH_REPLAY', 'Worker authentication nonce was already used.', 401);

    const worker = await this.repository.findWorkerById(workerId);
    if (!worker) throw workerError('WORKER_AUTH_INVALID', 'Unknown worker.', 401);
    if (!worker.enabled) throw workerError('WORKER_DISABLED', 'Worker identity is disabled.', 403);

    let signature;
    try {
      signature = Buffer.from(signatureText, 'base64');
    } catch (_) {
      signature = null;
    }
    if (!signature?.length)
      throw workerError('WORKER_AUTH_INVALID', 'Worker signature is invalid.', 401);

    const valid = crypto.verify(
      null,
      Buffer.from(canonicalConnectMessage({ workerId, timestamp, nonce }), 'utf8'),
      worker.public_key,
      signature,
    );
    if (!valid)
      throw workerError('WORKER_AUTH_INVALID', 'Worker signature verification failed.', 401);

    this.seenNonces.set(replayKey, this.now() + MAX_CLOCK_SKEW_MS * 2);
    return worker;
  }
}

const instance = Object.assign(new WorkerAuthService(), {
  WorkerAuthService,
  ALLOWED_CAPABILITIES,
  WORKER_CONNECT_PATH,
  canonicalConnectMessage,
});
export = instance;
