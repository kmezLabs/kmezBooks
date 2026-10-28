import { describe, expect, it } from 'vitest';
import { seedDefaultChart } from '../../src/ledger/accounts';
import { voidEntry } from '../../src/ledger/postEntry';
import { dropAuditTriggers, rebuildAuditTriggers } from '../../src/worker/audit';
import { migrate } from '../../src/worker/migrations';
import { MIGRATIONS, applySchema } from '../../src/worker/schema';
import { loadSqlite, openEmptyDatabase, type Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post } from './ledgerTestDb';
import { COMPANY_ID, OWNER_ID, insertCompany } from './testDb';

const raise =
  (db: Database, sql: string, bind: (string | number | null)[] = []) =>
  () =>
    db.exec({ sql, bind });

const payeeOf = (db: Database, entryId: number) =>
  db.selectObjects(
    `SELECT e.name, p.name AS payee FROM journal_entry e LEFT JOIN payee p ON p.id = e.payee_id WHERE e.id = ?`,
    [entryId],
  )[0];

/** A company as schema 13 left it: customers, vendors, and names as text on entries. */
async function companyAt13(): Promise<Database> {
  const db = openEmptyDatabase(await loadSqlite());
  migrate(db, MIGRATIONS.slice(0, 13));
  rebuildAuditTriggers(db);
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
  seedDefaultChart(db);
  const add = (table: string, id: string, name: string, extra: Record<string, string> = {}) =>
    db.exec({
      sql: `INSERT INTO ${table} (id, company_id, name${Object.keys(extra)
        .map((k) => `, ${k}`)
        .join('')})
            VALUES (?, ?, ?${Object.keys(extra)
              .map(() => ', ?')
              .join('')})`,
      bind: [id, COMPANY_ID, name, ...Object.values(extra)],
    });
  add('customer', 'c1', 'Tenant Co', { email: 'rent@tenant.example' });
  add('customer', 'c2', 'Acme', { phone: '555-0100' });
  add('vendor', 'v1', 'ACME', { account_number: 'A-7', phone: '555-0199' });
  add('vendor', 'v2', 'Lender Bank');
  return db;
}

/** A posted entry written the way schema 13 wrote it, with names as text. */
function entryAt13(db: Database, name: string | null, lineName: string | null = null): number {
  const id = Number(
    db.selectValue(
      `INSERT INTO journal_entry (company_id, date, name, source_type) VALUES (?, '2026-01-05', ?, 'journal') RETURNING id`,
      [COMPANY_ID, name],
    ),
  );
  const line = (no: number, account: string, debit: number, credit: number, n: string | null) =>
    db.exec({
      sql: `INSERT INTO journal_line (company_id, entry_id, line_no, account_id, debit, credit, name)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      bind: [COMPANY_ID, id, no, accountId(db, account), debit, credit, n],
    });
  line(1, 'Utilities', 10_00, 0, lineName);
  line(2, 'Checking', 0, 10_00, null);
  db.exec({
    sql: `UPDATE journal_entry SET status = 'posted', posted_at = 'now' WHERE id = ?`,
    bind: [id],
  });
  return id;
}

describe('upgrading to one payee list (GL-11, migration 0014)', () => {
  it('moves customers and vendors in, one payee per name, and links every name on the books', async () => {
    const db = await companyAt13();
    const acme = entryAt13(db, 'acme');
    const diner = entryAt13(db, '  City Diner ', 'Jo Smith');
    const none = entryAt13(db, null);
    const audit = Number(db.selectValue('SELECT count(*) FROM audit_event'));

    dropAuditTriggers(db);
    applySchema(db);

    const payees = db.selectObjects(
      `SELECT id, name, is_customer, is_vendor, email, phone, account_number FROM payee ORDER BY name`,
    );
    expect(payees).toEqual([
      // A vendor named like a customer is the same payee, with both flags; the customer's phone stays
      {
        id: 'c2',
        name: 'Acme',
        is_customer: 1,
        is_vendor: 1,
        email: null,
        phone: '555-0100',
        account_number: 'A-7',
      },
      {
        id: expect.any(String),
        name: 'City Diner',
        is_customer: 0,
        is_vendor: 0,
        email: null,
        phone: null,
        account_number: null,
      },
      {
        id: expect.any(String),
        name: 'Jo Smith',
        is_customer: 0,
        is_vendor: 0,
        email: null,
        phone: null,
        account_number: null,
      },
      {
        id: 'v2',
        name: 'Lender Bank',
        is_customer: 0,
        is_vendor: 1,
        email: null,
        phone: null,
        account_number: null,
      },
      {
        id: 'c1',
        name: 'Tenant Co',
        is_customer: 1,
        is_vendor: 0,
        email: 'rent@tenant.example',
        phone: null,
        account_number: null,
      },
    ]);
    // Linked ignoring case and spaces; the text stays as it was (MG-3)
    expect(payeeOf(db, acme)).toEqual({ name: 'acme', payee: 'Acme' });
    expect(payeeOf(db, diner)).toEqual({ name: '  City Diner ', payee: 'City Diner' });
    expect(payeeOf(db, none)).toEqual({ name: null, payee: null });
    expect(
      db.selectValue(
        `SELECT p.name FROM journal_line l JOIN payee p ON p.id = l.payee_id WHERE l.entry_id = ?`,
        [diner],
      ),
    ).toBe('Jo Smith');
    // The upgrade itself writes no audit events for the links
    expect(Number(db.selectValue(`SELECT count(*) FROM audit_event WHERE action = 'payee'`))).toBe(
      0,
    );
    expect(Number(db.selectValue('SELECT count(*) FROM audit_event'))).toBe(audit);
  });
});

describe('payees on posted entries (GL-11)', () => {
  const setup = async () => {
    const db = await newLedgerDb();
    const add = (id: string, name: string) =>
      db.exec({
        sql: `INSERT INTO payee (id, company_id, name) VALUES (?, (SELECT id FROM company), ?)`,
        bind: [id, name],
      });
    return { db, add };
  };

  it('keeps names unique ignoring case, and not blank', async () => {
    const { add } = await setup();
    expect(() => add('p1', 'Acme')).not.toThrow();
    expect(() => add('p2', 'ACME')).toThrow(/UNIQUE/);
    expect(() => add('p3', ' ')).toThrow(/CHECK/);
  });

  it('changes a posted entry’s name only together with its payee, and audits it', async () => {
    const { db, add } = await setup();
    const id = post(db, '2026-01-05', 'Meals', 'Checking', 10_00, { name: 'Diner' });
    const diner = String(db.selectValue('SELECT payee_id FROM journal_entry WHERE id = ?', [id]));
    add('p2', 'Cafe');
    expect(raise(db, `UPDATE journal_entry SET name = 'Cafe' WHERE id = ?`, [id])).toThrow(/GL-11/);
    expect(raise(db, `UPDATE journal_entry SET payee_id = 'p2' WHERE id = ?`, [id])).toThrow(
      /GL-11/,
    );
    expect(
      raise(db, `UPDATE journal_entry SET payee_id = NULL, name = NULL WHERE id = ?`, [id]),
    ).toThrow(/GL-11/);
    db.exec({
      sql: `UPDATE journal_entry SET payee_id = 'p2', name = 'Cafe' WHERE id = ?`,
      bind: [id],
    });
    // Other fields stay fixed (GL-6)
    expect(raise(db, `UPDATE journal_entry SET memo = 'x' WHERE id = ?`, [id])).toThrow(/GL-6/);
    expect(
      db.selectObjects(
        `SELECT before, after FROM audit_event WHERE action = 'payee' AND entity_id = ?`,
        [String(id)],
      ),
    ).toEqual([
      {
        before: JSON.stringify({ name: 'Diner', payee_id: diner }),
        after: JSON.stringify({ name: 'Cafe', payee_id: 'p2' }),
      },
    ]);
    // A void entry too: renaming a payee renames it everywhere
    voidEntry(db, id, null);
    db.exec({ sql: `UPDATE payee SET name = 'Corner Cafe' WHERE id = 'p2'` });
    db.exec({ sql: `UPDATE journal_entry SET name = 'Corner Cafe' WHERE id = ?`, bind: [id] });
  });

  it('changes a posted line’s name only together with its payee', async () => {
    const { db, add } = await setup();
    const id = post(db, '2026-01-05', 'Meals', 'Checking', 10_00);
    const line = Number(
      db.selectValue('SELECT id FROM journal_line WHERE entry_id = ? AND line_no = 1', [id]),
    );
    add('p1', 'Jo');
    expect(raise(db, `UPDATE journal_line SET name = 'Jo' WHERE id = ?`, [line])).toThrow(/GL-6/);
    db.exec({
      sql: `UPDATE journal_line SET name = 'Jo', payee_id = 'p1' WHERE id = ?`,
      bind: [line],
    });
    expect(raise(db, `UPDATE journal_line SET debit = 11_00 WHERE id = ?`, [line])).toThrow(/GL-6/);
    expect(
      Number(
        db.selectValue(
          `SELECT count(*) FROM audit_event WHERE action = 'payee' AND entity = 'journal_line'`,
        ),
      ),
    ).toBe(1);
  });

  it('deletes only a payee no transaction names', async () => {
    const { db, add } = await setup();
    post(db, '2026-01-05', 'Meals', 'Checking', 10_00, { name: 'Diner' });
    add('p2', 'Unused');
    expect(raise(db, `DELETE FROM payee WHERE name = 'Diner'`)).toThrow(/GL-11/);
    expect(raise(db, `DELETE FROM payee WHERE id = 'p2'`)).not.toThrow();
  });
});
