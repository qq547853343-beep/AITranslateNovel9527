import { createHash } from 'node:crypto';

export class MigrationIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationIntegrityError';
    this.code = 'MIGRATION_INTEGRITY_FAILED';
  }
}

export function migrationChecksum(migration) {
  return createHash('sha256').update(String(migration.sql || '')).digest('hex');
}

function migrationColumns(database) {
  return new Set(database.prepare("PRAGMA table_info('schema_migrations')").all().map((column) => column.name));
}

function validateRegistry(registry) {
  let previous = 0;
  const seen = new Set();
  for (const migration of registry) {
    if (!Number.isInteger(migration.version) || migration.version <= previous || seen.has(migration.version)) {
      throw new MigrationIntegrityError('数据库迁移版本必须唯一并严格递增。');
    }
    if (!migration.name || !migration.sql) throw new MigrationIntegrityError(`数据库迁移 ${migration.version} 缺少名称或 SQL。`);
    previous = migration.version;
    seen.add(migration.version);
  }
}

function validateAppliedHistory(database, registry) {
  const columns = migrationColumns(database);
  const rows = database.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
  const registryByVersion = new Map(registry.map((migration) => [migration.version, migration]));
  for (const row of rows) {
    const migration = registryByVersion.get(Number(row.version));
    if (!migration) throw new MigrationIntegrityError(`数据库包含未知迁移版本 ${row.version}。`);
    if (columns.has('name') && row.name && row.name !== migration.name) throw new MigrationIntegrityError(`迁移 ${row.version} 名称与已应用记录不一致。`);
    if (columns.has('checksum') && row.checksum && row.checksum !== migrationChecksum(migration)) throw new MigrationIntegrityError(`迁移 ${row.version} 内容已被修改，拒绝启动。`);
  }
  return rows;
}

function backfillMigrationMetadata(database, registry) {
  const columns = migrationColumns(database);
  if (!columns.has('name') || !columns.has('checksum')) return false;
  const statement = database.prepare('UPDATE schema_migrations SET name=?,checksum=? WHERE version=? AND (name IS NULL OR checksum IS NULL)');
  for (const migration of registry) statement.run(migration.name, migrationChecksum(migration), migration.version);
  return true;
}

export function validateApplicationSchema(database) {
  const required = new Map([
    ['settings', ['key', 'value_json', 'updated_at']],
    ['secret_records', ['scope_id', 'secret_name', 'ciphertext']],
    ['rule_sets', ['id', 'version', 'deleted_at']],
    ['rules', ['id', 'rule_set_id', 'type']],
    ['rule_set_versions', ['rule_set_id', 'version', 'snapshot_json']],
    ['translation_jobs', ['id', 'status', 'segments_json', 'expires_at', 'revision', 'worker_id', 'lease_until']]
  ]);
  for (const [table, expectedColumns] of required) {
    const columns = new Set(database.prepare(`PRAGMA table_info('${table}')`).all().map((column) => column.name));
    for (const column of expectedColumns) if (!columns.has(column)) throw new MigrationIntegrityError(`数据库 schema 不完整：${table}.${column} 不存在。`);
  }
  const foreignKeys = Number(database.prepare('PRAGMA foreign_keys').get().foreign_keys);
  if (foreignKeys !== 1) throw new MigrationIntegrityError('数据库外键约束未启用。');
}

export function runMigrations(database, registry) {
  validateRegistry(registry);
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;');
  const appliedRows = validateAppliedHistory(database, registry);
  const applied = new Set(appliedRows.map((row) => Number(row.version)));
  for (const migration of registry) {
    if (applied.has(migration.version)) continue;
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.exec(migration.sql);
      const hasMetadata = backfillMigrationMetadata(database, registry);
      if (hasMetadata) database.prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES (?,?,?,?)').run(migration.version, migration.name, migrationChecksum(migration), new Date().toISOString());
      else database.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(migration.version, new Date().toISOString());
      database.exec('COMMIT;');
      applied.add(migration.version);
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }
  validateAppliedHistory(database, registry);
  validateApplicationSchema(database);
}
