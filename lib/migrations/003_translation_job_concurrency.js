export const translationJobConcurrencyMigration = {
  version: 3,
  name: 'translation-job-concurrency',
  sql: `
    ALTER TABLE translation_jobs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE translation_jobs ADD COLUMN worker_id TEXT;
    ALTER TABLE translation_jobs ADD COLUMN lease_until TEXT;
    ALTER TABLE translation_jobs ADD COLUMN last_heartbeat_at TEXT;
    ALTER TABLE translation_jobs ADD COLUMN last_error TEXT NOT NULL DEFAULT '';
    ALTER TABLE translation_jobs ADD COLUMN recovery_reason TEXT NOT NULL DEFAULT '';
    CREATE INDEX translation_jobs_lease ON translation_jobs(status, lease_until);
  `
};
