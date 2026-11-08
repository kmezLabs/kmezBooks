import { describe, expect, it } from 'vitest';
import { readTheme, setTheme } from '../../src/worker/companyData';
import { newCompanyDb } from './testDb';

describe('0022 company theme (CO-11)', () => {
  it('starts with none (follow the computer) and keeps the one chosen', async () => {
    const db = await newCompanyDb();
    expect(db.selectValue('SELECT theme FROM company')).toBeNull();
    expect(readTheme(db)).toBe('system');
    setTheme(db, 'ocean');
    expect(db.selectValue('SELECT theme FROM company')).toBe('ocean');
    expect(readTheme(db)).toBe('ocean');
    setTheme(db, 'system');
    expect(db.selectValue('SELECT theme FROM company')).toBeNull();
  });

  it('refuses an empty or overlong value, and reads an unknown one as follow the computer', async () => {
    const db = await newCompanyDb();
    expect(() => db.exec(`UPDATE company SET theme = ''`)).toThrow(/CHECK constraint failed/);
    expect(() => db.exec(`UPDATE company SET theme = '${'x'.repeat(41)}'`)).toThrow(
      /CHECK constraint failed/,
    );
    // A theme from a newer version of the app
    db.exec(`UPDATE company SET theme = 'aurora'`);
    expect(readTheme(db)).toBe('system');
    expect(() => setTheme(db, 'aurora' as never)).toThrow('Choose one of the themes');
  });

  it('records a change in the audit log (US-5)', async () => {
    const db = await newCompanyDb();
    setTheme(db, 'forest');
    const [entity, before, after] = db.selectArrays(
      `SELECT entity, before, after FROM audit_event WHERE entity = 'company' ORDER BY id DESC LIMIT 1`,
    )[0]!;
    expect(entity).toBe('company');
    expect(JSON.parse(String(before)).theme).toBeNull();
    expect(JSON.parse(String(after)).theme).toBe('forest');
  });
});
