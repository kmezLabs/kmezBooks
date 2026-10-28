import { describe, expect, it } from 'vitest';
import { blankPayee, createPayee } from '../../src/ledger/payees';
import { voidEntry } from '../../src/ledger/postEntry';
import { createDoc, type DocInput } from '../../src/modules/sales/documents';
import { receivePayment } from '../../src/modules/sales/payments';
import type { Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post } from './ledgerTestDb';

const raise =
  (db: Database, sql: string, bind: (string | number | null)[] = []) =>
  () =>
    db.exec({ sql, bind });

async function setup() {
  const db = await newLedgerDb();
  const customer = createPayee(db, { ...blankPayee('Smith Family'), isCustomer: true });
  const other = createPayee(db, { ...blankPayee('Jones'), isCustomer: true });
  const invoice = (number: string, cents = 100_00, who = customer) =>
    createDoc(db, {
      kind: 'invoice',
      number,
      customerId: who,
      date: '2026-01-05',
      dueDate: null,
      termsDays: 30,
      memo: null,
      lines: [
        {
          itemId: null,
          description: 'Tuition',
          quantity: null,
          rate: null,
          amount: cents,
          incomeAccountId: accountId(db, 'Services'),
        },
      ],
    } satisfies DocInput);
  const pay = (docId: string, amount: number, who = customer) =>
    receivePayment(db, {
      customerId: who,
      date: '2026-01-20',
      depositAccountId: accountId(db, 'Checking'),
      method: null,
      ref: null,
      memo: null,
      applications: [{ docId, amount }],
    });
  return { db, customer, other, invoice, pay };
}

describe('invoices and payments in the schema (AR-4, AR-7)', () => {
  it('never lets payments exceed what an invoice still owes', async () => {
    const { db, invoice, pay } = await setup();
    const inv = invoice('1001');
    pay(inv, 60_00);
    expect(() => pay(inv, 50_00)).toThrow(/can't exceed what is still owed/);
    pay(inv, 40_00);
    expect(Number(db.selectValue(`SELECT paid FROM invoice_paid WHERE doc_id = ?`, [inv]))).toBe(
      100_00,
    );
  });

  it('applies payments only to the customer’s own invoices that aren’t void', async () => {
    const { db, invoice, pay, other } = await setup();
    const inv = invoice('1001');
    expect(() => pay(inv, 10_00, other)).toThrow(/its customer's invoices/);
    db.exec({
      sql: `UPDATE sales_doc SET status = 'void', voided_at = 'now' WHERE id = ?`,
      bind: [inv],
    });
    expect(() => pay(inv, 10_00)).toThrow(/isn't void/);
  });

  it('fixes a paid invoice’s lines and customer; voiding the payment frees them', async () => {
    const { db, invoice, pay, other } = await setup();
    const inv = invoice('1001');
    const { entryId } = pay(inv, 10_00);
    expect(raise(db, `UPDATE sales_doc_line SET amount = 5000 WHERE doc_id = ?`, [inv])).toThrow(
      /void them/,
    );
    expect(raise(db, `DELETE FROM sales_doc_line WHERE doc_id = ?`, [inv])).toThrow(/void them/);
    expect(raise(db, `UPDATE sales_doc SET customer_id = ? WHERE id = ?`, [other, inv])).toThrow(
      /void them first/,
    );
    expect(
      raise(db, `UPDATE sales_doc SET status = 'void', voided_at = 'now' WHERE id = ?`, [inv]),
    ).toThrow(/void them first/);
    expect(raise(db, `DELETE FROM sales_doc WHERE id = ?`, [inv])).toThrow(/void it instead/);
    // Voiding the entry in the journal voids the payment, and the invoice is open again
    voidEntry(db, entryId, null);
    expect(db.selectValue(`SELECT status FROM customer_payment`)).toBe('void');
    expect(
      raise(db, `UPDATE sales_doc_line SET amount = 5000 WHERE doc_id = ?`, [inv]),
    ).not.toThrow();
  });

  it('keeps a posted payment and its applications as they were', async () => {
    const { db, invoice, pay } = await setup();
    const inv = invoice('1001');
    const { paymentId } = pay(inv, 10_00);
    expect(raise(db, `UPDATE customer_payment SET amount = 500 WHERE id = ?`, [paymentId])).toThrow(
      /AR-7/,
    );
    expect(raise(db, `UPDATE payment_application SET amount = 500`)).toThrow(/AR-7/);
    expect(raise(db, `DELETE FROM payment_application`)).toThrow(/AR-7/);
    expect(raise(db, `DELETE FROM customer_payment`)).toThrow(/AR-7/);
    expect(
      raise(db, `UPDATE customer_payment SET status = 'void' WHERE id = ?`, [paymentId]),
    ).toThrow(/only with its entry/);
  });

  it('posts a payment only with its own entry, and never changes that entry in place', async () => {
    const { db, invoice, customer, pay } = await setup();
    const inv = invoice('1001');
    db.exec({
      sql: `INSERT INTO customer_payment (id, company_id, customer_id, date, deposit_account_id, amount)
            VALUES ('p1', (SELECT id FROM company), ?, '2026-01-20', ?, 1000)`,
      bind: [customer, accountId(db, 'Checking')],
    });
    db.exec({
      sql: `INSERT INTO payment_application (payment_id, doc_id, company_id, amount) VALUES ('p1', ?, (SELECT id FROM company), 1000)`,
      bind: [inv],
    });
    const unrelated = post(db, '2026-01-20', 'Checking', 'Services', 10_00);
    expect(
      raise(db, `UPDATE customer_payment SET status = 'posted', entry_id = ? WHERE id = 'p1'`, [
        unrelated,
      ]),
    ).toThrow(/its own posted entry/);
    db.exec('UPDATE company SET posted_edits = 1');
    const { entryId } = pay(invoice('1002'), 10_00);
    expect(raise(db, `UPDATE journal_entry SET status = 'draft' WHERE id = ?`, [entryId])).toThrow(
      /void the payment/,
    );
  });

  it('keeps payees that documents name', async () => {
    const { db, invoice, customer } = await setup();
    invoice('1001');
    expect(raise(db, `DELETE FROM payee WHERE id = ?`, [customer])).toThrow(/GL-11/);
  });

  it('numbers documents uniquely per kind, ignoring case', async () => {
    const { invoice } = await setup();
    invoice('A-1');
    expect(() => invoice('a-1')).toThrow(/already an invoice number/);
  });
});

describe('upgrading an existing company to invoices and bills (CO-4)', () => {
  it('leaves its books alone and starts the sales and bills modules off', async () => {
    const { loadSqlite, openEmptyDatabase } = await import('../../src/worker/sqlite');
    const { migrate } = await import('../../src/worker/migrations');
    const { MIGRATIONS, applySchema } = await import('../../src/worker/schema');
    const { rebuildAuditTriggers, dropAuditTriggers } = await import('../../src/worker/audit');
    const { insertCompany, COMPANY_ID, OWNER_ID } = await import('./testDb');
    const { seedDefaultChart } = await import('../../src/ledger/accounts');
    const db = openEmptyDatabase(await loadSqlite());
    migrate(db, MIGRATIONS.slice(0, 15));
    rebuildAuditTriggers(db);
    // As newCompanyDb does: the session row and the company in one transaction
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
    for (const m of ['sales', 'bills', 'banking']) {
      db.exec({
        sql: `INSERT INTO company_module (company_id, module, enabled) VALUES (?, ?, 1)`,
        bind: [COMPANY_ID, m],
      });
    }
    post(db, '2026-01-05', 'Utilities', 'Checking', 45_10);
    const before = db.selectValue('SELECT count(*) FROM journal_entry');

    dropAuditTriggers(db);
    applySchema(db);
    expect(db.selectObjects('SELECT module, enabled FROM company_module ORDER BY module')).toEqual([
      { module: 'banking', enabled: 1 },
      { module: 'bills', enabled: 0 },
      { module: 'sales', enabled: 0 },
    ]);
    expect(db.selectValue('SELECT count(*) FROM journal_entry')).toBe(before);
  });
});
