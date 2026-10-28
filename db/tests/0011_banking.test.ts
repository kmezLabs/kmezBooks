import { beforeEach, describe, expect, it } from 'vitest';
import { createAccount } from '../../src/ledger/accounts';
import { voidEntry } from '../../src/ledger/postEntry';
import type { Database } from '../../src/worker/sqlite';
import { accountId, newLedgerDb, post } from './ledgerTestDb';

let db: Database;
let checking: string;

function addImport(account = checking, id = 'imp-1') {
  db.exec({
    sql: `INSERT INTO bank_import (id, company_id, account_id, file_name, added, duplicates)
          VALUES (?, (SELECT id FROM company), ?, 'jan.qbo', 0, 0)`,
    bind: [id, account],
  });
  return id;
}

function addTxn(
  amount: number,
  extra: { fitid?: string | null; date?: string; account?: string; importId?: string } = {},
) {
  return Number(
    db.selectValue(
      `INSERT INTO bank_txn (company_id, account_id, import_id, fitid, date, amount, payee)
       VALUES ((SELECT id FROM company), ?, ?, ?, ?, ?, 'PAYEE') RETURNING id`,
      [
        extra.account ?? checking,
        extra.importId ?? 'imp-1',
        extra.fitid === undefined ? `F${amount}` : extra.fitid,
        extra.date ?? '2026-01-10',
        amount,
      ],
    ),
  );
}

const run =
  (sql: string, bind: unknown[] = []) =>
  () =>
    db.exec({ sql, bind: bind as never });
const status = (id: number) =>
  db.selectObjects('SELECT status, entry_id FROM bank_txn WHERE id = ?', [id])[0];

beforeEach(async () => {
  db = await newLedgerDb();
  checking = accountId(db, 'Checking');
  addImport();
});

describe('imported transactions (BK-1, BK-3, BK-6)', () => {
  it('start in the review queue, in their import’s account', () => {
    expect(
      run(
        `INSERT INTO bank_txn (company_id, account_id, import_id, date, amount, status)
           VALUES ((SELECT id FROM company), ?, 'imp-1', '2026-01-01', 100, 'excluded')`,
        [checking],
      ),
    ).toThrow('BK-3: imported transactions start in the review queue');
    expect(() => addTxn(100, { account: accountId(db, 'Savings') })).toThrow(
      'BK-1: the transaction must belong to its import',
    );
  });

  it('keep what the bank sent; the duplicate flag can only be cleared', () => {
    const first = addTxn(-500);
    const id = addTxn(-600, { fitid: 'F-500', date: '2026-01-11' });
    expect(run('UPDATE bank_txn SET amount = 1 WHERE id = ?', [id])).toThrow(
      'BK-1: an imported transaction cannot be changed',
    );
    expect(run('UPDATE bank_txn SET payee = ? WHERE id = ?', ['Other', id])).toThrow('BK-1');
    expect(run('UPDATE bank_txn SET duplicate_of = ? WHERE id = ?', [first, id])).toThrow('BK-1');
    db.exec({ sql: 'UPDATE bank_txn SET status = ? WHERE id = ?', bind: ['excluded', id] });
  });

  it('are never imported twice: same bank id, date and amount in the account (BK-6)', () => {
    addTxn(-500, { fitid: 'X1' });
    expect(() => addTxn(-500, { fitid: 'X1' })).toThrow(/UNIQUE/);
    addTxn(-501, { fitid: 'X1' }); // a different amount is a different transaction
    addTxn(-500, { fitid: null });
    addTxn(-500, { fitid: null }); // without a bank id the importer compares details instead
  });

  it('are never zero', () => {
    expect(() => addTxn(0)).toThrow(/CHECK/);
  });
});

describe('reviewing (BK-3, BK-4, BK-9)', () => {
  it('links only to a posted entry that moves the same amount through the account', () => {
    const id = addTxn(-45_00);
    const right = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    const wrongAmount = post(db, '2026-01-10', 'Utilities', 'Checking', 46_00);
    const wrongAccount = post(db, '2026-01-10', 'Utilities', 'Savings', 45_00);
    const set = (entry: number) =>
      run(`UPDATE bank_txn SET status = 'matched', entry_id = ? WHERE id = ?`, [entry, id]);
    expect(set(wrongAmount)).toThrow(
      'BK-4: the entry must move the same amount through this account',
    );
    expect(set(wrongAccount)).toThrow('BK-4');
    voidEntry(db, right, null);
    expect(set(right)).toThrow('BK-4: a transaction can only be matched to a posted entry');
    expect(run(`UPDATE bank_txn SET status = 'matched' WHERE id = ?`, [id])).toThrow(/CHECK/);
    const ok = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    set(ok)();
    expect(status(id)).toEqual({ status: 'matched', entry_id: ok });
  });

  it('lets one entry account for one transaction per account, so a transfer can match both sides', () => {
    const savings = accountId(db, 'Savings');
    addImport(savings, 'imp-2');
    const out = addTxn(-200_00);
    const out2 = addTxn(-200_00, { fitid: 'other' });
    const into = addTxn(200_00, { account: savings, importId: 'imp-2' });
    const entry = post(db, '2026-01-10', 'Savings', 'Checking', 200_00);
    const link = (id: number) =>
      db.exec({
        sql: `UPDATE bank_txn SET status = 'matched', entry_id = ? WHERE id = ?`,
        bind: [entry, id],
      });
    link(out);
    link(into);
    expect(() => link(out2)).toThrow(/UNIQUE/);
  });

  it('can’t remove a transaction that is in the books', () => {
    const id = addTxn(-45_00);
    const entry = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    db.exec({
      sql: `UPDATE bank_txn SET status = 'matched', entry_id = ? WHERE id = ?`,
      bind: [entry, id],
    });
    expect(run('DELETE FROM bank_txn WHERE id = ?', [id])).toThrow(
      'BK-3: this transaction is in the books',
    );
    db.exec({
      sql: `UPDATE bank_txn SET status = 'new', entry_id = NULL WHERE id = ?`,
      bind: [id],
    });
    db.exec({ sql: 'DELETE FROM bank_txn WHERE id = ?', bind: [id] });
  });

  it('goes back to review when its entry is voided', () => {
    const id = addTxn(-45_00);
    const entry = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    db.exec({
      sql: `UPDATE bank_txn SET status = 'posted', entry_id = ? WHERE id = ?`,
      bind: [entry, id],
    });
    voidEntry(db, entry, 'wrong');
    expect(status(id)).toEqual({ status: 'new', entry_id: null });
  });

  it('writes one compact audit event per review, none for the import itself (US-5)', () => {
    const id = addTxn(-45_00);
    const entry = post(db, '2026-01-10', 'Utilities', 'Checking', 45_00);
    db.exec({
      sql: `UPDATE bank_txn SET status = 'matched', entry_id = ? WHERE id = ?`,
      bind: [entry, id],
    });
    const events = db.selectObjects(
      `SELECT action, before, after FROM audit_event WHERE entity = 'bank_txn'`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('review');
    expect(JSON.parse(String(events[0]!.after))).toMatchObject({
      status: 'matched',
      entry_id: entry,
      amount: -45_00,
    });
    expect(
      db.selectValue(
        `SELECT count(*) FROM sqlite_schema WHERE type = 'trigger' AND tbl_name IN ('bank_txn', 'reconciled_line') AND name LIKE 'audit\\_\\_%' ESCAPE '\\'`,
      ),
    ).toBe(0);
    expect(db.selectValue(`SELECT count(*) FROM audit_event WHERE entity = 'bank_import'`)).toBe(1);
  });
});

describe('statement accounts and rules (BK-1, BK-5)', () => {
  it('imports statements only into asset or liability accounts', () => {
    const insert = (account: string, key: string) =>
      run(
        `INSERT INTO bank_feed (account_id, company_id, feed_key) VALUES (?, (SELECT id FROM company), ?)`,
        [account, key],
      );
    expect(insert(accountId(db, 'Utilities'), 'k1')).toThrow(
      'BK-1: statements can only be imported into an asset or liability account',
    );
    insert(accountId(db, 'Credit Card'), 'k2')();
    insert(checking, 'k3')();
    expect(insert(accountId(db, 'Savings'), 'k3')).toThrow(/UNIQUE/);
  });

  it('needs a rule to look for something, with a sensible amount range and another account', () => {
    const utilities = accountId(db, 'Utilities');
    const rule = (cond: string, values: unknown[]) =>
      run(
        `INSERT INTO bank_rule (id, company_id, name, priority, account_id, text_contains, amount_min, amount_max, category_id)
         VALUES (?, (SELECT id FROM company), 'r', 1, ?, ?, ?, ?, ?)`,
        [cond, ...values],
      );
    expect(rule('a', [null, null, null, null, utilities])).toThrow(/CHECK/);
    expect(rule('b', [null, null, 500, 100, utilities])).toThrow(/CHECK/);
    expect(rule('c', [utilities, 'x', null, null, utilities])).toThrow(/CHECK/);
    rule('d', [checking, 'POWER', null, null, utilities])();
    rule('e', [null, null, 100, 100, utilities])();
  });
});

describe('reconciliation (BK-7, BK-8)', () => {
  const start = (id: string, date: string, ending: number, account = checking) =>
    db.exec({
      sql: `INSERT INTO reconciliation (id, company_id, account_id, statement_date, ending_balance)
            VALUES (?, (SELECT id FROM company), ?, ?, ?)`,
      bind: [id, account, date, ending],
    });
  const clear = (rec: string, entry: number) =>
    db.exec({
      sql: `INSERT INTO reconciled_line (line_id, company_id, reconciliation_id)
            SELECT id, company_id, ? FROM journal_line WHERE entry_id = ? AND account_id = ?`,
      bind: [rec, entry, checking],
    });
  const finish = (rec: string, beginning: number) =>
    run(
      `UPDATE reconciliation SET status = 'done', beginning_balance = ?, finished_at = '2026-02-01T00:00:00Z' WHERE id = ?`,
      [beginning, rec],
    );

  it('finishes only when it starts at the last statement and the difference is zero', () => {
    const deposit = post(db, '2026-01-05', 'Checking', 'Services', 1_000_00);
    const rent = post(db, '2026-01-20', 'Rent or Lease', 'Checking', 400_00);
    post(db, '2026-01-25', 'Utilities', 'Checking', 50_00); // outstanding
    start('jan', '2026-01-31', 600_00);
    clear('jan', deposit);
    expect(finish('jan', 0)).toThrow('BK-7: the difference must be zero to finish');
    clear('jan', rent);
    expect(finish('jan', 100)).toThrow('BK-7: the beginning balance must be the last statement');
    finish('jan', 0)();

    const fee = post(db, '2026-02-03', 'Bank Fees', 'Checking', 5_00);
    start('feb', '2026-02-28', 595_00);
    clear('feb', fee);
    expect(finish('feb', 0)).toThrow('BK-7: the beginning balance');
    finish('feb', 600_00)();
  });

  it('keeps a finished reconciliation as it was', () => {
    const deposit = post(db, '2026-01-05', 'Checking', 'Services', 100_00);
    start('jan', '2026-01-31', 100_00);
    clear('jan', deposit);
    finish('jan', 0)();
    expect(run(`UPDATE reconciliation SET ending_balance = 1 WHERE id = 'jan'`)).toThrow(
      'BK-7: a finished reconciliation cannot be changed',
    );
    expect(run(`DELETE FROM reconciled_line WHERE reconciliation_id = 'jan'`)).toThrow(
      'BK-7: a finished reconciliation cannot be changed',
    );
    expect(run(`DELETE FROM reconciliation WHERE id = 'jan'`)).toThrow(
      'BK-8: a finished reconciliation is kept',
    );
    const later = post(db, '2026-01-06', 'Checking', 'Services', 1_00);
    expect(() => clear('jan', later)).toThrow('BK-7: a finished reconciliation cannot be changed');
  });

  it('reconciles statements in date order, one at a time per account', () => {
    start('jan', '2026-01-31', 0);
    expect(() => start('jan2', '2026-02-28', 0)).toThrow(/UNIQUE/);
    finish('jan', 0)();
    expect(() => start('dec', '2026-01-31', 0)).toThrow(
      'BK-7: statements are reconciled in date order',
    );
    start('feb', '2026-02-28', 0);
    expect(run(`UPDATE reconciliation SET statement_date = '2026-01-15' WHERE id = 'feb'`)).toThrow(
      'BK-7: statements are reconciled in date order',
    );
    expect(() => start('cc', '2026-02-28', 0, accountId(db, 'Credit Card'))).not.toThrow();
    expect(() => start('inc', '2026-02-28', 0, accountId(db, 'Services'))).toThrow(
      'BK-7: only asset and liability accounts are reconciled',
    );
  });

  it('includes sub-accounts only when the reconciliation says so, fixed from the start', () => {
    const card = accountId(db, 'Credit Card');
    const holder = createAccount(db, {
      name: 'Card 1234',
      type: 'liability',
      detailType: 'credit_card',
      parentId: card,
    });
    const charge = post(db, '2026-01-05', 'Meals', 'Card 1234', 30_00);
    const line = db.selectValue(
      'SELECT id FROM journal_line WHERE entry_id = ? AND account_id = ?',
      [charge, holder],
    );
    const insert = (rec: string) =>
      run(
        `INSERT INTO reconciled_line (line_id, company_id, reconciliation_id) VALUES (?, (SELECT id FROM company), ?)`,
        [line, rec],
      );
    start('alone', '2026-01-31', -30_00, card);
    expect(insert('alone')).toThrow('BK-7: that item is in another account');
    db.exec(`DELETE FROM reconciliation WHERE id = 'alone'`);
    db.exec({
      sql: `INSERT INTO reconciliation (id, company_id, account_id, statement_date, ending_balance, include_subaccounts)
            VALUES ('all', (SELECT id FROM company), ?, '2026-01-31', -3000, 1)`,
      bind: [card],
    });
    insert('all')();
    expect(run(`UPDATE reconciliation SET include_subaccounts = 0 WHERE id = 'all'`)).toThrow(
      'BK-7: a reconciliation stays with its account',
    );
    finish('all', 0)();
  });

  it('clears each posted line of the account once, on or before the statement date', () => {
    const deposit = post(db, '2026-01-05', 'Checking', 'Services', 100_00);
    const late = post(db, '2026-02-05', 'Checking', 'Services', 100_00);
    const elsewhere = post(db, '2026-01-05', 'Savings', 'Services', 100_00);
    start('jan', '2026-01-31', 100_00);
    expect(() => clear('jan', late)).toThrow(
      'BK-7: cleared items must be dated on or before the statement date',
    );
    const savingsLine = db.selectValue(
      'SELECT id FROM journal_line WHERE entry_id = ? AND account_id = ?',
      [elsewhere, accountId(db, 'Savings')],
    );
    expect(
      run(
        `INSERT INTO reconciled_line (line_id, company_id, reconciliation_id) VALUES (?, (SELECT id FROM company), 'jan')`,
        [savingsLine],
      ),
    ).toThrow('BK-7: that item is in another account');
    clear('jan', deposit);
    expect(() => clear('jan', deposit)).toThrow(/UNIQUE|PRIMARY/);
    expect(run(`UPDATE reconciliation SET statement_date = '2026-01-04' WHERE id = 'jan'`)).toThrow(
      'BK-7: cleared items must be dated on or before',
    );
    const voided = post(db, '2026-01-06', 'Checking', 'Services', 1_00);
    voidEntry(db, voided, null);
    expect(() => clear('jan', voided)).toThrow('BK-7: only posted entries can be cleared');
    expect(run(`UPDATE reconciled_line SET reconciliation_id = 'jan'`)).toThrow(
      'BK-7: a cleared item cannot be moved',
    );
  });
});
