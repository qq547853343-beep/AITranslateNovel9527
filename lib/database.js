import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS secret_records (
        scope_id TEXT NOT NULL,
        secret_name TEXT NOT NULL,
        provider TEXT NOT NULL,
        format_version INTEGER NOT NULL,
        ciphertext TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (scope_id, secret_name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS rule_sets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        version INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS rule_sets_active_name ON rule_sets(name) WHERE deleted_at IS NULL;
      CREATE TABLE IF NOT EXISTS rules (
        id TEXT PRIMARY KEY,
        rule_set_id TEXT NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        target TEXT NOT NULL,
        aliases_json TEXT NOT NULL,
        forbidden_json TEXT NOT NULL,
        category TEXT NOT NULL,
        send_mode TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        priority INTEGER NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS rules_rule_set_id ON rules(rule_set_id);
      CREATE TABLE IF NOT EXISTS rule_set_versions (
        id TEXT PRIMARY KEY,
        rule_set_id TEXT NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(rule_set_id, version)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS translation_jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        target_language TEXT NOT NULL,
        model TEXT NOT NULL,
        rule_set_ids_json TEXT NOT NULL,
        validation_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        source_blocks_json TEXT NOT NULL,
        segments_json TEXT NOT NULL,
        result_blocks_json TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        total_segments INTEGER NOT NULL,
        completed_segments INTEGER NOT NULL,
        current_segment INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS translation_jobs_status ON translation_jobs(status);
      CREATE INDEX IF NOT EXISTS translation_jobs_expires_at ON translation_jobs(expires_at);
    `
  }
];

export function openDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename, { timeout: 5000, allowExtension: false });
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  database.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;');
  const applied = new Set(database.prepare('SELECT version FROM schema_migrations').all().map((row) => Number(row.version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.exec(migration.sql);
      database.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }
  return database;
}

export function withTransaction(database, action) {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = action();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}
