export const migrationIntegrityMigration = {
  version: 2,
  name: 'migration-history-integrity',
  sql: `
    ALTER TABLE schema_migrations ADD COLUMN name TEXT;
    ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;
  `
};
