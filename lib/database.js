import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations } from './migrations/index.js';
import { runMigrations } from './migrations/runner.js';

export function openDatabase(filename) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true });
  const database = new DatabaseSync(filename, { timeout: 5000, allowExtension: false });
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (filename !== ':memory:') database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  try { runMigrations(database, migrations); }
  catch (error) { database.close(); throw error; }
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
