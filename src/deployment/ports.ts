import type { Server as HttpServer } from 'node:http';
import type { DatabaseAdapter } from '../db/contracts';
import type { WorkerPayload } from '../services/workerProtocol';

/**
 * Runtime ports for environment-dependent infrastructure. The existing
 * MySQL + WSS implementation is the first adapter. Other adapters must
 * satisfy these contracts and the same security/behavior test suite.
 */
export interface StorageRuntimePort {
  initialize(): Promise<{ state: string }>;
  isOperational(): boolean;
  isMysqlReady(): boolean;
  getAdapter(): DatabaseAdapter | null;
  close(): Promise<void>;
}

export interface SessionRuntimePort {
  close(): void;
}

export interface ExecutionDispatchPort {
  dispatch<T = unknown>(
    workerId: string,
    operation: string,
    payload?: WorkerPayload,
    options?: { timeoutMs?: number | null },
  ): Promise<T>;
}

export interface WorkerTransportPort extends ExecutionDispatchPort {
  attach(server: HttpServer): unknown;
  close(): void;
}
