import { beforeEach, describe, expect, it } from 'vitest';
import { isAudited, rebuildAuditTriggers, recordEvent } from '../../src/worker/audit';
import type { Database } from '../../src/worker/sqlite';
import { COMPANY_ID, OWNER_ID, newCompanyDb, newTestDb } from './testDb';

const events = (db: Database) =>
  db.selectObjects(
    `SELECT user_id, action, entity, entity_id, before, after, note FROM audit_event ORDER BY id`,
  );

describe('every table belongs to the company (CO-3)', () => {
  it('has company_id with a foreign key to company', async () => {
    const db = await newTestDb();
    const tables = db
      .selectArrays(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      )
      .map((r) => String(r[0]))
      .filter((t) => t !== 'company');
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      const fk = db.selectValue(
        `SELECT count(*) FROM pragma_foreign_key_list(?) WHERE "table" = 'company' AND "from" = 'company_id'`,
        [table],
      );
      expect(fk, `${table}.company_id → company(id)`).toBe(1);
    }
  });

  it('rejects a row for another company', async () => {
    const db = await newCompanyDb();
    expect(() =>
      db.exec(
        `INSERT INTO app_user (id, company_id, name, role) VALUES ('u2', 'other', 'X', 'bookkeeper')`,
      ),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('users and session (US-3)', () => {
  it('allows exactly one owner', async () => {
    const db = await newCompanyDb();
    expect(() =>
      db.exec({
        sql: `INSERT INTO app_user (id, company_id, name, role) VALUES ('u2', ?, 'Second', 'owner')`,
        bind: [COMPANY_ID],
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('rejects unknown roles and blank names', async () => {
    const db = await newCompanyDb();
    const insert = (name: string, role: string) =>
      db.exec({
        sql: `INSERT INTO app_user (id, company_id, name, role) VALUES ('u2', ?, ?, ?)`,
        bind: [COMPANY_ID, name, role],
      });
    expect(() => insert('Pat', 'admin')).toThrow(/CHECK constraint failed/);
    expect(() => insert(' ', 'bookkeeper')).toThrow(/CHECK constraint failed/);
  });

  it('has at most one session row', async () => {
    const db = await newCompanyDb();
    expect(() =>
      db.exec({
        sql: `INSERT INTO session (id, company_id, user_id, unlocked_at) VALUES (2, ?, ?, 'now')`,
        bind: [COMPANY_ID, OWNER_ID],
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('checks the session keys at commit', async () => {
    const db = await newTestDb();
    db.exec('BEGIN');
    db.exec(
      `INSERT INTO session (id, company_id, user_id, unlocked_at) VALUES (1, 'nope', 'nobody', 'now')`,
    );
    expect(() => db.exec('COMMIT')).toThrow(/FOREIGN KEY constraint failed/);
    db.exec('ROLLBACK');
  });
});

describe('audit log (US-5)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newCompanyDb();
  });

  it('records the company and owner created at setup, stamped with the owner', () => {
    expect(events(db)).toEqual([
      expect.objectContaining({
        user_id: OWNER_ID,
        action: 'insert',
        entity: 'company',
        entity_id: COMPANY_ID,
      }),
      expect.objectContaining({
        user_id: OWNER_ID,
        action: 'insert',
        entity: 'app_user',
        entity_id: OWNER_ID,
      }),
    ]);
  });

  it('records updates with before and after, and skips updates that change nothing', () => {
    db.exec(`UPDATE company SET legal_name = 'Acme Holdings LLC'`);
    db.exec(`UPDATE company SET legal_name = 'Acme Holdings LLC'`);
    const updates = events(db).filter((e) => e.action === 'update');
    expect(updates).toHaveLength(1);
    expect(JSON.parse(String(updates[0]!.before)).legal_name).toBe('Acme LLC');
    expect(JSON.parse(String(updates[0]!.after)).legal_name).toBe('Acme Holdings LLC');
  });

  it('records deletes with the row as it was', () => {
    db.exec({
      sql: `UPDATE company_module SET enabled = 0 WHERE module = 'banking'`,
    });
    db.exec({
      sql: `INSERT INTO app_user (id, company_id, name, role) VALUES ('u2', ?, 'Pat', 'bookkeeper')`,
      bind: [COMPANY_ID],
    });
    db.exec(`DELETE FROM app_user WHERE id = 'u2'`);
    const del = events(db).find((e) => e.action === 'delete')!;
    expect(del).toMatchObject({ entity: 'app_user', entity_id: 'u2', after: null });
    expect(JSON.parse(String(del.before))).toMatchObject({ name: 'Pat', role: 'bookkeeper' });
  });

  it('uses composite keys as the entity id', () => {
    db.exec({
      sql: `INSERT INTO company_module (company_id, module, enabled) VALUES (?, 'sales', 1)`,
      bind: [COMPANY_ID],
    });
    expect(events(db).at(-1)).toMatchObject({
      entity: 'company_module',
      entity_id: `${COMPANY_ID}|sales`,
    });
  });

  it('records app events such as unlock', () => {
    recordEvent(db, 'unlock', 'this computer');
    expect(events(db).at(-1)).toMatchObject({
      action: 'unlock',
      user_id: OWNER_ID,
      note: 'this computer',
      entity: null,
    });
  });

  it('is append-only', () => {
    expect(() => db.exec(`UPDATE audit_event SET note = 'x'`)).toThrow(/cannot be changed/);
    expect(() => db.exec(`DELETE FROM audit_event`)).toThrow(/cannot be changed/);
  });

  it('does not audit itself or the session row', () => {
    const before = events(db).length;
    db.exec(`UPDATE session SET unlocked_at = 'later'`);
    expect(events(db)).toHaveLength(before);
    expect(isAudited('audit_event')).toBe(false);
    expect(isAudited('session')).toBe(false);
  });

  it('covers every audited table with three triggers', () => {
    const tables = db
      .selectArrays(`SELECT name FROM sqlite_schema WHERE type = 'table'`)
      .map((r) => String(r[0]))
      .filter(isAudited);
    for (const t of tables) {
      for (const op of ['insert', 'update', 'delete']) {
        expect(
          db.selectValue(`SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND name = ?`, [
            `audit__${t}_${op}`,
          ]),
          `audit__${t}_${op}`,
        ).toBe(1);
      }
    }
  });

  it('is stable: rebuilding an up-to-date schema changes nothing', () => {
    expect(rebuildAuditTriggers(db)).toBe(0);
  });

  it('picks up a new column the next time the triggers are rebuilt', () => {
    db.exec(`ALTER TABLE app_user ADD COLUMN email TEXT`);
    // All three triggers serialize every column: three dropped, three recreated
    expect(rebuildAuditTriggers(db)).toBe(6);
    db.exec(`UPDATE app_user SET email = 'owner@example.com'`);
    expect(JSON.parse(String(events(db).at(-1)!.after)).email).toBe('owner@example.com');
  });
});
