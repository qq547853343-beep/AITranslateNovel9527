import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../lib/database.js';
import { migrations } from '../lib/migrations/index.js';
import { initialMigration } from '../lib/migrations/001_initial.js';
import { runMigrations } from '../lib/migrations/runner.js';

function temporaryDatabase(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), name));
  return { directory, filename: path.join(directory, 'app.db') };
}

function cleanup(directory) { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }

test('migrations initialize an empty database and remain idempotent', () => {
  const value = temporaryDatabase('translate-migration-empty-');
  let database = openDatabase(value.filename);
  assert.deepEqual(database.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all().map((row) => Number(row.version)), [1, 2, 3]);
  database.prepare('INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)').run('preserved', '{"value":1}', new Date().toISOString());
  database.close();
  database = openDatabase(value.filename);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM schema_migrations').get().count, 3);
  assert.equal(database.prepare("SELECT value_json FROM settings WHERE key='preserved'").get().value_json, '{"value":1}');
  database.close(); cleanup(value.directory);
});

test('migration runner upgrades a legacy version-one database without losing data', () => {
  const value = temporaryDatabase('translate-migration-upgrade-');
  const legacy = new DatabaseSync(value.filename);
  legacy.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL) STRICT;');
  legacy.exec(initialMigration.sql);
  legacy.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)').run(1, new Date().toISOString());
  legacy.prepare('INSERT INTO settings(key,value_json,updated_at) VALUES (?,?,?)').run('legacy', '{"readable":true}', new Date().toISOString());
  legacy.close();
  const database = openDatabase(value.filename);
  assert.equal(database.prepare("SELECT value_json FROM settings WHERE key='legacy'").get().value_json, '{"readable":true}');
  const history = database.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all();
  assert.equal(history.length, 3); assert.ok(history.every((row) => row.name && row.checksum?.length === 64));
  database.close(); cleanup(value.directory);
});

test('migration failure rolls back and modified applied migrations block startup', () => {
  const database = openDatabase(':memory:');
  const failing = [...migrations, { version: migrations.at(-1).version + 1, name: 'intentional-failure', sql: 'CREATE TABLE should_rollback(id INTEGER) STRICT; INSERT INTO missing_table VALUES (1);' }];
  assert.throws(() => runMigrations(database, failing));
  assert.equal(database.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE type='table' AND name='should_rollback'").get().count, 0);
  database.prepare('UPDATE schema_migrations SET checksum=? WHERE version=1').run('tampered');
  assert.throws(() => runMigrations(database, migrations), (error) => error.code === 'MIGRATION_INTEGRITY_FAILED');
  database.close();
});
