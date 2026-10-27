import { describe, expect, it } from 'vitest';
import { groupLedgerLines, resolveStatementName } from './analysis';
import { isDeletedName, mapQboType } from './qboAccounts';
import {
  parseAsOf,
  parseGeneralLedger,
  parseJournal,
  parsePeriod,
  parseStatement,
  readHeader,
  type GlLine,
} from './qboReports';
import { xlsx, type XCell } from './testing/qboFixtures';
import { readFirstSheet } from './xlsx';

const sheet = (title: string, rows: (XCell[] | null)[], footer = 'Tuesday - Cash Basis') =>
  readFirstSheet(
    xlsx(title, [
      ['Acme LLC'],
      [title],
      ['January - December 2025'],
      null,
      ...rows,
      null,
      [footer],
    ]),
  );

describe('report headers and periods', () => {
  it('recognises a report by its title and reads the basis from the footer', () => {
    expect(readHeader(sheet('General Ledger', []))).toMatchObject({
      kind: 'generalLedger',
      company: 'Acme LLC',
      basis: 'cash',
    });
    expect(readHeader(sheet('Trial Balance', [], 'Mon - Accrual Basis'))?.basis).toBe('accrual');
    expect(readHeader(sheet('Journal', [], 'Tuesday, Oct 27'))?.basis).toBeNull();
    expect(readHeader(sheet('Something Else', []))).toBeNull();
  });

  it.each([
    ['January - December 2025', '2025-01-01', '2025-12-31'],
    ['January 1 - October 27, 2026', '2026-01-01', '2026-10-27'],
    ['July 2024 - June 2025', '2024-07-01', '2025-06-30'],
    ['November - February 2025', '2024-11-01', '2025-02-28'],
    ['March 2024', '2024-03-01', '2024-03-31'],
    ['February 2028', '2028-02-01', '2028-02-29'],
  ])('reads the period "%s"', (text, from, to) => {
    expect(parsePeriod(text)).toEqual({ from, to });
  });

  it('reads "As of" dates and refuses what it cannot read', () => {
    expect(parseAsOf('As of December 31, 2025')).toBe('2025-12-31');
    expect(parseAsOf('As of June 2025')).toBe('2025-06-30');
    expect(parsePeriod('All Dates')).toBeNull();
    expect(parseAsOf('December 31, 2025')).toBeNull();
  });
});

describe('Journal (MG-2, MG-3)', () => {
  const header: XCell[] = [
    null,
    'Date',
    'Transaction Type',
    'Num',
    'Name',
    'Memo/Description',
    'Account',
    'Debit',
    'Credit',
  ];

  it('groups each block into a transaction and keeps numbers, names and memos', () => {
    const txns = parseJournal(
      sheet('Journal', [
        header,
        [
          null,
          '02/12/2025',
          'Check',
          { n: '2045.0' },
          'Bank of Somewhere',
          'Rent',
          'Checking',
          null,
          { n: '1000.0' },
        ],
        [null, null, null, null, null, 'Interest part', 'Interest', { n: '400.0' }],
        [null, null, null, null, 'Other Payee', null, 'Loan', { n: '600.0' }],
        [null, null, null, null, null, null, null, { n: '1000.0' }, { n: '1000.0' }],
        null,
        ['TOTAL', null, null, null, null, null, null, { n: '1000.0' }, { n: '1000.0' }],
      ]),
      'Journal.xlsx',
    );
    expect(txns).toEqual([
      {
        date: '2025-02-12',
        type: 'Check',
        num: '2045',
        name: 'Bank of Somewhere',
        source: 'Journal.xlsx row 6',
        lines: [
          {
            account: 'Checking',
            debit: 0,
            credit: 100_000,
            memo: 'Rent',
            name: 'Bank of Somewhere',
          },
          { account: 'Interest', debit: 40_000, credit: 0, memo: 'Interest part', name: null },
          { account: 'Loan', debit: 60_000, credit: 0, memo: null, name: 'Other Payee' },
        ],
      },
    ]);
  });

  it('turns negative amounts into the other side', () => {
    const [t] = parseJournal(
      sheet('Journal', [
        header,
        [null, '01/05/2025', 'Deposit', null, null, null, 'Checking', { n: '-50.0' }],
        [null, null, null, null, null, null, 'Refunds', null, { n: '-50.0' }],
        [null, null, null, null, null, null, null, { n: '-50.0' }, { n: '-50.0' }],
      ]),
      'J',
    );
    expect(t!.lines.map((l) => [l.debit, l.credit])).toEqual([
      [0, 5_000],
      [5_000, 0],
    ]);
  });

  it("refuses a block whose total row doesn't match its lines", () => {
    expect(() =>
      parseJournal(
        sheet('Journal', [
          header,
          [null, '01/05/2025', 'Deposit', null, null, null, 'Checking', { n: '50.0' }],
          [null, null, null, null, null, null, 'Sales', null, { n: '50.0' }],
          [null, null, null, null, null, null, null, { n: '55.0' }, { n: '50.0' }],
        ]),
        'J',
      ),
    ).toThrow(/don't add up/);
  });
});

describe('General Ledger', () => {
  it('reads nested sections, beginning balances and lines', () => {
    const gl = parseGeneralLedger(
      sheet('General Ledger', [
        [
          null,
          'Date',
          'Transaction Type',
          'Num',
          'Name',
          'Memo/Description',
          'Account',
          'Debit',
          'Credit',
          'Balance',
        ],
        ['Checking'],
        [null, 'Beginning Balance', null, null, null, null, null, null, null, { n: '512.34' }],
        [
          null,
          '01/02/2025',
          'Expense',
          null,
          'Vendor',
          'Fee',
          'Checking',
          null,
          { n: '15.0' },
          { n: '497.34' },
        ],
        ['Total for Checking', null, null, null, null, null, null, null, { n: '15.0' }],
        ['Interest Expense'],
        ['   Mortgage Interest'],
        [null, 'Beginning Balance', null, null, null, null, null, null, null, { n: '12.5' }],
        [null, '01/02/2025', 'Expense', null, null, null, null, { n: '15.0' }, null, { n: '27.5' }],
        ['   Total for Mortgage Interest', { n: '15.0' }],
        ['Total for Interest Expense'],
      ]),
      'GL',
    );
    expect([...gl.beginning]).toEqual([
      ['Checking', 51_234],
      ['Interest Expense:Mortgage Interest', 1_250],
    ]);
    expect(gl.lines.map((l) => [l.account, l.debit, l.credit])).toEqual([
      ['Checking', 0, 1_500],
      // No Account column on this line: the section gives the full name
      ['Interest Expense:Mortgage Interest', 1_500, 0],
    ]);
  });

  const line = (over: Partial<GlLine>): GlLine => ({
    date: '2025-01-02',
    type: 'Expense',
    num: null,
    name: 'Vendor',
    memo: null,
    account: 'Checking',
    debit: 0,
    credit: 0,
    source: 'GL',
    ...over,
  });

  it('rebuilds transactions, combining a day only where needed', () => {
    const errors: string[] = [];
    const txns = groupLedgerLines(
      [
        line({ account: 'Checking', credit: 100 }),
        line({ account: 'Fees', debit: 100 }),
        line({ type: 'Payment', name: 'Customer', account: 'Checking', debit: 500 }),
        // Cash-basis income on the same day, under the invoice's own type
        line({ type: 'Invoice', name: 'Customer', account: 'Sales', credit: 500 }),
      ],
      errors,
    );
    expect(errors).toEqual([]);
    expect(txns.map((t) => [t.type, t.lines.length])).toEqual([
      ['Expense', 2],
      ['Combined', 2],
    ]);
    expect(txns[1]!.name).toBe('Customer');
  });

  it("reports a day that doesn't balance", () => {
    const errors: string[] = [];
    groupLedgerLines([line({ debit: 100 })], errors);
    expect(errors[0]).toMatch(/2025-01-02.*don't balance/);
  });
});

describe('Balance Sheet lines', () => {
  it('keeps headings and matches lines to account full names', () => {
    const lines = parseStatement(
      sheet('Balance Sheet', [
        [null, 'Total'],
        ['ASSETS'],
        ['   Current Assets'],
        ['      Bank Accounts'],
        ['         Checking', { f: '1234.56' }],
        ['      Total Bank Accounts', { f: 'B9' }],
        ['   Fixed Assets'],
        ['      Building', { f: '100.0' }],
        ['         Roof', { f: '5.0' }],
        ['      Total Building', { f: 'B12' }],
        ['TOTAL ASSETS', { f: 'B13' }],
      ]),
      'BS',
    );
    expect(lines.map((l) => [l.path.join('>'), l.label, l.cents])).toEqual([
      ['ASSETS>Current Assets>Bank Accounts', 'Checking', 123_456],
      ['ASSETS>Fixed Assets', 'Building', 10_000],
      ['ASSETS>Fixed Assets>Building', 'Roof', 500],
    ]);
    const known = new Set(['Checking', 'Building', 'Building:Roof']);
    expect(lines.map((l) => resolveStatementName(l, known))).toEqual([
      'Checking',
      'Building',
      'Building:Roof',
    ]);
  });
});

describe('account types (MG-1)', () => {
  it.each([
    ['Bank', 'Checking', 'asset', 'bank'],
    ['Other Current Assets', 'Undeposited Funds', 'asset', 'undeposited_funds'],
    ['Accounts receivable (A/R)', 'Accounts Receivable (A/R)', 'asset', 'accounts_receivable'],
    ['Fixed Assets', 'Other fixed assets', 'asset', 'fixed_asset'],
    ['Long Term Liabilities', 'Notes Payable', 'liability', 'loan_payable'],
    ['Credit Card', 'Credit Card', 'liability', 'credit_card'],
    ['Equity', "Owner's Equity", 'equity', 'other_equity'],
    ['Equity', 'Retained Earnings', 'equity', 'retained_earnings'],
    ['Income', 'Service/Fee Income', 'income', 'service_income'],
    ['Other Income', 'Other Miscellaneous Income', 'income', 'other_income'],
    ['Cost of Goods Sold', 'Supplies & Materials - COGS', 'expense', 'cost_of_goods_sold'],
    ['Expenses', 'Other Miscellaneous Service Cost', 'expense', 'other_expense'],
    ['Expenses', 'Bank Charges', 'expense', 'bank_charges'],
    ['Other Expense', 'Depreciation', 'expense', 'depreciation'],
  ])('%s / %s → %s / %s', (type, detail, ours, ourDetail) => {
    expect(mapQboType(type, detail)).toEqual({ type: ours, detailType: ourDetail });
  });

  it('knows unknown types and deleted accounts', () => {
    expect(mapQboType('Mystery', 'X')).toBeNull();
    expect(isDeletedName('Old Savings (deleted)')).toBe(true);
    expect(isDeletedName('Savings')).toBe(false);
  });
});
