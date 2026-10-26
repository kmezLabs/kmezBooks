import { beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../src/worker/sqlite';
import { COMPANY_ID, insertCompany, newTestDb } from './testDb';

describe('0001 core: company row (CO-1, CO-3)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newTestDb();
  });

  it('accepts a valid company with defaults', () => {
    insertCompany(db, { ein: '12-3456789' });
    expect(db.selectObjects('SELECT legal_name, fiscal_year_start_month FROM company')).toEqual([
      { legal_name: 'Acme LLC', fiscal_year_start_month: 1 },
    ]);
  });

  it.each([
    ['blank legal name', { legal_name: '   ' }],
    ['EIN without the dash', { ein: '123456789' }],
    ['EIN with letters', { ein: '12-34567AB' }],
    ['fiscal year starting in month 13', { fiscal_year_start_month: 13 }],
    ['fiscal year starting in month 0', { fiscal_year_start_month: 0 }],
  ])('rejects %s', (_label, fields) => {
    expect(() => insertCompany(db, fields)).toThrow(/CHECK constraint failed/);
  });

  it('is STRICT: an INTEGER column refuses text and fractions', () => {
    expect(() => insertCompany(db, { fiscal_year_start_month: 'January' })).toThrow(
      /cannot store TEXT value in INTEGER column/,
    );
    expect(() => insertCompany(db, { fiscal_year_start_month: 1.5 })).toThrow(
      /cannot store REAL value in INTEGER column/,
    );
  });

  it('holds exactly one company per file', () => {
    insertCompany(db);
    expect(() =>
      insertCompany(db, { id: '00000000-0000-4000-8000-000000000002', legal_name: 'Other' }),
    ).toThrow(/exactly one company/);
  });

  it('never changes the company id and never deletes the company', () => {
    insertCompany(db);
    expect(() => db.exec(`UPDATE company SET id = 'x'`)).toThrow(/never changes/);
    expect(() => db.exec('DELETE FROM company')).toThrow(/cannot be deleted/);
    expect(db.selectValue('SELECT id FROM company')).toBe(COMPANY_ID);
  });
});
