// The migrations that ship with this build of the app. Vite bundles the SQL
// files; Vitest resolves the same glob, so tests run the real schema.

import { dropAuditTriggers, rebuildAuditTriggers } from './audit';
import { latestVersion, migrate, parseMigrations, schemaVersion } from './migrations';
import type { Database } from './sqlite';

const files = import.meta.glob<string>('/db/migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
});

export const MIGRATIONS = parseMigrations(files);

export const LATEST_SCHEMA = latestVersion(MIGRATIONS);

/**
 * Bring a database up to this app's schema (DF-11): pending migrations, then
 * the generated audit triggers (US-5). Triggers are dropped first so a
 * migration can alter or rebuild any table.
 */
export function applySchema(db: Database): { from: number; to: number } {
  if (schemaVersion(db) < LATEST_SCHEMA) dropAuditTriggers(db);
  const result = migrate(db, MIGRATIONS);
  db.exec('BEGIN');
  try {
    rebuildAuditTriggers(db);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return result;
}
