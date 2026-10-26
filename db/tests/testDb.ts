// A fresh in-memory database with the shipped schema applied, optionally with
// a company, its owner and a session, the way the app creates one.

import { applySchema } from '../../src/worker/schema';
import { loadSqlite, openEmptyDatabase, type Database } from '../../src/worker/sqlite';

export async function newTestDb(): Promise<Database> {
  const db = openEmptyDatabase(await loadSqlite());
  applySchema(db);
  return db;
}

export const COMPANY_ID = '00000000-0000-4000-8000-000000000001';
export const OWNER_ID = '00000000-0000-4000-8000-0000000000aa';

export function insertCompany(db: Database, fields: Record<string, string | number | null> = {}) {
  const row = { id: COMPANY_ID, legal_name: 'Acme LLC', ...fields };
  const cols = Object.keys(row);
  db.exec({
    sql: `INSERT INTO company (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
    bind: Object.values(row),
  });
}

/** Company + owner + session in one transaction, as OpenCompany.create does. */
export async function newCompanyDb(): Promise<Database> {
  const db = await newTestDb();
  db.exec('BEGIN');
  db.exec({
    sql: `INSERT INTO session (id, company_id, user_id, unlocked_at) VALUES (1, ?, ?, 'now')`,
    bind: [COMPANY_ID, OWNER_ID],
  });
  insertCompany(db);
  db.exec({
    sql: `INSERT INTO app_user (id, company_id, name, role) VALUES (?, ?, 'Owner', 'owner')`,
    bind: [OWNER_ID, COMPANY_ID],
  });
  db.exec('COMMIT');
  return db;
}
