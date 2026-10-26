// A fresh in-memory database with every shipped migration applied.

import { migrate } from '../../src/worker/migrations';
import { MIGRATIONS } from '../../src/worker/schema';
import { loadSqlite, openEmptyDatabase, type Database } from '../../src/worker/sqlite';

export async function newTestDb(): Promise<Database> {
  const db = openEmptyDatabase(await loadSqlite());
  migrate(db, MIGRATIONS);
  return db;
}

export const COMPANY_ID = '00000000-0000-4000-8000-000000000001';

export function insertCompany(db: Database, fields: Record<string, string | number | null> = {}) {
  const row = { id: COMPANY_ID, legal_name: 'Acme LLC', ...fields };
  const cols = Object.keys(row);
  db.exec({
    sql: `INSERT INTO company (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    bind: Object.values(row),
  });
}
