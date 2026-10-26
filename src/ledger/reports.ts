// Financial reports from posted entries (RP-1, RP-2, RP-4, RP-5). The ledger
// is cash basis, so these are cash-basis reports with no conversion. Every
// figure that comes from accounts carries a drill-down target.

import { isDebitNormal, type AccountType } from '../shared/accounts';
import { dayBefore } from '../shared/periods';
import {
  REPORT_TITLES,
  type Drill,
  type Report,
  type ReportRequest,
  type ReportRow,
} from '../shared/report';
import { LedgerRuleError } from '../worker/errors';
import type { Database } from '../worker/sqlite';
import { accountFullNames, accountTree, type TreeAccount } from './accounts';
import { fiscalYearStart, trialBalance } from './balances';
import { isIsoDate } from './postEntry';

const EARLIEST = '1900-01-01';
/** The general ledger stops after this many lines; narrow the dates or pick an account. */
export const GL_LINE_LIMIT = 20_000;

const longDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });
const fmt = (d: string) => longDate.format(new Date(`${d}T00:00:00Z`));

function header(
  db: Database,
  req: ReportRequest,
  period: string,
): Omit<Report, 'columns' | 'rows'> {
  return {
    kind: req.kind,
    title: REPORT_TITLES[req.kind],
    company: String(db.selectValue('SELECT legal_name FROM company')),
    period,
    basis: 'Cash basis',
    generatedAt: new Date().toISOString(),
    notes: [],
  };
}

function fyStartMonth(db: Database): number {
  return Number(db.selectValue('SELECT fiscal_year_start_month FROM company'));
}

/** Debit-minus-credit per account for posted entries dated from..to. */
function netByAccount(
  db: Database,
  from: string,
  to: string,
  types?: AccountType[],
): Map<string, bigint> {
  const typeFilter = types ? `AND a.type IN (${types.map(() => '?').join(', ')})` : '';
  return new Map(
    db
      .selectArrays(
        `SELECT l.account_id, sum(l.debit - l.credit)
         FROM journal_line l
         JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted' AND e.date BETWEEN ? AND ?
         JOIN account a ON a.id = l.account_id
         WHERE 1 = 1 ${typeFilter}
         GROUP BY l.account_id`,
        [from, to, ...(types ?? [])],
      )
      .map((r) => [String(r[0]), BigInt(Number(r[1]))]),
  );
}

function netIncome(db: Database, from: string, to: string): bigint {
  let total = 0n;
  for (const v of netByAccount(db, from, to, ['income', 'expense']).values()) total -= v;
  return total;
}

/**
 * Rows for a group of top-level accounts and their sub-accounts. A parent with
 * sub-accounts gets a heading, its own amount (if any), its children and a
 * "Total" line; accounts with nothing in the period are left out.
 */
function accountRows(
  tops: TreeAccount[],
  all: TreeAccount[],
  amount: (a: TreeAccount) => bigint,
  drill: (a: TreeAccount) => Drill | undefined,
  depth: number,
): { rows: ReportRow[]; total: bigint } {
  const childrenOf = (id: string) => all.filter((a) => a.parentId === id);
  const subtree = (a: TreeAccount): bigint =>
    childrenOf(a.id).reduce((s, c) => s + subtree(c), amount(a));
  const active = (a: TreeAccount): boolean => amount(a) !== 0n || childrenOf(a.id).some(active);
  const rows: ReportRow[] = [];
  let total = 0n;
  const emit = (a: TreeAccount, d: number) => {
    const own = amount(a);
    const kids = childrenOf(a.id).filter(active);
    if (kids.length === 0) {
      rows.push({ kind: 'row', depth: d, cells: [a.name, Number(own)], drill: drill(a) });
      return;
    }
    rows.push({
      kind: 'row',
      depth: d,
      cells: [a.name, own !== 0n ? Number(own) : null],
      drill: own !== 0n ? drill(a) : undefined,
    });
    kids.forEach((k) => emit(k, d + 1));
    rows.push({ kind: 'subtotal', depth: d, cells: [`Total ${a.name}`, Number(subtree(a))] });
  };
  for (const a of tops.filter(active)) {
    emit(a, depth);
    total += subtree(a);
  }
  return { rows, total };
}

function section(
  label: string,
  body: { rows: ReportRow[]; total: bigint },
  totalLabel: string,
): ReportRow[] {
  return [
    { kind: 'section', depth: 0, cells: [label, null] },
    ...body.rows,
    { kind: 'total', depth: 0, cells: [totalLabel, Number(body.total)] },
  ];
}

/** Profit and loss for a date range (RP-1). */
export function profitAndLoss(db: Database, req: ReportRequest): Report {
  const from = req.from ?? EARLIEST;
  const to = req.to;
  const all = accountTree(db);
  const net = netByAccount(db, from, to, ['income', 'expense']);
  const credit = (a: TreeAccount) => -(net.get(a.id) ?? 0n);
  const debit = (a: TreeAccount) => net.get(a.id) ?? 0n;
  const drill = (a: TreeAccount): Drill => ({ kind: 'account', accountId: a.id, from, to });
  const tops = (type: AccountType) => all.filter((a) => a.depth === 0 && a.type === type);

  const income = accountRows(tops('income'), all, credit, drill, 1);
  const cogsTops = tops('expense').filter((a) => a.detailType === 'cost_of_goods_sold');
  const cogs = accountRows(cogsTops, all, debit, drill, 1);
  const expenses = accountRows(
    tops('expense').filter((a) => a.detailType !== 'cost_of_goods_sold'),
    all,
    debit,
    drill,
    1,
  );

  const rows: ReportRow[] = [...section('Income', income, 'Total Income')];
  if (cogs.rows.length) {
    rows.push(...section('Cost of Goods Sold', cogs, 'Total Cost of Goods Sold'));
    rows.push({
      kind: 'total',
      depth: 0,
      cells: ['Gross Profit', Number(income.total - cogs.total)],
    });
  }
  rows.push(...section('Expenses', expenses, 'Total Expenses'));
  rows.push({
    kind: 'total',
    depth: 0,
    cells: ['Net Income', Number(income.total - cogs.total - expenses.total)],
  });
  const period = req.from ? `${fmt(from)} – ${fmt(to)}` : `Through ${fmt(to)}`;
  return {
    ...header(db, req, period),
    columns: [
      { label: '', numeric: false },
      { label: 'Total', numeric: true },
    ],
    rows,
  };
}

/** Balance sheet as of a date (RP-2), with earlier years' income in retained earnings (PC-3). */
export function balanceSheet(db: Database, req: ReportRequest): Report {
  const asOf = req.to;
  const fyStart = fiscalYearStart(asOf, fyStartMonth(db));
  const all = accountTree(db);
  const net = netByAccount(db, EARLIEST, asOf, ['asset', 'liability', 'equity']);
  const prior = netIncome(db, EARLIEST, dayBefore(fyStart));
  const current = netIncome(db, fyStart, asOf);
  const re = all.find((a) => a.detailType === 'retained_earnings');

  const debit = (a: TreeAccount) => net.get(a.id) ?? 0n;
  const credit = (a: TreeAccount) => -(net.get(a.id) ?? 0n) + (a.id === re?.id ? prior : 0n);
  const toAccount = (a: TreeAccount): Drill => ({
    kind: 'account',
    accountId: a.id,
    from: null,
    to: asOf,
  });
  const earlierYears: Drill = { kind: 'pl', from: null, to: dayBefore(fyStart) };
  // Retained earnings is mostly earlier years' income; drill to that P&L unless the account has its own entries
  const equityDrill = (a: TreeAccount): Drill =>
    a.id === re?.id && (net.get(a.id) ?? 0n) === 0n ? earlierYears : toAccount(a);
  const tops = (type: AccountType) => all.filter((a) => a.depth === 0 && a.type === type);

  const assets = accountRows(tops('asset'), all, debit, toAccount, 1);
  const liabilities = accountRows(tops('liability'), all, credit, toAccount, 1);
  const equity = accountRows(tops('equity'), all, credit, equityDrill, 1);
  // A company without a retained earnings account still shows the figure
  if (!re && prior !== 0n) {
    equity.rows.push({
      kind: 'row',
      depth: 1,
      cells: ['Retained Earnings', Number(prior)],
      drill: earlierYears,
    });
    equity.total += prior;
  }
  equity.rows.push({
    kind: 'row',
    depth: 1,
    cells: ['Net Income', Number(current)],
    drill: { kind: 'pl', from: fyStart, to: asOf },
  });
  equity.total += current;

  const rows: ReportRow[] = [
    ...section('Assets', assets, 'Total Assets'),
    ...section('Liabilities', liabilities, 'Total Liabilities'),
    ...section('Equity', equity, 'Total Equity'),
    {
      kind: 'total',
      depth: 0,
      cells: ['Total Liabilities and Equity', Number(liabilities.total + equity.total)],
    },
  ];
  const report: Report = {
    ...header(db, req, `As of ${fmt(asOf)}`),
    columns: [
      { label: '', numeric: false },
      { label: 'Total', numeric: true },
    ],
    rows,
  };
  if (assets.total !== liabilities.total + equity.total) {
    report.notes.push(
      'Assets do not equal liabilities plus equity. Please report this: the ledger should make it impossible.',
    );
  }
  return report;
}

/** Trial balance as of a date (RP-4). */
export function trialBalanceReport(db: Database, req: ReportRequest): Report {
  const tb = trialBalance(db, req.to);
  const rows: ReportRow[] = tb.rows.map((r) => {
    const isPl = r.type === 'income' || r.type === 'expense';
    const drill: Drill = r.accountId
      ? {
          kind: 'account',
          accountId: r.accountId,
          from: isPl ? tb.fiscalYearStart : null,
          to: tb.asOf,
        }
      : { kind: 'pl', from: null, to: dayBefore(tb.fiscalYearStart) };
    return { kind: 'row', depth: 0, cells: [r.account, r.debit || null, r.credit || null], drill };
  });
  rows.push({ kind: 'total', depth: 0, cells: ['Total', tb.totalDebit, tb.totalCredit] });
  return {
    ...header(db, req, `As of ${fmt(tb.asOf)}`),
    columns: [
      { label: '', numeric: false },
      { label: 'Debit', numeric: true },
      { label: 'Credit', numeric: true },
    ],
    rows,
  };
}

/**
 * General ledger detail (RP-4): for each account, the balance before the
 * period, every posted line in it with a running balance, and the ending
 * balance. Balances are on the account's normal side; income and expense
 * accounts start each fiscal year at zero.
 */
export function generalLedger(db: Database, req: ReportRequest, limit = GL_LINE_LIMIT): Report {
  const from = req.from ?? EARLIEST;
  const to = req.to;
  const startMonth = fyStartMonth(db);
  const plStart = fiscalYearStart(from, startMonth);
  const accounts = accountTree(db).filter((a) => !req.accountId || a.id === req.accountId);
  if (req.accountId && accounts.length === 0)
    throw new LedgerRuleError('That account no longer exists.');
  const names = accountFullNames(db);

  const opening = new Map<string, bigint>();
  if (from > EARLIEST) {
    const before = dayBefore(from);
    for (const [id, v] of netByAccount(db, EARLIEST, before, ['asset', 'liability', 'equity']))
      opening.set(id, v);
    if (plStart < from) {
      for (const [id, v] of netByAccount(db, plStart, before, ['income', 'expense']))
        opening.set(id, v);
    }
  }

  const bind: (string | number)[] = [from, to];
  if (req.accountId) bind.push(req.accountId);
  bind.push(limit + 1);
  const lines = db.selectArrays(
    `SELECT l.account_id, e.date, e.id, e.ref, coalesce(l.memo, e.memo), l.debit, l.credit,
            (SELECT CASE WHEN count(DISTINCT x.account_id) = 1 THEN min(x.account_id) ELSE '' END
             FROM journal_line x WHERE x.entry_id = l.entry_id AND x.id <> l.id)
     FROM journal_line l
     JOIN journal_entry e ON e.id = l.entry_id AND e.status = 'posted' AND e.date BETWEEN ? AND ?
     ${req.accountId ? 'WHERE l.account_id = ?' : ''}
     ORDER BY l.account_id, e.date, e.id, l.line_no
     LIMIT ?`,
    bind,
  );
  const truncated = lines.length > limit;
  const byAccount = new Map<string, typeof lines>();
  for (const l of lines.slice(0, limit)) {
    const id = String(l[0]);
    byAccount.set(id, [...(byAccount.get(id) ?? []), l]);
  }

  const rows: ReportRow[] = [];
  for (const a of accounts) {
    const own = byAccount.get(a.id) ?? [];
    const start = opening.get(a.id) ?? 0n;
    if (own.length === 0 && start === 0n) continue;
    const sign = isDebitNormal(a.type) ? 1n : -1n;
    let balance = start * sign;
    rows.push({
      kind: 'section',
      depth: 0,
      cells: [a.fullName, null, null, null, null, null, null, null],
    });
    rows.push({
      kind: 'row',
      depth: 1,
      cells: ['Beginning balance', null, null, null, null, null, null, Number(balance)],
    });
    let debits = 0n;
    let credits = 0n;
    for (const l of own) {
      const debit = BigInt(Number(l[5]));
      const credit = BigInt(Number(l[6]));
      debits += debit;
      credits += credit;
      balance += (debit - credit) * sign;
      const split = String(l[7]);
      rows.push({
        kind: 'row',
        depth: 1,
        cells: [
          String(l[1]),
          String(l[2]),
          l[3] === null ? null : String(l[3]),
          l[4] === null ? null : String(l[4]),
          split ? (names.get(split) ?? '?') : '-Split-',
          debit ? Number(debit) : null,
          credit ? Number(credit) : null,
          Number(balance),
        ],
        drill: { kind: 'entry', entryId: Number(l[2]) },
      });
    }
    rows.push({
      kind: 'subtotal',
      depth: 0,
      cells: [
        `Total for ${a.fullName}`,
        null,
        null,
        null,
        null,
        Number(debits),
        Number(credits),
        Number(balance),
      ],
    });
  }
  const scope = req.accountId ? `${names.get(req.accountId)} · ` : '';
  const report: Report = {
    ...header(db, req, `${scope}${req.from ? `${fmt(from)} – ${fmt(to)}` : `Through ${fmt(to)}`}`),
    columns: [
      { label: 'Date', numeric: false },
      { label: 'No.', numeric: false },
      { label: 'Ref', numeric: false },
      { label: 'Memo', numeric: false },
      { label: 'Split', numeric: false },
      { label: 'Debit', numeric: true },
      { label: 'Credit', numeric: true },
      { label: 'Balance', numeric: true },
    ],
    rows,
  };
  if (truncated) {
    report.notes.push(
      `Only the first ${limit.toLocaleString('en-US')} lines are shown. Choose one account or a shorter period to see everything.`,
    );
  }
  return report;
}

export function runReport(db: Database, req: ReportRequest): Report {
  if (!isIsoDate(req.to) || (req.from && !isIsoDate(req.from)))
    throw new LedgerRuleError('Enter valid dates.');
  if (req.from && req.from > req.to)
    throw new LedgerRuleError('The start date is after the end date.');
  switch (req.kind) {
    case 'pl':
      return profitAndLoss(db, req);
    case 'bs':
      return balanceSheet(db, req);
    case 'tb':
      return trialBalanceReport(db, req);
    case 'gl':
      return generalLedger(db, req);
  }
}
