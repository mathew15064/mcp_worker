import Database from 'better-sqlite3';
import type SqliteDatabase from 'better-sqlite3';
import { runMigrations } from './migrations';

type Column = { name: string; type: string; notnull: number; pk: number };
type Index = { name: string; unique: number };
type IndexColumn = { name: string | null; coll: string; desc: number; key: number };
type Foreign = { table: string; from: string; to: string; on_delete: string };

function columns(db: SqliteDatabase.Database, table: string): Column[] {
  return db.prepare(`PRAGMA table_info("${table}")`).all() as Column[];
}
function indexes(db: SqliteDatabase.Database, table: string): Index[] {
  return db.prepare(`PRAGMA index_list("${table}")`).all() as Index[];
}
function indexSignature(db: SqliteDatabase.Database, index: Index): string {
  const fields = (db.prepare(`PRAGMA index_xinfo("${index.name}")`).all() as IndexColumn[])
    .filter((field) => field.key)
    .map((field) => [field.name, field.coll, field.desc]);
  return JSON.stringify([index.unique, fields]);
}
function foreignKeys(db: SqliteDatabase.Database, table: string): string[] {
  return (db.prepare(`PRAGMA foreign_key_list("${table}")`).all() as Foreign[])
    .map((row) => JSON.stringify([row.table, row.from, row.to, row.on_delete]))
    .sort();
}
function fail(table: string, detail: string): never {
  throw Object.assign(new Error(`Incompatible SQLite schema: ${table} (${detail})`), {
    code: 'SQLITE_SCHEMA_INCOMPATIBLE',
  });
}

/**
 * IF NOT EXISTS doesn't verify existing tables. Compare the live schema to a
 * freshly migrated, disposable reference before advertising READY.
 * Only additive extra tables/columns/indexes are tolerated.
 */
export function assertSqliteSchema(db: SqliteDatabase.Database) {
  const reference = new Database(':memory:');
  try {
    reference.pragma('foreign_keys = ON');
    runMigrations(reference);
    if (Number(db.pragma('foreign_keys', { simple: true })) !== 1) {
      fail('database', 'foreign_keys disabled');
    }
    const tables = reference
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    for (const { name } of tables) {
      const actualColumns = new Map(columns(db, name).map((column) => [column.name, column]));
      for (const expected of columns(reference, name)) {
        const actual = actualColumns.get(expected.name);
        if (
          !actual ||
          actual.type.toUpperCase() !== expected.type.toUpperCase() ||
          actual.notnull !== expected.notnull ||
          actual.pk !== expected.pk
        ) {
          fail(name, `column ${expected.name}`);
        }
      }

      const actualIndexes = indexes(db, name);
      const actualByName = new Map(actualIndexes.map((index) => [index.name, index]));
      const actualSignatures = new Set(actualIndexes.map((index) => indexSignature(db, index)));
      for (const expected of indexes(reference, name)) {
        const signature = indexSignature(reference, expected);
        if (!actualSignatures.has(signature)) fail(name, `index ${expected.name}`);
        if (!expected.name.startsWith('sqlite_autoindex_')) {
          const named = actualByName.get(expected.name);
          if (!named || indexSignature(db, named) !== signature) {
            fail(name, `named index ${expected.name}`);
          }
        }
      }
      const expectedForeign = foreignKeys(reference, name);
      const actualForeign = new Set(foreignKeys(db, name));
      if (expectedForeign.some((fk) => !actualForeign.has(fk))) {
        fail(name, 'foreign key');
      }
    }
    if ((db.pragma('foreign_key_check') as unknown[]).length) {
      fail('database', 'orphaned foreign key row');
    }
  } finally {
    reference.close();
  }
}
