// The QuickBooks import end to end (MG-1 to MG-6), on anonymized exports in
// QuickBooks's own layout (testing/qboFixtures.ts), against the real schema.

import { beforeEach, describe, expect, it } from 'vitest';
import { newLedgerDb } from '../../../db/tests/ledgerTestDb';
import { newCompanyDb } from '../../../db/tests/testDb';
import { listAccounts } from '../../ledger/accounts';
import { trialBalance } from '../../ledger/balances';
import { getEntry, listEntries } from '../../ledger/entries';
import { postEntry } from '../../ledger/postEntry';
import type { Database } from '../../worker/sqlite';
import { analyze } from './analysis';
import { checkChoices, proposeChoices, runImport, type AccountChoices } from './importer';
import {
  exportFiles,
  type FxAccount,
  type FxCompany,
  type FxOptions,
  type FxTxn,
} from './testing/qboFixtures';

const ACCOUNTS: FxAccount[] = [
  { name: 'Checking', type: 'Bank', detail: 'Checking' },
  { name: 'Building', type: 'Fixed Assets', detail: 'Other fixed assets' },
  { name: 'Accumulated Depreciation', type: 'Fixed Assets', detail: 'Accumulated Depreciation' },
  { name: 'Mortgage Payable', type: 'Long Term Liabilities', detail: 'Notes Payable' },
  { name: 'Capital Stock', type: 'Equity', detail: "Owner's Equity" },
  { name: 'Opening Balance Equity', type: 'Equity', detail: 'Opening Balance Equity' },
  { name: 'Retained Earnings', type: 'Equity', detail: 'Retained Earnings' },
  { name: 'Rental Income', type: 'Income', detail: 'Service/Fee Income' },
  { name: 'Depreciation Expense', type: 'Expenses', detail: 'Other Miscellaneous Service Cost' },
  { name: 'Interest Expense', type: 'Expenses', detail: 'Interest Paid' },
  { name: 'Interest Expense:Mortgage Interest', type: 'Expenses', detail: 'Interest Paid' },
  { name: 'Bank Charges', type: 'Expenses', detail: 'Bank Charges' },
  { name: 'Uncategorized Expense', type: 'Expenses', detail: 'Other Miscellaneous Service Cost' },
];

/** One year of a small rental company's activity. */
function year(y: number): FxTxn[] {
  const d = (m: number, day: number) =>
    `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const txns: FxTxn[] = [];
  for (let m = 1; m <= 12; m++) {
    txns.push(
      {
        date: d(m, 1),
        type: 'Deposit',
        name: 'Tenant Co',
        lines: [
          { account: 'Checking', debit: 1_250_000, memo: `Rent ${m}` },
          { account: 'Rental Income', credit: 1_250_000, memo: `Rent ${m}` },
        ],
      },
      {
        date: d(m, 12),
        type: 'Check',
        num: 1000 + m,
        name: 'Lender Bank',
        lines: [
          { account: 'Checking', credit: 1_000_000 },
          { account: 'Interest Expense:Mortgage Interest', debit: 425_020 },
          { account: 'Mortgage Payable', debit: 574_980 },
        ],
      },
      {
        date: d(m, 28),
        type: 'Journal Entry',
        num: m,
        lines: [
          { account: 'Depreciation Expense', debit: 410_255 },
          { account: 'Accumulated Depreciation', credit: 410_255 },
        ],
      },
    );
    // Two fees from the same bank on the same day, without numbers
    txns.push(
      {
        date: d(m, 27),
        type: 'Expense',
        name: 'Bank',
        lines: [
          { account: 'Checking', credit: 1_500, memo: 'Monthly fee' },
          { account: 'Bank Charges', debit: 1_500, memo: 'Monthly fee' },
        ],
      },
      {
        date: d(m, 27),
        type: 'Expense',
        name: 'Bank',
        lines: [
          { account: 'Checking', credit: 250, memo: 'Wire fee' },
          { account: 'Bank Charges', debit: 250, memo: 'Wire fee' },
        ],
      },
    );
  }
  // A check voided in QuickBooks: $0
  txns.push({
    date: d(6, 15),
    type: 'Check',
    num: 1099,
    name: 'Lender Bank',
    lines: [
      { account: 'Checking', credit: 0, memo: 'Voided' },
      { account: 'Bank Charges', debit: 0 },
    ],
  });
  return txns.sort((a, b) => a.date.localeCompare(b.date));
}

const COMPANY: FxCompany = {
  company: 'Sample Holdings LLC',
  accounts: ACCOUNTS,
  before: [
    {
      date: '2022-03-01',
      type: 'Journal Entry',
      num: 'OB',
      lines: [
        { account: 'Building', debit: 300_000_00 },
        { account: 'Mortgage Payable', credit: 250_000_00 },
        { account: 'Capital Stock', credit: 1_000_00 },
        { account: 'Opening Balance Equity', credit: 49_000_00 },
        { account: 'Checking', debit: 0 },
      ],
    },
    ...year(2023),
  ],
  years: [
    { from: '2024-01-01', to: '2024-12-31', txns: year(2024) },
    { from: '2025-01-01', to: '2025-12-31', txns: year(2025) },
  ],
  customers: ['Tenant Co'],
  vendors: ['Lender Bank', 'Bank'],
};

const plan = (opts?: FxOptions, company: FxCompany = COMPANY) =>
  analyze(exportFiles(company, opts));

describe('analysis (MG-2, MG-4)', () => {
  it('finds the periods, accounts, lists and opening balances', () => {
    const { summary } = plan();
    expect(summary.errors).toEqual([]);
    expect(summary.warnings).toEqual([
      '2 transactions of $0 (usually voided in QuickBooks) are left out.',
    ]);
    expect(summary.company).toBe('Sample Holdings LLC');
    expect(summary.periods).toEqual([
      expect.objectContaining({
        from: '2024-01-01',
        to: '2024-12-31',
        source: 'journal',
        cashChecked: true,
        transactions: 60,
        trialBalance: true,
        balanceSheet: true,
      }),
      expect.objectContaining({
        from: '2025-01-01',
        to: '2025-12-31',
        source: 'journal',
        cashChecked: true,
        transactions: 60,
      }),
    ]);
    expect(summary.opening).toEqual({ date: '2023-12-31', accounts: 7, fromTrialBalance: false });
    expect(summary.accounts).toHaveLength(ACCOUNTS.length);
    expect(
      summary.accounts.find((a) => a.name === 'Interest Expense:Mortgage Interest'),
    ).toMatchObject({
      leaf: 'Mortgage Interest',
      parent: 'Interest Expense',
      type: 'expense',
      detailType: 'interest_paid',
      lines: 24,
    });
    expect([summary.customers, summary.vendors]).toEqual([1, 2]);
  });

  it('refuses accrual-basis reports', () => {
    expect(plan({ basis: 'Accrual Basis' }).summary.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/Trial_balance.xlsx is on an accrual basis/)]),
    );
  });

  it('refuses a gap between periods', () => {
    const files = exportFiles(COMPANY).filter((f) => !f.path.includes('2024'));
    const gapped: FxCompany = {
      ...COMPANY,
      years: [COMPANY.years[1]!, { from: '2027-01-01', to: '2027-12-31', txns: [] }],
    };
    const later = exportFiles(gapped).filter((f) => f.path.includes('2027'));
    expect(analyze([...files, ...later]).summary.errors).toContain(
      'Nothing covers 2025-12-31 to 2027-01-01: export that period too.',
    );
  });

  it("refuses a transaction that doesn't balance", () => {
    const bad: FxCompany = {
      ...COMPANY,
      years: [
        {
          ...COMPANY.years[0]!,
          txns: [
            ...COMPANY.years[0]!.txns,
            {
              date: '2024-05-05',
              type: 'Deposit',
              lines: [
                { account: 'Checking', debit: 100 },
                { account: 'Rental Income', credit: 90 },
              ],
            },
          ],
        },
        COMPANY.years[1]!,
      ],
    };
    expect(plan(undefined, bad).summary.errors).toEqual(
      expect.arrayContaining([expect.stringMatching(/Deposit on 2024-05-05 doesn't balance/)]),
    );
  });

  it('rebuilds a period from the General Ledger when the Journal is not cash basis', () => {
    // An invoice shows in the Journal when entered, but not in the cash-basis ledger
    const invoice: FxTxn = {
      date: '2025-03-03',
      type: 'Invoice',
      num: 7,
      name: 'Tenant Co',
      lines: [
        { account: 'Checking', debit: 99_00 },
        { account: 'Rental Income', credit: 99_00 },
      ],
    };
    const p = plan({ journalExtra: { 1: [invoice] } });
    expect(p.summary.periods[1]).toMatchObject({ source: 'generalLedger', cashChecked: false });
    expect(p.summary.warnings.join(' ')).toMatch(/rebuilt from the General Ledger/);
    // The same-day fees with the same name and type are one rebuilt transaction
    expect(p.summary.periods[1]!.transactions).toBe(48);
    expect(p.transactions.some((t) => t.type === 'Invoice')).toBe(false);
  });

  it('uses the trial balance for opening balances when there is no General Ledger', () => {
    const p = plan({ omit: ['General_ledger.xlsx'] });
    expect(p.summary.errors).toEqual([]);
    expect(p.summary.opening).toMatchObject({ date: '2023-12-31', fromTrialBalance: true });
  });
});

describe('dry run and import (MG-4, MG-5, MG-6)', () => {
  let db: Database;
  beforeEach(async () => {
    db = await newCompanyDb();
  });

  const choices = (p = plan()) => proposeChoices(db, p.summary.accounts);
  const count = (table: string) => Number(db.selectValue(`SELECT count(*) FROM ${table}`));

  it('dry run: posts everything, ties out, and leaves nothing behind', () => {
    const p = plan();
    const auditBefore = count('audit_event');
    const result = runImport(db, p, choices(p), { commit: false });
    expect(result.errors).toEqual([]);
    expect(result.committed).toBe(false);
    expect(result.counts).toEqual({ accountsCreated: 13, customers: 1, vendors: 2, entries: 121 });
    expect(result.tieOut?.ok).toBe(true);
    expect(result.tieOut?.checks.map((c) => [c.report, c.asOf, c.differences.length])).toEqual([
      ['Trial Balance', '2024-12-31', 0],
      ['Trial Balance', '2025-12-31', 0],
      ['Balance Sheet', '2025-12-31', 0],
    ]);
    for (const t of [
      'account',
      'journal_entry',
      'journal_line',
      'payee',
      'qbo_import_run',
      'qbo_entry',
    ]) {
      expect(count(t), t).toBe(0);
    }
    expect(count('audit_event')).toBe(auditBefore);
  });

  it('imports with dates, numbers, names and memos kept (MG-3)', () => {
    const p = plan();
    const result = runImport(db, p, choices(p), { commit: true });
    expect(result.committed).toBe(true);
    expect(count('journal_entry')).toBe(121);

    const check = listEntries(db, { search: '1003' })[0]!;
    // Newest first; the fixture reuses check numbers each year
    expect(check).toMatchObject({
      date: '2025-03-12',
      ref: '1003',
      name: 'Lender Bank',
      sourceType: 'qbo_migration',
      amount: 1_000_000,
    });
    const deposit = getEntry(
      db,
      listEntries(db, { search: 'Rent 4', limit: 5 }).find((e) => e.date === '2025-04-01')!.id,
    )!;
    expect(deposit).toMatchObject({ name: 'Tenant Co', memo: 'Rent 4' });
    // A line memo equal to the entry's isn't repeated
    expect(deposit.lines.map((l) => l.memo)).toEqual([null, null]);

    const opening = listEntries(db, { search: 'brought forward' })[0]!;
    expect(opening.date).toBe('2023-12-31');
    expect(db.selectValue('SELECT txn_type FROM qbo_entry WHERE entry_id = ?', [check.id])).toBe(
      'Check',
    );
    expect(db.selectValue('SELECT txn_type FROM qbo_entry WHERE entry_id = ?', [opening.id])).toBe(
      'Opening balances',
    );

    // Sub-accounts keep their parent
    const accounts = listAccounts(db);
    const interest = accounts.find((a) => a.name === 'Mortgage Interest')!;
    expect(interest.fullName).toBe('Interest Expense:Mortgage Interest');
    expect(accounts.find((a) => a.name === 'Retained Earnings')?.detailType).toBe(
      'retained_earnings',
    );

    // Our trial balance is QuickBooks's
    const tb = trialBalance(db, '2025-12-31');
    const re = tb.rows.find((r) => r.account === 'Retained Earnings')!;
    expect(re.credit - re.debit).toBe(p.trialBalances[1]!.balances.get('Retained Earnings')! * -1);

    // Customers and vendors are payees (GL-11), and so is every other name on the history
    expect(db.selectValues(`SELECT name FROM payee WHERE is_customer = 1`)).toEqual(['Tenant Co']);
    expect(db.selectValues(`SELECT name FROM payee WHERE is_vendor = 1 ORDER BY name`)).toEqual([
      'Bank',
      'Lender Bank',
    ]);
    expect(
      count(`journal_entry WHERE name IS NOT NULL AND payee_id IS NULL`),
      'entries with a name and no payee',
    ).toBe(0);
  });

  it('audits the run once instead of every entry (US-5)', () => {
    const p = plan();
    runImport(db, p, choices(p), { commit: true });
    expect(count(`audit_event WHERE entity = 'journal_entry'`)).toBe(0);
    const run = db.selectObjects(
      `SELECT action, after FROM audit_event WHERE entity = 'qbo_import_run' ORDER BY id`,
    );
    expect(run.map((r) => r.action)).toEqual(['insert', 'update']);
    const summary = JSON.parse(String(JSON.parse(String(run[1]!.after)).summary));
    expect(summary).toMatchObject({
      entries: 121,
      tieOut: 'matched',
      periods: ['2024-01-01..2024-12-31', '2025-01-01..2025-12-31'],
    });
    expect(count('qbo_entry')).toBe(121);
  });

  it("doesn't commit when the tie-out differs, unless the owner accepts it", () => {
    const p = plan({ tbOverride: [0, 'Bank Charges', 1] });
    const dry = runImport(db, p, choices(p), { commit: true });
    expect(dry.committed).toBe(false);
    const tb = dry.tieOut!.checks[0]!;
    expect(tb.differences).toEqual([{ account: 'Bank Charges', qbo: 1, ours: 21_000 }]);
    expect(count('journal_entry')).toBe(0);

    const accepted = runImport(db, p, choices(p), { commit: true, acceptDifferences: true });
    expect(accepted.committed).toBe(true);
    expect(count('journal_entry')).toBe(121);
  });

  it('imports only into a company without transactions (MG-6)', async () => {
    const ledger = await newLedgerDb();
    postEntry(ledger, {
      date: '2026-01-05',
      sourceType: 'journal',
      lines: [
        {
          accountId: String(ledger.selectValue(`SELECT id FROM account WHERE name = 'Meals'`)),
          debit: 100,
          credit: 0,
        },
        {
          accountId: String(ledger.selectValue(`SELECT id FROM account WHERE name = 'Checking'`)),
          debit: 0,
          credit: 100,
        },
      ],
    });
    const p = plan();
    expect(() =>
      runImport(ledger, p, proposeChoices(ledger, p.summary.accounts), { commit: false }),
    ).toThrow(
      expect.objectContaining({
        name: 'LedgerRuleError',
        message: expect.stringMatching(/new company/),
      }),
    );
  });

  it('matches existing accounts by name and the one-per-company accounts by kind', async () => {
    const ledger = await newLedgerDb();
    const p = plan();
    const proposed = proposeChoices(ledger, p.summary.accounts);
    const id = (name: string) =>
      String(ledger.selectValue('SELECT id FROM account WHERE name = ?', [name]));
    expect(proposed['Checking']).toEqual({ kind: 'existing', accountId: id('Checking') });
    expect(proposed['Retained Earnings']).toEqual({
      kind: 'existing',
      accountId: id('Retained Earnings'),
    });
    expect(proposed['Opening Balance Equity']).toEqual({
      kind: 'existing',
      accountId: id('Opening Balance Equity'),
    });
    expect(proposed['Building']).toMatchObject({ kind: 'new', type: 'asset' });
    // Two QuickBooks accounts into one of ours still ties out
    const merged: AccountChoices = {
      ...proposed,
      'Uncategorized Expense': { kind: 'existing', accountId: id('Bank Fees') },
      'Bank Charges': { kind: 'existing', accountId: id('Bank Fees') },
    };
    const result = runImport(ledger, p, merged, { commit: true });
    expect(result.errors).toEqual([]);
    expect(result.tieOut?.ok).toBe(true);
    expect(result.committed).toBe(true);
  });

  it('asks for a type for accounts missing from the Account List, and makes deleted ones inactive', () => {
    const company: FxCompany = {
      ...COMPANY,
      accounts: [...ACCOUNTS, { name: 'Old Savings (deleted)', type: 'Bank', detail: 'Savings' }],
      years: [
        {
          ...COMPANY.years[0]!,
          txns: [
            ...COMPANY.years[0]!.txns,
            {
              date: '2024-02-02',
              type: 'Transfer',
              lines: [
                { account: 'Old Savings (deleted)', debit: 500_00 },
                { account: 'Checking', credit: 500_00 },
              ],
            },
            {
              date: '2024-09-09',
              type: 'Transfer',
              lines: [
                { account: 'Checking', debit: 500_00 },
                { account: 'Old Savings (deleted)', credit: 500_00 },
              ],
            },
          ].sort((a, b) => a.date.localeCompare(b.date)),
        },
        COMPANY.years[1]!,
      ],
    };
    const p = plan({ unlisted: ['Old Savings (deleted)'] }, company);
    const old = p.summary.accounts.find((a) => a.name === 'Old Savings (deleted)')!;
    expect(old).toMatchObject({ inList: false, deleted: true, type: null });
    expect(p.summary.warnings.join(' ')).toMatch(
      /Old Savings \(deleted\) isn't in the Account List/,
    );

    const c = proposeChoices(db, p.summary.accounts);
    expect(checkChoices(db, p, c)).toEqual(['Account Old Savings (deleted): choose a type.']);
    expect(runImport(db, p, c, { commit: true }).committed).toBe(false);

    c['Old Savings (deleted)'] = { kind: 'new', type: 'asset', detailType: 'bank' };
    const result = runImport(db, p, c, { commit: true });
    expect(result.committed).toBe(true);
    expect(listAccounts(db).find((a) => a.name === 'Old Savings (deleted)')?.active).toBe(false);
  });

  it('types accounts from the balance sheet and profit and loss without an Account List (MG-1)', async () => {
    const company: FxCompany = {
      ...COMPANY,
      accounts: [
        ...ACCOUNTS,
        { name: 'Visa', type: 'Credit Card', detail: 'Credit Card' },
        { name: 'Visa:Card 1234', type: 'Credit Card', detail: 'Credit Card' },
      ],
      years: [
        COMPANY.years[0]!,
        {
          ...COMPANY.years[1]!,
          txns: [
            ...COMPANY.years[1]!.txns,
            {
              date: '2025-06-03',
              type: 'Credit Card Expense',
              name: 'Bank',
              lines: [
                { account: 'Bank Charges', debit: 35_00 },
                { account: 'Visa:Card 1234', credit: 35_00 },
              ],
            },
          ].sort((x, y) => x.date.localeCompare(y.date)),
        },
      ],
    };
    const p = plan({ omit: ['Sample Holdings LLC_Account List.xlsx'] }, company);
    const typed = (name: string) => {
      const a = p.summary.accounts.find((x) => x.name === name)!;
      return [a.type, a.detailType];
    };
    expect(typed('Checking')).toEqual(['asset', 'bank']);
    expect(typed('Building')).toEqual(['asset', 'fixed_asset']);
    expect(typed('Mortgage Payable')).toEqual(['liability', 'long_term_liability']);
    expect(typed('Visa:Card 1234')).toEqual(['liability', 'credit_card']);
    expect(typed('Retained Earnings')).toEqual(['equity', 'retained_earnings']);
    expect(typed('Opening Balance Equity')).toEqual(['equity', 'opening_balance_equity']);
    expect(typed('Rental Income')).toEqual(['income', 'other_income']);
    expect(typed('Interest Expense:Mortgage Interest')).toEqual(['expense', 'other_expense']);
    expect(p.summary.warnings.filter((w) => w.includes('choose its type'))).toEqual([]);

    const db = await newCompanyDb();
    const result = runImport(db, p, proposeChoices(db, p.summary.accounts), { commit: false });
    expect(result.errors).toEqual([]);
    expect(result.tieOut?.ok).toBe(true);
  });

  it("keeps a sub-account's type with its parent", () => {
    const p = plan();
    const c = choices(p);
    c['Interest Expense:Mortgage Interest'] = {
      kind: 'new',
      type: 'liability',
      detailType: 'loan_payable',
    };
    expect(checkChoices(db, p, c)).toEqual([
      'Account Interest Expense:Mortgage Interest: a sub-account must have the same type as Interest Expense.',
    ]);
  });
});
