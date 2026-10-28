// Banking end to end (BK-1, BK-3 to BK-9) on made-up statements, against the
// real schema.

import { beforeEach, describe, expect, it } from 'vitest';
import { accountId, newLedgerDb, post, startImportRun } from '../../../db/tests/ledgerTestDb';
import { createAccount } from '../../ledger/accounts';
import { trialBalance } from '../../ledger/balances';
import { getEntry } from '../../ledger/entries';
import { postEntry, voidEntry } from '../../ledger/postEntry';
import type { Database } from '../../worker/sqlite';
import {
  cancelReconciliation,
  entryReconciliations,
  finishReconciliation,
  reconcileState,
  reconciliationHistory,
  reconciliationReport,
  setAllCleared,
  setCleared,
  startReconciliation,
  updateReconciliation,
} from './reconcile';
import {
  acceptSuggestions,
  categorize,
  exclude,
  listQueue,
  match,
  payeeKey,
  queueCounts,
  restore,
  transfer,
  undo,
} from './review';
import {
  createRule,
  firstRule,
  listRules,
  moveRule,
  ruleMatches,
  updateRule,
  type RuleInput,
} from './rules';
import {
  importStatements,
  listImports,
  previewStatements,
  readStatements,
  undoImport,
} from './statements';
import { qboFile, type FixtureStatement } from './testing/ofxFixtures';

let db: Database;
let checking: string;
let card: string;

const file = (name: string, ...s: FixtureStatement[]) => ({
  name,
  bytes: new TextEncoder().encode(qboFile(...s)),
});

/** Read files and import every statement into the account given for its kind. */
function importFiles(...files: ReturnType<typeof file>[]) {
  const { pending, problems } = readStatements(files);
  expect(problems).toEqual([]);
  const accounts = Object.fromEntries(
    pending.map((p) => [p.key, p.statement.kind === 'card' ? card : checking]),
  );
  return importStatements(db, pending, accounts);
}

const JAN: FixtureStatement = {
  balance: '2454.90',
  balanceDate: '2026-01-31',
  txns: [
    { fitid: 'J1', date: '2026-01-03', amount: '2500.00', name: 'ACME PAYROLL' },
    { fitid: 'J2', date: '2026-01-05', amount: '-45.10', name: 'CITY POWER' },
  ],
};

/** Debit minus credit, as of the end of the year */
const balance = (id: string) => {
  const r = trialBalance(db, '2026-12-31').rows.find((x) => x.accountId === id);
  return r ? r.debit - r.credit : 0;
};
const rule = (input: Partial<RuleInput>): RuleInput => ({
  name: 'Rule',
  active: true,
  accountId: null,
  direction: 'any',
  textContains: null,
  amountMin: null,
  amountMax: null,
  categoryId: accountId(db, 'Utilities'),
  payee: null,
  memo: null,
  autoPost: false,
  ...input,
});

beforeEach(async () => {
  db = await newLedgerDb();
  checking = accountId(db, 'Checking');
  card = accountId(db, 'Credit Card');
});

describe('statement import (BK-1, BK-6)', () => {
  it('previews a file, remembers the account, and leaves out what was imported before', () => {
    const { pending } = readStatements([file('jan.qbo', JAN)]);
    expect(previewStatements(db, pending)).toMatchObject([
      {
        label: 'Checking ••7890',
        transactions: 2,
        accountId: null,
        balance: 2_454_90,
        endDate: '2026-01-05',
      },
    ]);
    expect(importStatements(db, pending, { [pending[0]!.key]: checking }).statements).toEqual([
      { label: 'Checking ••7890', accountId: checking, added: 2, duplicates: 0, flagged: 0 },
    ]);
    expect(previewStatements(db, pending)[0]!.accountId).toBe(checking);

    // February's download overlaps January's last day
    const feb = importFiles(
      file('feb.qbo', {
        txns: [
          { fitid: 'J2', date: '2026-01-05', amount: '-45.10', name: 'CITY POWER' },
          { fitid: 'F1', date: '2026-02-02', amount: '-12.00', name: 'COFFEE' },
          // The bank reused an id with a different amount: kept, but flagged
          { fitid: 'J1', date: '2026-02-03', amount: '2600.00', name: 'ACME PAYROLL' },
        ],
      }),
    );
    expect(feb.statements[0]).toMatchObject({ added: 2, duplicates: 1, flagged: 1 });
    expect(listQueue(db, checking).map((t) => [t.payee, t.amount, t.possibleDuplicate])).toEqual([
      ['ACME PAYROLL', 2_600_00, true],
      ['COFFEE', -12_00, false],
      ['CITY POWER', -45_10, false],
      ['ACME PAYROLL', 2_500_00, false],
    ]);
    expect(queueCounts(db)).toEqual({ [checking]: 4 });
    expect(listImports(db, checking).map((i) => [i.fileName, i.added, i.duplicates])).toEqual([
      ['feb.qbo', 2, 1],
      ['jan.qbo', 2, 0],
    ]);
  });

  it('keeps two transactions that share a bank id in one file, without flagging them', () => {
    const r = importFiles(
      file('jan.qbo', {
        txns: [
          { fitid: 'SAME', date: '2026-01-14', amount: '-1000.00', name: 'TRANSFER' },
          { fitid: 'SAME', date: '2026-01-14', amount: '1213.17', name: 'DEPOSIT' },
        ],
      }),
    );
    expect(r.statements[0]).toMatchObject({ added: 2, duplicates: 0, flagged: 0 });
    expect(listQueue(db, checking).every((t) => !t.possibleDuplicate)).toBe(true);
  });

  it('reports files that aren’t statements, and statements in another currency', () => {
    const usd = qboFile(JAN);
    const { pending, problems } = readStatements([
      { name: 'notes.txt', bytes: new TextEncoder().encode('hello') },
      {
        name: 'eur.qbo',
        bytes: new TextEncoder().encode(usd.replace('<CURDEF>USD', '<CURDEF>EUR')),
      },
    ]);
    expect(pending).toEqual([]);
    expect(problems.map((p) => p.file)).toEqual(['notes.txt', 'eur.qbo']);
    expect(problems[1]!.message).toContain('in EUR');
  });

  it('undoes an import, keeping what is already in the books', () => {
    importFiles(file('jan.qbo', JAN));
    const [, payroll] = listQueue(db, checking);
    categorize(db, payroll!.id, {
      lines: [{ accountId: accountId(db, 'Services'), amount: 2_500_00 }],
    });
    const [imp] = listImports(db, checking);
    expect(imp!.removable).toBe(1);
    expect(undoImport(db, imp!.id)).toBe(1);
    expect(listQueue(db, checking)).toEqual([]);
    expect(listImports(db, checking)).toHaveLength(1);
    // Importing again brings back only the one that was removed
    expect(importFiles(file('jan.qbo', JAN)).statements[0]).toMatchObject({
      added: 1,
      duplicates: 1,
    });
  });
});

describe('review queue (BK-3, BK-4)', () => {
  it('categorizes a transaction through the one posting path', () => {
    importFiles(file('jan.qbo', JAN));
    const power = listQueue(db, checking).find((t) => t.payee === 'CITY POWER')!;
    const entryId = categorize(db, power.id, {
      lines: [{ accountId: accountId(db, 'Utilities'), amount: 45_10 }],
    });
    const entry = getEntry(db, entryId)!;
    expect(entry).toMatchObject({
      date: '2026-01-05',
      name: 'CITY POWER',
      sourceType: 'bank',
      amount: 45_10,
    });
    expect(entry.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['Checking', 0, 45_10],
      ['Utilities', 45_10, 0],
    ]);
    expect(listQueue(db, checking)).toHaveLength(1);
    expect(listQueue(db, checking, 'reviewed')).toMatchObject([
      { status: 'posted', entryId, entryAccounts: 'Utilities' },
    ]);
  });

  it('splits a transaction over several categories that add up to it', () => {
    importFiles(file('jan.qbo', JAN));
    const pay = listQueue(db, checking).find((t) => t.amount > 0)!;
    const lines = [
      { accountId: accountId(db, 'Services'), amount: 2_000_00 },
      { accountId: accountId(db, 'Sales'), amount: 400_00 },
    ];
    expect(() => categorize(db, pay.id, { lines })).toThrow('The lines must add up');
    expect(() =>
      categorize(db, pay.id, { lines: [{ accountId: checking, amount: 2_500_00 }] }),
    ).toThrow('its own account');
    lines[1]!.amount = 500_00;
    const entry = getEntry(
      db,
      categorize(db, pay.id, { payee: 'Acme Corp', memo: 'January', lines }),
    )!;
    expect(entry).toMatchObject({ name: 'Acme Corp', memo: 'January' });
    expect(entry.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['Checking', 2_500_00, 0],
      ['Services', 0, 2_000_00],
      ['Sales', 0, 500_00],
    ]);
  });

  it('suggests entries already in the books, and matches without posting again (BK-4)', () => {
    const check = post(db, '2026-01-02', 'Rent or Lease', 'Checking', 900_00, { ref: '1042' });
    post(db, '2026-01-09', 'Utilities', 'Checking', 900_00); // same amount, no check number
    importFiles(
      file('jan.qbo', {
        txns: [
          { fitid: 'C1', date: '2026-01-09', amount: '-900.00', type: 'CHECK', checkNo: '1042' },
        ],
      }),
    );
    const [t] = listQueue(db, checking);
    // The check number wins over the closer date
    expect(t!.matches.map((m) => [m.entryId, m.accounts])).toEqual([
      [check, 'Rent or Lease'],
      [check + 1, 'Utilities'],
    ]);
    match(db, t!.id, check);
    expect(balance(checking)).toBe(-1_800_00);
    // A stale suggestion for another transaction can't take the same entry
    importFiles(
      file('jan3.qbo', { txns: [{ fitid: 'C3', date: '2026-01-09', amount: '-900.00' }] }),
    );
    const [other] = listQueue(db, checking);
    expect(() => match(db, other!.id, check)).toThrow('already matched to another transaction');
    expect(() => match(db, t!.id, check)).toThrow('already been reviewed');
    // A matched entry isn't offered for another transaction
    importFiles(
      file('jan2.qbo', { txns: [{ fitid: 'C2', date: '2026-01-09', amount: '-900.00' }] }),
    );
    expect(listQueue(db, checking)[0]!.matches.map((m) => m.entryId)).toEqual([check + 1]);
  });

  it('flags a transaction QuickBooks history already has, instead of entering it twice (BK-6)', () => {
    const run = startImportRun(db);
    postEntry(db, {
      date: '2026-01-05',
      sourceType: 'qbo_migration',
      sourceId: run,
      lines: [
        { accountId: accountId(db, 'Utilities'), debit: 45_10, credit: 0 },
        { accountId: checking, debit: 0, credit: 45_10 },
      ],
    });
    db.exec(`UPDATE qbo_import_run SET status = 'done', finished_at = '2026-01-31T00:00:00Z'`);
    importFiles(file('jan.qbo', JAN));
    const power = listQueue(db, checking).find((t) => t.payee === 'CITY POWER')!;
    expect(power.possibleDuplicate).toBe(true);
    expect(power.matches[0]!.sourceType).toBe('qbo_migration');
  });

  it('excludes, restores and undoes', () => {
    importFiles(file('jan.qbo', JAN));
    const [power, pay] = [...listQueue(db, checking)];
    exclude(db, power!.id);
    expect(listQueue(db, checking, 'excluded').map((t) => t.id)).toEqual([power!.id]);
    restore(db, power!.id);
    const entryId = categorize(db, pay!.id, {
      lines: [{ accountId: accountId(db, 'Services'), amount: 2_500_00 }],
    });
    expect(undo(db, pay!.id)).toBe(entryId);
    expect(getEntry(db, entryId)!.status).toBe('void');
    expect(listQueue(db, checking)).toHaveLength(2);
    expect(balance(checking)).toBe(0);
  });

  it('asks for the closed-period override like any posting (PC-1)', () => {
    importFiles(file('jan.qbo', JAN));
    db.exec(`UPDATE company SET closing_date = '2026-01-31'`);
    const power = listQueue(db, checking).find((t) => t.payee === 'CITY POWER')!;
    const lines = [{ accountId: accountId(db, 'Utilities'), amount: 45_10 }];
    expect(() => categorize(db, power.id, { lines })).toThrow(
      expect.objectContaining({ name: 'ClosedPeriodError' }),
    );
    expect(listQueue(db, checking)).toHaveLength(2);
    categorize(db, power.id, { lines }, { closingOverride: true });
    expect(listQueue(db, checking)).toHaveLength(1);
  });
});

describe('transfers between accounts (BK-9)', () => {
  const PAYMENT: FixtureStatement = {
    kind: 'card',
    txns: [{ fitid: 'P1', date: '2026-01-12', amount: '300.00', name: 'PAYMENT THANK YOU' }],
  };
  const FROM_CHECKING: FixtureStatement = {
    txns: [{ fitid: 'T1', date: '2026-01-10', amount: '-300.00', name: 'CARD AUTOPAY' }],
  };

  it('suggests the other side waiting in another account, and matches both', () => {
    importFiles(file('card.qbo', PAYMENT), file('jan.qbo', FROM_CHECKING));
    const [out] = listQueue(db, checking);
    expect(out!.transfer).toMatchObject({ accountId: card, account: 'Credit Card' });
    const entryId = transfer(db, out!.id, out!.transfer!.txnId);
    expect(listQueue(db, card)).toEqual([]);
    expect(listQueue(db, card, 'reviewed')).toMatchObject([{ status: 'matched', entryId }]);
    expect(balance(card)).toBe(300_00);
    // Undoing either side's entry returns both
    undo(db, out!.id);
    expect(queueCounts(db)).toEqual({ [checking]: 1, [card]: 1 });
  });

  it('matches the other side on import when the transfer was entered first', () => {
    importFiles(file('jan.qbo', FROM_CHECKING));
    const [out] = listQueue(db, checking);
    categorize(db, out!.id, { lines: [{ accountId: card, amount: 300_00 }] });
    expect(importFiles(file('card.qbo', PAYMENT)).autoMatched).toBe(1);
    expect(listQueue(db, card)).toEqual([]);
  });

  it('matches a waiting other side when the transfer is categorized to that account', () => {
    importFiles(file('card.qbo', PAYMENT), file('jan.qbo', FROM_CHECKING));
    const [out] = listQueue(db, checking);
    categorize(db, out!.id, { lines: [{ accountId: card, amount: 300_00 }] });
    expect(listQueue(db, card)).toEqual([]);
  });
});

describe('rules (BK-5)', () => {
  it('matches on text, direction, amount and account', () => {
    const t = { accountId: checking, amount: -45_10, payee: 'CITY POWER', memo: 'Bill 123' };
    expect(ruleMatches(rule({ textContains: 'power' }), t)).toBe(true);
    expect(ruleMatches(rule({ textContains: 'bill 1' }), t)).toBe(true);
    expect(ruleMatches(rule({ textContains: 'water' }), t)).toBe(false);
    expect(ruleMatches(rule({ textContains: 'power', direction: 'in' }), t)).toBe(false);
    expect(ruleMatches(rule({ amountMin: 40_00, amountMax: 50_00 }), t)).toBe(true);
    expect(ruleMatches(rule({ amountMin: 50_00 }), t)).toBe(false);
    expect(ruleMatches(rule({ textContains: 'power', accountId: card }), t)).toBe(false);
  });

  it('suggests from the first active rule by priority, or from last time, and accepts suggestions', () => {
    const utilities = accountId(db, 'Utilities');
    const services = accountId(db, 'Services');
    const broad = createRule(
      db,
      rule({ name: 'Anything big', amountMin: 1_000_00, categoryId: accountId(db, 'Sales') }),
    );
    const payroll = createRule(
      db,
      rule({ name: 'Payroll', textContains: 'payroll', categoryId: services, payee: 'Acme Corp' }),
    );
    importFiles(file('jan.qbo', JAN));
    const pay = () => listQueue(db, checking).find((t) => t.amount > 0)!;
    expect(pay().suggestion).toMatchObject({ source: 'rule', ruleName: 'Anything big' });
    moveRule(db, payroll, 'up');
    expect(listRules(db).map((r) => r.id)).toEqual([payroll, broad]);
    expect(pay().suggestion).toMatchObject({
      source: 'rule',
      ruleId: payroll,
      categoryId: services,
      payee: 'Acme Corp',
    });

    // Last time's category for the same payee
    const power = listQueue(db, checking).find((t) => t.payee === 'CITY POWER')!;
    categorize(db, power.id, {
      payee: 'City Power Co',
      lines: [{ accountId: utilities, amount: 45_10 }],
    });
    importFiles(
      file('feb.qbo', {
        txns: [{ fitid: 'F2', date: '2026-02-05', amount: '-47.00', name: 'City Power' }],
      }),
    );
    const feb = listQueue(db, checking).find((t) => t.date === '2026-02-05')!;
    expect(feb.suggestion).toEqual({
      source: 'history',
      categoryId: utilities,
      payee: 'City Power Co',
    });

    expect(
      acceptSuggestions(
        db,
        listQueue(db, checking).map((t) => t.id),
      ),
    ).toHaveLength(2);
    expect(listQueue(db, checking)).toEqual([]);
    expect(balance(services)).toBe(-2_500_00);
  });

  it('posts on import when the rule says so, unless the period is closed', () => {
    createRule(db, rule({ name: 'Power', textContains: 'POWER', autoPost: true }));
    db.exec(`UPDATE company SET closing_date = '2026-01-04'`);
    expect(importFiles(file('jan.qbo', JAN)).autoPosted).toBe(1);
    db.exec(`UPDATE company SET closing_date = '2026-01-31'`);
    expect(
      importFiles(
        file('feb.qbo', {
          txns: [{ fitid: 'X', date: '2026-01-20', amount: '-9.00', name: 'POWER' }],
        }),
      ).autoPosted,
    ).toBe(0);
    expect(listQueue(db, checking).map((t) => t.payee)).toEqual(['POWER', 'ACME PAYROLL']);
  });

  it('never adds a possible duplicate automatically or in bulk (BK-6)', () => {
    createRule(db, rule({ name: 'Power', textContains: 'POWER', autoPost: true }));
    post(db, '2026-01-04', 'Utilities', 'Checking', 45_10); // already entered by hand
    expect(importFiles(file('jan.qbo', JAN)).autoPosted).toBe(0);
    const power = listQueue(db, checking).find((t) => t.payee === 'CITY POWER')!;
    expect(power.suggestion).toMatchObject({ source: 'rule' });
    expect(acceptSuggestions(db, [power.id])).toEqual([]);
    expect(listQueue(db, checking)).toHaveLength(2);
  });

  it('learns categories from transactions matched to history, despite bank payee variations', () => {
    const run = startImportRun(db);
    postEntry(db, {
      date: '2026-01-02',
      name: 'Acme Franchising',
      sourceType: 'qbo_migration',
      sourceId: run,
      lines: [
        { accountId: accountId(db, 'Rent or Lease'), debit: 700_00, credit: 0 },
        { accountId: checking, debit: 0, credit: 700_00 },
      ],
    });
    db.exec(`UPDATE qbo_import_run SET status = 'done', finished_at = '2026-01-31T00:00:00Z'`);
    importFiles(
      file('jan.qbo', {
        txns: [
          {
            fitid: 'R1',
            date: '2026-01-02',
            amount: '-700.00',
            name: 'ACME FRANCH DES:FEES ID:AC_12 I',
          },
        ],
      }),
    );
    const [jan] = listQueue(db, checking);
    match(db, jan!.id, jan!.matches[0]!.entryId);
    importFiles(
      file('feb.qbo', {
        txns: [
          { fitid: 'R2', date: '2026-02-02', amount: '-725.00', name: 'Acme Franch des:fees' },
        ],
      }),
    );
    expect(listQueue(db, checking)[0]!.suggestion).toEqual({
      source: 'history',
      categoryId: accountId(db, 'Rent or Lease'),
      payee: 'Acme Franchising',
    });
  });

  it('suggests from history only when the payee’s recent uses agree', () => {
    importFiles(
      file('jan.qbo', {
        txns: [
          { fitid: 'K1', date: '2026-01-02', amount: '-100.00', name: 'Check 101', checkNo: '101' },
          { fitid: 'K2', date: '2026-01-03', amount: '-200.00', name: 'Check 102', checkNo: '102' },
          { fitid: 'P1', date: '2026-01-04', amount: '-45.00', name: 'POWER CO' },
          { fitid: 'P2', date: '2026-01-05', amount: '-46.00', name: 'POWER CO' },
        ],
      }),
    );
    const byPayee = (p: string) => listQueue(db, checking).filter((t) => t.payee === p);
    const [k1] = byPayee('Check 101');
    const [k2] = byPayee('Check 102');
    categorize(db, k1!.id, {
      lines: [{ accountId: accountId(db, 'Rent or Lease'), amount: 100_00 }],
    });
    categorize(db, k2!.id, { lines: [{ accountId: accountId(db, 'Meals'), amount: 200_00 }] });
    for (const t of byPayee('POWER CO')) {
      categorize(db, t.id, {
        lines: [{ accountId: accountId(db, 'Utilities'), amount: Math.abs(t.amount) }],
      });
    }
    importFiles(
      file('feb.qbo', {
        txns: [
          { fitid: 'K3', date: '2026-02-02', amount: '-300.00', name: 'Check 103', checkNo: '103' },
          { fitid: 'P3', date: '2026-02-04', amount: '-47.00', name: 'POWER CO' },
        ],
      }),
    );
    // Checks went to different categories: no suggestion. Power always to Utilities.
    expect(byPayee('Check 103')[0]!.suggestion).toBeNull();
    expect(byPayee('POWER CO')[0]!.suggestion).toMatchObject({
      categoryId: accountId(db, 'Utilities'),
    });
  });

  it('never adds suggestions in bulk into a closed period', () => {
    createRule(db, rule({ name: 'Power', textContains: 'POWER' }));
    importFiles(file('jan.qbo', JAN));
    db.exec(`UPDATE company SET closing_date = '2026-01-05'`);
    importFiles(
      file('feb.qbo', {
        txns: [{ fitid: 'P9', date: '2026-02-05', amount: '-50.00', name: 'CITY POWER' }],
      }),
    );
    const ids = listQueue(db, checking).map((t) => t.id);
    // The power bill of Jan 5 is in the closed period: left for the owner
    expect(acceptSuggestions(db, ids)).toHaveLength(1);
    expect(listQueue(db, checking).map((t) => [t.date, t.payee])).toEqual([
      ['2026-01-05', 'CITY POWER'],
      ['2026-01-03', 'ACME PAYROLL'],
    ]);
  });

  it('compares payees the way banks vary them', () => {
    expect(payeeKey('ACME FRANCH DES:FEES ID:AC_12 I')).toBe('ACME FRANCH DES:FEES');
    expect(payeeKey('Acme Franch des:fees')).toBe('ACME FRANCH DES:FEES');
    expect(payeeKey('LOAN 504 SVC DES:TO 01234 ID:5678')).toBe('LOAN SVC DES:TO');
    expect(payeeKey('ONLINE MKTPL*2K4AB1 SEATTLE WA')).toBe('ONLINE SEATTLE WA');
    expect(payeeKey('Online scheduled transfer from checking 1234')).toBe(
      'ONLINE SCHEDULED TRANSFER FROM',
    );
    expect(payeeKey('12345')).toBe('');
    expect(payeeKey(null)).toBe('');
  });

  it('refuses rules that look for nothing or post to their own account', () => {
    expect(() => createRule(db, rule({}))).toThrow('Say what the rule looks for');
    expect(() =>
      createRule(db, rule({ textContains: 'x', accountId: checking, categoryId: checking })),
    ).toThrow('can’t be the account');
    const id = createRule(db, rule({ textContains: 'x' }));
    expect(() =>
      updateRule(db, id, rule({ textContains: 'x', amountMin: 5, amountMax: 1 })),
    ).toThrow('smallest amount');
    expect(
      firstRule(listRules(db), { accountId: checking, amount: -1, payee: 'X', memo: null })?.id,
    ).toBe(id);
  });
});

describe('reconciliation (BK-7, BK-8)', () => {
  it('checks off items until the difference is zero, then keeps the report', () => {
    const deposit = post(db, '2026-01-05', 'Checking', 'Services', 1_000_00);
    const rent = post(db, '2026-01-20', 'Rent or Lease', 'Checking', 400_00);
    const outstanding = post(db, '2026-01-28', 'Utilities', 'Checking', 50_00);
    post(db, '2026-02-02', 'Utilities', 'Checking', 10_00); // after the statement

    const id = startReconciliation(db, checking, '2026-01-31', 600_00);
    let s = reconcileState(db, checking);
    expect(s.items.map((i) => i.entryId)).toEqual([deposit, rent, outstanding]);
    expect(s).toMatchObject({ beginningBalance: 0, clearedTotal: 0, difference: 600_00 });
    const line = (entry: number) => s.items.find((i) => i.entryId === entry)!.lineId;
    setCleared(db, id, [line(deposit), line(rent)], true);
    s = reconcileState(db, checking);
    expect(s).toMatchObject({ clearedCount: 2, clearedTotal: 600_00, difference: 0 });
    finishReconciliation(db, id);

    s = reconcileState(db, checking);
    expect(s).toMatchObject({
      open: null,
      last: { statementDate: '2026-01-31', endingBalance: 600_00 },
    });
    const [summary] = reconciliationHistory(db, checking);
    expect(summary).toMatchObject({
      beginningBalance: 0,
      endingBalance: 600_00,
      clearedCount: 2,
      changedCount: 0,
    });
    const report = reconciliationReport(db, id);
    expect(report.cleared.map((i) => i.entryId)).toEqual([deposit, rent]);
    expect(report.outstanding.map((i) => i.entryId)).toEqual([outstanding]);

    // Voiding a reconciled entry shows up in the report (BK-8)
    expect(entryReconciliations(db, rent)).toEqual([
      { account: 'Checking', statementDate: '2026-01-31' },
    ]);
    voidEntry(db, rent, 'mistake');
    expect(reconciliationHistory(db, checking)[0]!.changedCount).toBe(1);
    expect(reconciliationReport(db, id).cleared.find((i) => i.entryId === rent)!.voided).toBe(true);
  });

  it('won’t finish with a difference, and starts the next statement where this one ended', () => {
    post(db, '2026-01-05', 'Checking', 'Services', 100_00);
    const id = startReconciliation(db, checking, '2026-01-31', 90_00);
    setAllCleared(db, id, true);
    expect(() => finishReconciliation(db, id)).toThrow('The difference must be zero to finish.');
    updateReconciliation(db, id, '2026-01-31', 100_00);
    finishReconciliation(db, id);

    post(db, '2026-02-05', 'Utilities', 'Checking', 30_00);
    const feb = startReconciliation(db, checking, '2026-02-28', 70_00);
    expect(reconcileState(db, checking)).toMatchObject({
      beginningBalance: 100_00,
      itemCount: 1,
      difference: -30_00,
    });
    setAllCleared(db, feb, true);
    expect(reconcileState(db, checking).difference).toBe(0);
    setAllCleared(db, feb, false);
    cancelReconciliation(db, feb);
    expect(reconcileState(db, checking).open).toBeNull();
  });

  it('trusts a balance dated after the statement only when the transactions confirm it', () => {
    // Dated at download, alone: the statement date is offered, the balance isn't
    importFiles(
      file('jan.qbo', {
        ...JAN,
        start: '2026-01-01',
        end: '2026-01-31',
        balanceDate: '2026-03-16',
      }),
    );
    expect(reconcileState(db, checking).suggested).toEqual({
      statementDate: '2026-01-31',
      endingBalance: null,
    });
    // The next statement: January's balance plus February's transactions gives
    // February's, so the file's balances are the statements' ending balances
    importFiles(
      file('feb.qbo', {
        start: '2026-02-01',
        end: '2026-02-28',
        balance: '2444.90',
        balanceDate: '2026-03-16',
        txns: [{ fitid: 'F1', date: '2026-02-03', amount: '-10.00', name: 'FEE' }],
      }),
    );
    expect(reconcileState(db, checking).suggested).toEqual({
      statementDate: '2026-02-28',
      endingBalance: 2_444_90,
    });
  });

  it('doesn’t trust a card file that gives the balance on the download day', () => {
    const cardFile = (name: string, start: string, end: string, txns: FixtureStatement['txns']) =>
      file(name, { kind: 'card', start, end, balance: '-500.00', balanceDate: '2026-03-01', txns });
    importFiles(
      cardFile('dec.qbo', '2025-12-01', '2025-12-31', [
        { fitid: 'C1', date: '2025-12-05', amount: '-40.00', name: 'SHOP' },
      ]),
    );
    importFiles(
      cardFile('jan.qbo', '2026-01-01', '2026-01-31', [
        { fitid: 'C2', date: '2026-01-05', amount: '-60.00', name: 'SHOP' },
      ]),
    );
    expect(reconcileState(db, card).suggested).toEqual({
      statementDate: '2026-01-31',
      endingBalance: null,
    });
  });

  it('reconciles a card together with its card holders’ sub-accounts', () => {
    const holder = (name: string) =>
      createAccount(db, { name, type: 'liability', detailType: 'credit_card', parentId: card });
    holder('Ann 1111');
    holder('Bob 2222');
    post(db, '2026-01-05', 'Meals', 'Ann 1111', 40_00);
    post(db, '2026-01-06', 'Utilities', 'Bob 2222', 60_00);
    post(db, '2026-01-20', 'Credit Card', 'Checking', 70_00); // the payment, on the main account
    expect(reconcileState(db, card).hasSubaccounts).toBe(true);
    const id = startReconciliation(db, card, '2026-01-31', -30_00, true);
    setAllCleared(db, id, true);
    const s = reconcileState(db, card);
    expect(s.items.map((i) => [i.subaccount, i.amount])).toEqual([
      ['Ann 1111', -40_00],
      ['Bob 2222', -60_00],
      [null, 70_00],
    ]);
    expect(s.difference).toBe(0);
    finishReconciliation(db, id);
    const report = reconciliationReport(db, id);
    expect(report.summary.includeSubaccounts).toBe(true);
    expect(report.cleared.map((i) => i.subaccount)).toEqual(['Ann 1111', 'Bob 2222', null]);
  });

  it('suggests the latest imported statement balance, signed for a card', () => {
    importFiles(
      file('card.qbo', { kind: 'card', balance: '-312.55', balanceDate: '2026-01-31', txns: [] }),
    );
    expect(reconcileState(db, card).suggested).toEqual({
      statementDate: '2026-01-31',
      endingBalance: -312_55,
    });
  });
});
