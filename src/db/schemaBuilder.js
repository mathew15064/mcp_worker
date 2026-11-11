function quoteId(value) {
  const name = String(value || '');
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new Error(`Invalid SQL identifier '${name}'.`);
  return `\`${name}\``;
}

function quoteDefault(value) {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

class ColumnDefinition {
  constructor(name, type) {
    this.name = name;
    this.type = type;
    this.nullableValue = false;
    this.defaultValue = undefined;
    this.primaryValue = false;
    this.uniqueValue = false;
  }
  nullable() { this.nullableValue = true; return this; }
  notNull() { this.nullableValue = false; return this; }
  default(value) { this.defaultValue = value; return this; }
  primary() { this.primaryValue = true; return this; }
  unique() { this.uniqueValue = true; return this; }
  toSql() {
    const parts = [quoteId(this.name), this.type, this.nullableValue ? 'NULL' : 'NOT NULL'];
    if (this.defaultValue !== undefined) parts.push(`DEFAULT ${quoteDefault(this.defaultValue)}`);
    if (this.primaryValue) parts.push('PRIMARY KEY');
    if (this.uniqueValue) parts.push('UNIQUE');
    return parts.join(' ');
  }
}

class TableBlueprint {
  constructor(name) {
    this.name = name;
    this.columns = [];
    this.indexes = [];
    this.foreignKeys = [];
  }
  _column(name, type) { const column = new ColumnDefinition(name, type); this.columns.push(column); return column; }
  uuid(name) { return this._column(name, 'CHAR(36)'); }
  string(name, length = 255) { return this._column(name, `VARCHAR(${Number(length)})`); }
  text(name) { return this._column(name, 'TEXT'); }
  longText(name) { return this._column(name, 'LONGTEXT'); }
  integer(name) { return this._column(name, 'INT'); }
  bigInteger(name) { return this._column(name, 'BIGINT'); }
  boolean(name) { return this._column(name, 'TINYINT(1)'); }
  timestamps() {
    this.string('created_at', 40);
    this.string('updated_at', 40);
    return this;
  }
  index(columns, name = null) {
    const cols = Array.isArray(columns) ? columns : [columns];
    this.indexes.push({ columns: cols, name: name || `idx_${this.name}_${cols.join('_')}`, unique: false });
    return this;
  }
  unique(columns, name = null) {
    const cols = Array.isArray(columns) ? columns : [columns];
    this.indexes.push({ columns: cols, name: name || `uq_${this.name}_${cols.join('_')}`, unique: true });
    return this;
  }
  foreign(column, targetTable, targetColumn = 'id', { onDelete = null } = {}) {
    this.foreignKeys.push({ column, targetTable, targetColumn, onDelete });
    return this;
  }
  toCreateSql() {
    const definitions = this.columns.map(column => column.toSql());
    for (const index of this.indexes) {
      definitions.push(`${index.unique ? 'UNIQUE ' : ''}KEY ${quoteId(index.name)} (${index.columns.map(quoteId).join(', ')})`);
    }
    for (const fk of this.foreignKeys) {
      const suffix = fk.onDelete ? ` ON DELETE ${String(fk.onDelete).toUpperCase()}` : '';
      definitions.push(`FOREIGN KEY (${quoteId(fk.column)}) REFERENCES ${quoteId(fk.targetTable)} (${quoteId(fk.targetColumn)})${suffix}`);
    }
    return `CREATE TABLE IF NOT EXISTS ${quoteId(this.name)} (\n  ${definitions.join(',\n  ')}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
  }
}

class AlterTableBlueprint {
  constructor(name) { this.name = name; this.operations = []; }
  addString(name, length = 255, { nullable = true, defaultValue } = {}) {
    const column = new ColumnDefinition(name, `VARCHAR(${Number(length)})`);
    column.nullableValue = nullable;
    if (defaultValue !== undefined) column.default(defaultValue);
    this.operations.push(`ADD COLUMN ${column.toSql()}`);
    return this;
  }
  addLongText(name, { nullable = true } = {}) {
    const column = new ColumnDefinition(name, 'LONGTEXT');
    column.nullableValue = nullable;
    this.operations.push(`ADD COLUMN ${column.toSql()}`);
    return this;
  }
  addBoolean(name, { nullable = true, defaultValue } = {}) {
    const column = new ColumnDefinition(name, 'TINYINT(1)');
    column.nullableValue = nullable;
    if (defaultValue !== undefined) column.default(defaultValue);
    this.operations.push(`ADD COLUMN ${column.toSql()}`);
    return this;
  }
  dropColumn(name) { this.operations.push(`DROP COLUMN ${quoteId(name)}`); return this; }
}

class SchemaBuilder {
  constructor(adapter) { this.adapter = adapter; }
  async createTable(name, callback) {
    const blueprint = new TableBlueprint(name);
    callback(blueprint);
    await this.adapter.exec(blueprint.toCreateSql());
  }
  async table(name, callback) {
    const blueprint = new AlterTableBlueprint(name);
    callback(blueprint);
    for (const operation of blueprint.operations) await this.adapter.exec(`ALTER TABLE ${quoteId(name)} ${operation}`);
  }
  async dropTable(name) { await this.adapter.exec(`DROP TABLE IF EXISTS ${quoteId(name)}`); }
  async hasTable(name) {
    const row = await this.adapter.queryOne('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?', [name]);
    return Number(row?.count || 0) > 0;
  }
}

module.exports = { SchemaBuilder, TableBlueprint, ColumnDefinition, quoteId };
