import type { DatabaseAdapter } from './contracts';
type DefaultValue = string | number | boolean | null;
interface ColumnOptions {
  nullable?: boolean;
  defaultValue?: DefaultValue;
}
export function quoteId(value: string) {
  const name = String(value || '');
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Invalid SQL identifier '${name}'.`);
  return `\`${name}\``;
}

function quoteDefault(value: DefaultValue) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

export class ColumnDefinition {
  nullableValue = false;
  defaultValue: DefaultValue | undefined;
  primaryValue = false;
  uniqueValue = false;
  constructor(
    public name: string,
    public type: string,
  ) {}
  nullable() {
    this.nullableValue = true;
    return this;
  }
  notNull() {
    this.nullableValue = false;
    return this;
  }
  default(value: DefaultValue) {
    this.defaultValue = value;
    return this;
  }
  primary() {
    this.primaryValue = true;
    return this;
  }
  unique() {
    this.uniqueValue = true;
    return this;
  }
  toSql() {
    const parts = [quoteId(this.name), this.type, this.nullableValue ? 'NULL' : 'NOT NULL'];
    if (this.defaultValue !== undefined) parts.push(`DEFAULT ${quoteDefault(this.defaultValue)}`);
    if (this.primaryValue) parts.push('PRIMARY KEY');
    if (this.uniqueValue) parts.push('UNIQUE');
    return parts.join(' ');
  }
}

export class TableBlueprint {
  columns: ColumnDefinition[] = [];
  indexes: { columns: string[]; name: string; unique: boolean }[] = [];
  foreignKeys: {
    column: string;
    targetTable: string;
    targetColumn: string;
    onDelete: string | null;
  }[] = [];
  constructor(public name: string) {}
  _column(name: string, type: string) {
    const column = new ColumnDefinition(name, type);
    this.columns.push(column);
    return column;
  }
  uuid(name: string) {
    return this._column(name, 'CHAR(36)');
  }
  string(name: string, length = 255) {
    return this._column(name, `VARCHAR(${Number(length)})`);
  }
  text(name: string) {
    return this._column(name, 'TEXT');
  }
  longText(name: string) {
    return this._column(name, 'LONGTEXT');
  }
  integer(name: string) {
    return this._column(name, 'INT');
  }
  bigInteger(name: string) {
    return this._column(name, 'BIGINT');
  }
  boolean(name: string) {
    return this._column(name, 'TINYINT(1)');
  }
  timestamps() {
    this.string('created_at', 40);
    this.string('updated_at', 40);
    return this;
  }
  index(columns: string | string[], name: string | null = null) {
    const cols = Array.isArray(columns) ? columns : [columns];
    this.indexes.push({
      columns: cols,
      name: name || `idx_${this.name}_${cols.join('_')}`,
      unique: false,
    });
    return this;
  }
  unique(columns: string | string[], name: string | null = null) {
    const cols = Array.isArray(columns) ? columns : [columns];
    this.indexes.push({
      columns: cols,
      name: name || `uq_${this.name}_${cols.join('_')}`,
      unique: true,
    });
    return this;
  }
  foreign(
    column: string,
    targetTable: string,
    targetColumn = 'id',
    { onDelete = null }: { onDelete?: string | null } = {},
  ) {
    this.foreignKeys.push({ column, targetTable, targetColumn, onDelete });
    return this;
  }
  toCreateSql() {
    const definitions = this.columns.map((column) => column.toSql());
    for (const index of this.indexes) {
      definitions.push(
        `${index.unique ? 'UNIQUE ' : ''}KEY ${quoteId(index.name)} (${index.columns.map(quoteId).join(', ')})`,
      );
    }
    for (const fk of this.foreignKeys) {
      const suffix = fk.onDelete ? ` ON DELETE ${String(fk.onDelete).toUpperCase()}` : '';
      definitions.push(
        `FOREIGN KEY (${quoteId(fk.column)}) REFERENCES ${quoteId(fk.targetTable)} (${quoteId(fk.targetColumn)})${suffix}`,
      );
    }
    return `CREATE TABLE IF NOT EXISTS ${quoteId(this.name)} (\n  ${definitions.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
  }
}

export class AlterTableBlueprint {
  operations: string[] = [];
  constructor(public name: string) {}
  addString(name: string, length = 255, { nullable = true, defaultValue }: ColumnOptions = {}) {
    const column = new ColumnDefinition(name, `VARCHAR(${Number(length)})`);
    column.nullableValue = nullable;
    if (defaultValue !== undefined) column.default(defaultValue);
    this.operations.push(`ADD COLUMN ${column.toSql()}`);
    return this;
  }
  addLongText(name: string, { nullable = true }: ColumnOptions = {}) {
    const column = new ColumnDefinition(name, 'LONGTEXT');
    column.nullableValue = nullable;
    this.operations.push(`ADD COLUMN ${column.toSql()}`);
    return this;
  }
  addBoolean(name: string, { nullable = true, defaultValue }: ColumnOptions = {}) {
    const column = new ColumnDefinition(name, 'TINYINT(1)');
    column.nullableValue = nullable;
    if (defaultValue !== undefined) column.default(defaultValue);
    this.operations.push(`ADD COLUMN ${column.toSql()}`);
    return this;
  }
  dropColumn(name: string) {
    this.operations.push(`DROP COLUMN ${quoteId(name)}`);
    return this;
  }
}

export class SchemaBuilder {
  constructor(public adapter: DatabaseAdapter) {}
  async createTable(name: string, callback: (table: TableBlueprint) => void) {
    const blueprint = new TableBlueprint(name);
    callback(blueprint);
    await this.adapter.exec(blueprint.toCreateSql());
  }
  async table(name: string, callback: (table: AlterTableBlueprint) => void) {
    const blueprint = new AlterTableBlueprint(name);
    callback(blueprint);
    for (const operation of blueprint.operations)
      await this.adapter.exec(`ALTER TABLE ${quoteId(name)} ${operation}`);
  }
  async dropTable(name: string) {
    await this.adapter.exec(`DROP TABLE IF EXISTS ${quoteId(name)}`);
  }
  async hasTable(name: string) {
    const row = await this.adapter.queryOne(
      'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?',
      [name],
    );
    return Number(row?.count || 0) > 0;
  }
}
