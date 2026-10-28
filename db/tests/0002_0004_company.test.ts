import { describe, expect, it } from 'vitest';
import { migrate } from '../../src/worker/migrations';
import { MIGRATIONS } from '../../src/worker/schema';
import { loadSqlite, openEmptyDatabase } from '../../src/worker/sqlite';
import { COMPANY_ID, insertCompany, newCompanyDb, newTestDb } from './testDb';

describe('0002 company address (CO-1)', () => {
  it('accepts a US address', async () => {
    const db = await newTestDb();
    insertCompany(db, {
      address_line1: '1 Main St',
      city: 'Springfield',
      state: 'IL',
      postal_code: '62701-1234',
    });
    expect(db.selectValue('SELECT postal_code FROM company')).toBe('62701-1234');
  });

  it.each([
    ['lower-case state', { state: 'il' }],
    ['state name instead of code', { state: 'Illinois' }],
    ['four-digit ZIP', { postal_code: '6270' }],
    ['ZIP+4 without the dash', { postal_code: '627011234' }],
  ])('rejects %s', async (_label, fields) => {
    const db = await newTestDb();
    expect(() => insertCompany(db, fields)).toThrow(/CHECK constraint failed/);
  });
});

describe('0004 company modules (CO-4)', () => {
  it('turns every module on for a company that existed before the migration; 0016 then switches sales and bills off', async () => {
    const db = openEmptyDatabase(await loadSqlite());
    migrate(db, MIGRATIONS.slice(0, 3));
    insertCompany(db);
    migrate(db, MIGRATIONS);
    expect(
      db
        .selectArrays('SELECT module, enabled FROM company_module ORDER BY module')
        .map((r) => r.join(':')),
    ).toEqual(['banking:1', 'bills:0', 'expenses:1', 'migration:1', 'sales:0']);
  });

  it('rejects unknown modules and non-boolean flags', async () => {
    const db = await newCompanyDb();
    const insert = (module: string, enabled: number) =>
      db.exec({
        sql: 'INSERT INTO company_module (company_id, module, enabled) VALUES (?, ?, ?)',
        bind: [COMPANY_ID, module, enabled],
      });
    expect(() => insert('payroll', 1)).toThrow(/CHECK constraint failed/);
    expect(() => insert('sales', 2)).toThrow(/CHECK constraint failed/);
  });
});
