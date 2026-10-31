// Schema migrations (DF-11): numbered SQL files in db/migrations, one sequence
// across all modules, tracked with PRAGMA user_version.

import { NewerSchemaError } from './errors';
import type { Database } from './sqlite';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

const FILE_NAME = /(?:^|[/\\])(\d{4})_([a-z0-9_]+)\.sql$/;

/** Turn {path: sql} into an ordered list; versions must run 1, 2, 3… with no gaps. */
export function parseMigrations(files: Record<string, string>): Migration[] {
  const migrations = Object.entries(files).map(([path, sql]) => {
    const match = FILE_NAME.exec(path);
    if (!match) throw new Error(`Migration file name must look like 0001_name.sql: ${path}`);
    return { version: Number(match[1]), name: `${match[1]}_${match[2]}`, sql };
  });
  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migrations must be numbered 0001, 0002, … without gaps; found ${m.name}`);
    }
  });
  return migrations;
}

export function schemaVersion(db: Database): number {
  return Number(db.selectValue('PRAGMA user_version'));
}

export function latestVersion(migrations: Migration[]): number {
  return migrations.at(-1)?.version ?? 0;
}

/**
 * Apply pending migrations, each in its own transaction together with its
 * user_version bump, so a failure leaves the database at the last good version.
 */
export function migrate(db: Database, migrations: Migration[]): { from: number; to: number } {
  const from = schemaVersion(db);
  const latest = latestVersion(migrations);
  if (from > latest) {
    throw new NewerSchemaError(
      `This company was saved by a newer version of kmezBooks (schema ${from}; this app knows up to ${latest}). Update the app to open it.`,
    );
  }
  for (const m of migrations.filter((m) => m.version > from)) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`Migration ${m.name} failed: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
  }
  return { from, to: schemaVersion(db) };
}
