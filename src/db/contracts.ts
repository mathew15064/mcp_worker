/** SQL bindings accepted by both adapters. Rows are typed by the query caller. */
export type SqlValue = string | number | bigint | boolean | null | Buffer | Date;
export type SqlRow = Record<string, unknown>;
export interface ExecutionResult {
  changes: number;
  insertId: number | bigint | null;
  warningStatus?: number;
}
export interface DatabaseAdapter {
  readonly kind: 'mysql' | 'sqlite';
  queryOne<T extends object = SqlRow>(sql: string, params?: SqlValue[]): Promise<T | null>;
  queryAll<T extends object = SqlRow>(sql: string, params?: SqlValue[]): Promise<T[]>;
  execute(sql: string, params?: SqlValue[]): Promise<ExecutionResult>;
  exec(sql: string): Promise<unknown>;
  ping(): Promise<boolean>;
  transaction<T>(callback: (tx: DatabaseAdapter) => Promise<T> | T): Promise<T>;
  close(): Promise<void>;
}
