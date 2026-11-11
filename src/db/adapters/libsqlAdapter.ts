import type { Client, InStatement, InValue, ResultSet } from '@libsql/client' with {
  'resolution-mode': 'import',
};
import type { DatabaseAdapter, SqlRow, SqlValue } from '../contracts';

interface SqlExecutor {
  execute(statement: InStatement): Promise<ResultSet>;
  executeMultiple(sql: string): Promise<void>;
}

interface LibsqlAdapterOptions {
  ownsClient?: boolean;
  executor?: SqlExecutor;
}

export interface RemoteLibsqlConfig {
  url: string;
  authToken: string;
}

export function normalizeLibsqlError(error: unknown): unknown {
  if (!error || typeof error !== 'object') return error;
  const candidate = error as { code?: string; extendedCode?: string; status?: number };
  if (
    candidate.extendedCode === 'SQLITE_CONSTRAINT_UNIQUE' ||
    candidate.extendedCode === 'SQLITE_CONSTRAINT_PRIMARYKEY'
  ) {
    candidate.code = 'DB_UNIQUE_CONSTRAINT';
  } else if (candidate.code === 'SQLITE_BUSY' || candidate.extendedCode === 'SQLITE_BUSY') {
    candidate.code = 'LIBSQL_BUSY';
    candidate.status = 503;
  }
  return error;
}

export function validateRemoteLibsqlConfig(input: RemoteLibsqlConfig): RemoteLibsqlConfig {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    throw new Error('A secure remote libSQL URL is required.');
  }
  if (
    !['libsql:', 'https:'].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Remote libSQL requires a TLS URL without embedded credentials or query data.');
  }
  if (!input.authToken?.trim()) {
    throw new Error('Remote libSQL requires an authentication token.');
  }
  return { url: input.url, authToken: input.authToken };
}

function bindValue(value: SqlValue): InValue {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new TypeError('Invalid SQL date parameter.');
    return value.toISOString();
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && !Number.isFinite(value))
    throw new TypeError('Non-finite SQL numeric parameter.');
  return value;
}

function fromValue(value: unknown): unknown {
  return value instanceof ArrayBuffer ? Buffer.from(value) : value;
}

function toRecord<T extends object>(result: ResultSet, row: ResultSet['rows'][number]): T {
  return Object.fromEntries(
    result.columns.map((name, index) => [name, fromValue(row[index])]),
  ) as T;
}

/**
 * Async libSQL adapter for the shared repository contract.
 *
 * This class alone does not enable the Vercel profile. Database migrations,
 * OAuth persistence, session storage and the deployment composition root
 * must be validated separately before profile activation.
 */
export class LibsqlAdapter implements DatabaseAdapter {
  readonly kind = 'libsql' as const;
  private readonly executor: SqlExecutor;
  private readonly ownsClient: boolean;
  private readonly inTransaction: boolean;

  constructor(
    private readonly client: Client,
    { ownsClient = false, executor }: LibsqlAdapterOptions = {},
  ) {
    this.executor = executor || client;
    this.ownsClient = ownsClient;
    this.inTransaction = executor !== undefined;
  }

  static async createRemote(input: RemoteLibsqlConfig): Promise<LibsqlAdapter> {
    const { url, authToken } = validateRemoteLibsqlConfig(input);
    const { createClient } = await import('@libsql/client');
    return new LibsqlAdapter(createClient({ url, authToken }), { ownsClient: true });
  }

  async queryOne<T extends object = SqlRow>(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<T | null> {
    try {
      const result = await this.executor.execute({ sql, args: params.map(bindValue) });
      const first = result.rows[0];
      return first === undefined ? null : toRecord<T>(result, first);
    } catch (error) {
      throw normalizeLibsqlError(error);
    }
  }

  async queryAll<T extends object = SqlRow>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    try {
      const result = await this.executor.execute({ sql, args: params.map(bindValue) });
      return result.rows.map((row) => toRecord<T>(result, row));
    } catch (error) {
      throw normalizeLibsqlError(error);
    }
  }

  async execute(sql: string, params: SqlValue[] = []) {
    try {
      const result = await this.executor.execute({ sql, args: params.map(bindValue) });
      return {
        changes: result.rowsAffected,
        insertId: result.lastInsertRowid ?? null,
      };
    } catch (error) {
      throw normalizeLibsqlError(error);
    }
  }

  async exec(sql: string) {
    try {
      return await this.executor.executeMultiple(sql);
    } catch (error) {
      throw normalizeLibsqlError(error);
    }
  }

  async ping(): Promise<boolean> {
    await this.queryOne('SELECT 1 AS ok');
    return true;
  }

  async transaction<T>(callback: (tx: DatabaseAdapter) => Promise<T> | T): Promise<T> {
    if (this.inTransaction) throw new Error('Nested libSQL transactions are not supported.');
    const tx = await this.client.transaction('write');
    try {
      const result = await callback(new LibsqlAdapter(this.client, { executor: tx }));
      await tx.commit();
      return result;
    } catch (error) {
      if (!tx.closed) {
        try {
          await tx.rollback();
        } catch {
          // Retain the original SQL or application error.
        }
      }
      throw normalizeLibsqlError(error);
    } finally {
      tx.close();
    }
  }

  close(): Promise<void> {
    if (this.ownsClient) this.client.close();
    return Promise.resolve();
  }
}
