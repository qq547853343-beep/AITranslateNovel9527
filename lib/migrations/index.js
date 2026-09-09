import { initialMigration } from './001_initial.js';
import { migrationIntegrityMigration } from './002_migration_integrity.js';
import { translationJobConcurrencyMigration } from './003_translation_job_concurrency.js';

export const migrations = Object.freeze([
  initialMigration,
  migrationIntegrityMigration,
  translationJobConcurrencyMigration
]);
