// Reading a set of QuickBooks Online exports into an import plan, before
// anything is written (MG-2, MG-3, MG-4). The owner points the app at a folder
// of exports: one "Export data" folder per period (Journal, General Ledger,
// Trial Balance, Balance Sheet, …) plus the Account List. Files are recognised
// by their title, not their name.
//
// Transactions come from the Journal, which keeps each transaction together.
// The Journal has no accounting method of its own, so it is checked line by
// line against the cash-basis General Ledger of the same period. If they
// differ (the Journal shows invoices and bills on their own dates), the
// transactions are rebuilt from the General Ledger instead.

import { SINGLE_DETAIL_TYPES, type AccountType } from '../../shared/accounts';
import { dayBefore } from '../../shared/periods';
import {
  detailFromStatement,
  isDeletedName,
  mapQboType,
  typeFromStatementPath,
} from './qboAccounts';
import {
  KIND_LABELS,
  QboFileError,
  parseAccountList,
  parseAsOf,
  parseContactList,
  parseGeneralLedger,
  parseJournal,
  parsePeriod,
  parseStatement,
  parseTrialBalance,
  readHeader,
  type Basis,
  type GeneralLedger,
  type GlLine,
  type Period,
  type QboAccountListRow,
  type QboContact,
  type QboKind,
  type QboTransaction,
  type StatementLine,
} from './qboReports';
import { NotAWorkbookError, readFirstSheet } from './xlsx';

export interface SourceFile {
  /** Path within the chosen folder, e.g. "Acme 20250101-20251231/Journal.xlsx" */
  path: string;
  bytes: Uint8Array;
}

export interface FileSummary {
  path: string;
  kind: QboKind | null;
  label: string;
  company: string | null;
  /** "2025-01-01 – 2025-12-31", "as of 2025-12-31", or "" */
  period: string;
  basis: Basis;
}

export interface PeriodSummary {
  from: string;
  to: string;
  /** Where the transactions come from */
  source: 'journal' | 'generalLedger' | null;
  transactions: number;
  /** The Journal matched the cash-basis General Ledger account by account */
  cashChecked: boolean;
  trialBalance: boolean;
  balanceSheet: boolean;
}

export interface QboAccount {
  /** Full name as QuickBooks shows it, "Parent:Child" */
  name: string;
  leaf: string;
  parent: string | null;
  number: string | null;
  description: string | null;
  /** null: unknown, the owner chooses before importing */
  type: AccountType | null;
  detailType: string | null;
  qboType: string | null;
  qboDetailType: string | null;
  /** Shown as "(deleted)" in QuickBooks; made inactive after the import */
  deleted: boolean;
  inList: boolean;
  /** Transaction lines that use it */
  lines: number;
}

export interface AnalysisSummary {
  company: string | null;
  files: FileSummary[];
  periods: PeriodSummary[];
  accounts: QboAccount[];
  customers: number;
  vendors: number;
  transactions: number;
  /** Transactions of $0 (voided in QuickBooks), left out */
  skipped: number;
  /** The entry that brings in balances from before the first period */
  opening: { date: string; accounts: number; fromTrialBalance: boolean } | null;
  errors: string[];
  warnings: string[];
}

/** Balances before the first period: "normal" as the General Ledger shows them, or debit-minus-credit. */
export type OpeningBalances =
  | { date: string; kind: 'normal'; balances: Map<string, number> }
  | { date: string; kind: 'net'; balances: Map<string, number> };

export interface TrialBalanceFile {
  asOf: string;
  file: string;
  /** Account full name → debit minus credit */
  balances: Map<string, number>;
}

export interface BalanceSheetFile {
  asOf: string;
  file: string;
  lines: StatementLine[];
}

export interface Analysis {
  summary: AnalysisSummary;
  /** Every period's transactions, by date */
  transactions: QboTransaction[];
  customers: QboContact[];
  vendors: QboContact[];
  opening: OpeningBalances | null;
  trialBalances: TrialBalanceFile[];
  /** The latest balance sheet, for the tie-out (MG-5) */
  balanceSheet: BalanceSheetFile | null;
}

const MAX_ERRORS = 50;

interface ParsedFile {
  path: string;
  kind: QboKind;
  company: string;
  basis: Basis;
  period: Period | null;
  asOf: string | null;
  journal?: QboTransaction[];
  ledger?: GeneralLedger;
  trialBalance?: Map<string, number>;
  statement?: StatementLine[];
  accountList?: QboAccountListRow[];
  contacts?: QboContact[];
}

/** "Acme 20250101-20251231/Journal.xlsx" → the period in the Export data folder's name. */
function periodFromPath(path: string): Period | null {
  const m = /(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})/.exec(path);
  return m ? { from: `${m[1]}-${m[2]}-${m[3]}`, to: `${m[4]}-${m[5]}-${m[6]}` } : null;
}

const fileName = (path: string) => path.split('/').at(-1) ?? path;

function describePeriod(f: ParsedFile): string {
  if (f.period) return `${f.period.from} – ${f.period.to}`;
  if (f.asOf) return `as of ${f.asOf}`;
  return '';
}

/** Read one file; null with a summary note if it isn't a QuickBooks export. */
function readFile(
  src: SourceFile,
  errors: string[],
): { parsed: ParsedFile | null; summary: FileSummary } {
  const name = src.path;
  const short = fileName(name);
  const blank: FileSummary = {
    path: name,
    kind: null,
    label: '',
    company: null,
    period: '',
    basis: null,
  };
  let sheet;
  try {
    sheet = readFirstSheet(src.bytes);
  } catch (e) {
    if (e instanceof NotAWorkbookError)
      return { parsed: null, summary: { ...blank, label: 'Not an Excel workbook' } };
    throw e;
  }
  const header = readHeader(sheet);
  if (!header) return { parsed: null, summary: { ...blank, label: 'Not a QuickBooks export' } };
  const f: ParsedFile = {
    path: name,
    kind: header.kind,
    company: header.company,
    basis: header.basis,
    period: null,
    asOf: null,
  };
  try {
    switch (header.kind) {
      case 'journal':
        f.period = parsePeriod(header.subtitle) ?? periodFromPath(name);
        f.journal = parseJournal(sheet, short);
        break;
      case 'generalLedger':
        f.period = parsePeriod(header.subtitle) ?? periodFromPath(name);
        f.ledger = parseGeneralLedger(sheet, short);
        break;
      case 'trialBalance':
        f.asOf = parseAsOf(header.subtitle) ?? periodFromPath(name)?.to ?? null;
        f.trialBalance = parseTrialBalance(sheet, short);
        break;
      case 'balanceSheet':
        f.asOf = parseAsOf(header.subtitle) ?? periodFromPath(name)?.to ?? null;
        f.statement = parseStatement(sheet, short);
        break;
      case 'profitAndLoss':
        // Read only to type accounts missing from the Account List
        f.statement = parseStatement(sheet, short);
        break;
      case 'accountList':
        f.accountList = parseAccountList(sheet, short);
        break;
      case 'customers':
      case 'vendors':
        f.contacts = parseContactList(sheet, short, header.kind);
        break;
      default:
        break;
    }
  } catch (e) {
    if (!(e instanceof QboFileError)) throw e;
    errors.push(`${name}: ${e.message}`);
    return {
      parsed: null,
      summary: { ...blank, kind: header.kind, label: KIND_LABELS[header.kind] },
    };
  }
  return {
    parsed: f,
    summary: {
      path: name,
      kind: header.kind,
      label: KIND_LABELS[header.kind],
      company: header.company || null,
      period: describePeriod(f),
      basis: header.basis,
    },
  };
}

/** Debit minus credit per account. */
function activity(lines: Iterable<{ account: string; debit: number; credit: number }>) {
  const out = new Map<string, number>();
  for (const l of lines) out.set(l.account, (out.get(l.account) ?? 0) + l.debit - l.credit);
  for (const [k, v] of out) if (v === 0) out.delete(k);
  return out;
}

function sameActivity(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

const balanced = (lines: { debit: number; credit: number }[]) =>
  lines.reduce((s, l) => s + l.debit - l.credit, 0) === 0;

/**
 * Rebuild transactions from General Ledger lines, which list each account's
 * lines separately. Lines with the same date, type, number and name form one
 * transaction. If those don't balance on their own, everything left over on
 * that date becomes one combined entry, which still keeps every account exact.
 */
export function groupLedgerLines(lines: GlLine[], errors: string[]): QboTransaction[] {
  const byDate = new Map<string, Map<string, GlLine[]>>();
  for (const l of lines) {
    const k = [l.type, l.num ?? '', l.name ?? ''].join('\u0000');
    const day = byDate.get(l.date) ?? new Map<string, GlLine[]>();
    day.set(k, [...(day.get(k) ?? []), l]);
    byDate.set(l.date, day);
  }
  const out: QboTransaction[] = [];
  for (const [date, groups] of [...byDate].sort(([a], [b]) => a.localeCompare(b))) {
    const leftover: GlLine[] = [];
    for (const group of groups.values()) {
      if (balanced(group)) {
        const g = group[0]!;
        out.push({ date, type: g.type, num: g.num, name: g.name, lines: group, source: g.source });
      } else {
        leftover.push(...group);
      }
    }
    if (leftover.length) {
      if (!balanced(leftover)) {
        errors.push(
          `General Ledger, ${date}: the lines on this date don't balance (from ${leftover[0]!.source}).`,
        );
        continue;
      }
      const names = new Set(leftover.map((l) => l.name));
      out.push({
        date,
        type: 'Combined',
        num: null,
        name: names.size === 1 ? leftover[0]!.name : null,
        lines: leftover,
        source: leftover[0]!.source,
      });
    }
  }
  return out;
}

/** QuickBooks's leaf name and parent from "A:B:C". */
function splitName(name: string): { leaf: string; parent: string | null } {
  const i = name.lastIndexOf(':');
  return i < 0
    ? { leaf: name, parent: null }
    : { leaf: name.slice(i + 1), parent: name.slice(0, i) };
}

/**
 * Match a balance sheet line to an account full name. Lines show only the
 * account's own name, under headings that are partly groups ("Current Assets")
 * and partly parent accounts, so the longest known "Parent:Child" wins.
 */
export function resolveStatementName(line: StatementLine, known: Set<string>): string | null {
  for (let k = 0; k <= line.path.length; k++) {
    const candidate = [...line.path.slice(k), line.label].join(':');
    if (known.has(candidate)) return candidate;
  }
  return null;
}

export function analyze(sources: SourceFile[]): Analysis {
  const errors: string[] = [];
  const warnings: string[] = [];
  const files: FileSummary[] = [];
  const parsed: ParsedFile[] = [];
  for (const src of [...sources].sort((a, b) => a.path.localeCompare(b.path))) {
    const { parsed: p, summary } = readFile(src, errors);
    files.push(summary);
    if (p) parsed.push(p);
  }

  // ---- company and accounting method ----
  const companies = [...new Set(parsed.map((f) => f.company).filter(Boolean))];
  if (companies.length > 1) {
    errors.push(`The files are from more than one company: ${companies.join(', ')}.`);
  }
  for (const f of parsed) {
    if (['generalLedger', 'trialBalance', 'balanceSheet', 'profitAndLoss'].includes(f.kind)) {
      if (f.basis === 'accrual') {
        errors.push(
          `${f.path} is on an accrual basis. Export it again with the accounting method set to Cash.`,
        );
      } else if (f.basis === null) {
        warnings.push(`${f.path} doesn't say whether it is cash or accrual basis.`);
      }
    }
  }

  // ---- periods ----
  const periodKey = (p: Period) => `${p.from}..${p.to}`;
  const periodFiles = new Map<
    string,
    { period: Period; journal?: ParsedFile; ledger?: ParsedFile }
  >();
  for (const f of parsed.filter((x) => x.kind === 'journal' || x.kind === 'generalLedger')) {
    if (!f.period) {
      errors.push(`${f.path}: the period on row 3 can't be read.`);
      continue;
    }
    const k = periodKey(f.period);
    const entry = periodFiles.get(k) ?? { period: f.period };
    const slot = f.kind === 'journal' ? 'journal' : 'ledger';
    if (entry[slot])
      errors.push(`Two ${KIND_LABELS[f.kind]} files for ${k}: ${entry[slot]!.path} and ${f.path}.`);
    entry[slot] = f;
    periodFiles.set(k, entry);
  }
  const periods = [...periodFiles.values()].sort((a, b) =>
    a.period.from.localeCompare(b.period.from),
  );
  periods.forEach((p, i) => {
    const prev = periods[i - 1];
    if (prev && dayBefore(p.period.from) !== prev.period.to) {
      errors.push(
        p.period.from <= prev.period.to
          ? `The periods ${periodKey(prev.period)} and ${periodKey(p.period)} overlap.`
          : `Nothing covers ${prev.period.to} to ${p.period.from}: export that period too.`,
      );
    }
  });
  if (periods.length === 0) errors.push('No Journal or General Ledger export was found.');

  const trialBalances: TrialBalanceFile[] = parsed
    .filter((f) => f.kind === 'trialBalance')
    .flatMap((f) => (f.asOf ? [{ asOf: f.asOf, file: f.path, balances: f.trialBalance! }] : []));
  const balanceSheets = parsed
    .filter((f) => f.kind === 'balanceSheet' && f.asOf)
    .sort((a, b) => a.asOf!.localeCompare(b.asOf!));
  for (const f of parsed.filter(
    (x) => (x.kind === 'trialBalance' || x.kind === 'balanceSheet') && !x.asOf,
  )) {
    errors.push(`${f.path}: the "As of" date on row 3 can't be read.`);
  }

  // ---- transactions ----
  const transactions: QboTransaction[] = [];
  const periodSummaries: PeriodSummary[] = [];
  let skipped = 0;
  for (const p of periods) {
    const { from, to } = p.period;
    let txns: QboTransaction[] = [];
    let source: PeriodSummary['source'] = null;
    let cashChecked = false;
    const glLines = p.ledger?.ledger?.lines;
    if (p.journal?.journal) {
      txns = p.journal.journal;
      source = 'journal';
      if (glLines) {
        const journalActivity = activity(txns.flatMap((t) => t.lines));
        if (sameActivity(journalActivity, activity(glLines))) {
          cashChecked = true;
        } else {
          warnings.push(
            `${from} – ${to}: the Journal doesn't match the cash-basis General Ledger (it shows invoices and bills when they were entered, not when paid), so the transactions are rebuilt from the General Ledger.`,
          );
          txns = groupLedgerLines(glLines, errors);
          source = 'generalLedger';
        }
      } else {
        warnings.push(
          `${from} – ${to}: no General Ledger, so the Journal can't be checked to be cash basis. The tie-out will still compare the trial balance.`,
        );
      }
    } else if (glLines) {
      txns = groupLedgerLines(glLines, errors);
      source = 'generalLedger';
    }
    const kept: QboTransaction[] = [];
    for (const t of txns) {
      if (t.date < from || t.date > to) {
        errors.push(`${t.source}: dated ${t.date}, outside ${from} – ${to}.`);
      } else if (!balanced(t.lines)) {
        errors.push(`${t.source}: the ${t.type} on ${t.date} doesn't balance.`);
      } else if (t.lines.every((l) => l.debit === 0 && l.credit === 0)) {
        skipped++;
      } else {
        kept.push(t);
      }
    }
    transactions.push(...kept);
    periodSummaries.push({
      from,
      to,
      source,
      transactions: kept.length,
      cashChecked,
      trialBalance: trialBalances.some((tb) => tb.asOf === to),
      balanceSheet: balanceSheets.some((bs) => bs.asOf === to),
    });
    if (!trialBalances.some((tb) => tb.asOf === to)) {
      warnings.push(`No trial balance as of ${to}, so that year-end can't be tied out (MG-5).`);
    }
  }
  if (skipped) {
    warnings.push(`${skipped} transactions of $0 (usually voided in QuickBooks) are left out.`);
  }

  // ---- opening balances ----
  let opening: OpeningBalances | null = null;
  const first = periods[0];
  if (first) {
    const date = dayBefore(first.period.from);
    const beginning = first.ledger?.ledger?.beginning;
    const firstTb = trialBalances.find((tb) => tb.asOf === first.period.to);
    if (beginning) {
      const balances = new Map([...beginning].filter(([, v]) => v !== 0));
      if (balances.size) opening = { date, kind: 'normal', balances };
    } else if (firstTb) {
      // Work back from the trial balance: what it shows minus the period's activity
      const firstTxns = transactions.filter((t) => t.date <= first.period.to);
      const moved = activity(firstTxns.flatMap((t) => t.lines));
      const balances = new Map<string, number>();
      for (const name of new Set([...firstTb.balances.keys(), ...moved.keys()])) {
        const v = (firstTb.balances.get(name) ?? 0) - (moved.get(name) ?? 0);
        if (v !== 0) balances.set(name, v);
      }
      if (balances.size) {
        opening = { date, kind: 'net', balances };
        warnings.push(
          `No General Ledger for ${periodKey(first.period)}, so balances before it come from the trial balance, and the tie-out for ${first.period.to} can't catch a difference.`,
        );
      }
    } else {
      warnings.push(
        `No General Ledger or trial balance for ${periodKey(first.period)}: balances before ${first.period.from} are taken as zero.`,
      );
    }
  }

  // ---- accounts ----
  const listRows = parsed.flatMap((f) => f.accountList ?? []);
  if (!listRows.length) {
    warnings.push(
      'No Account List: account types are taken from the balance sheet and profit and loss where possible. Export it from the Chart of accounts (Run report, then Export).',
    );
  }
  const accounts = new Map<string, QboAccount>();
  const add = (name: string): QboAccount => {
    let a = accounts.get(name);
    if (!a) {
      const { leaf, parent } = splitName(name);
      a = {
        name,
        leaf,
        parent,
        number: null,
        description: null,
        type: null,
        detailType: null,
        qboType: null,
        qboDetailType: null,
        deleted: isDeletedName(name),
        inList: false,
        lines: 0,
      };
      accounts.set(name, a);
      if (parent) add(parent);
    }
    return a;
  };
  for (const row of listRows) {
    const a = add(row.name);
    const mapped = mapQboType(row.type, row.detailType);
    Object.assign(a, {
      inList: true,
      number: row.number,
      description: row.description,
      qboType: row.type,
      qboDetailType: row.detailType || null,
      type: mapped?.type ?? null,
      detailType: mapped?.detailType ?? null,
    });
    if (!mapped)
      warnings.push(
        `Account ${row.name}: QuickBooks type "${row.type}" isn't known here; choose a type.`,
      );
  }
  for (const t of transactions) for (const l of t.lines) add(l.account).lines++;
  if (opening) for (const name of opening.balances.keys()) add(name);
  for (const tb of trialBalances) for (const name of tb.balances.keys()) add(name);

  // Types for accounts missing from the list: from the balance sheet or the
  // profit and loss (the heading they sit under), or from a typed parent
  const known = new Set(accounts.keys());
  const statements = parsed.filter(
    (f) => (f.kind === 'balanceSheet' || f.kind === 'profitAndLoss') && f.statement,
  );
  for (const st of statements) {
    for (const line of st.statement!) {
      const name = resolveStatementName(line, known);
      const a = name ? accounts.get(name) : undefined;
      if (a && !a.inList && !a.type) {
        const type = typeFromStatementPath(line.path);
        if (type) {
          a.type = type;
          a.detailType = detailFromStatement(line.path, a.name.split(':').at(-1)!);
        }
      }
    }
  }
  const byDepth = [...accounts.values()].sort(
    (a, b) => a.name.split(':').length - b.name.split(':').length,
  );
  // A heading account with no balance of its own has its sub-accounts' type
  for (const a of [...byDepth].reverse()) {
    const parent = a.parent ? accounts.get(a.parent) : undefined;
    if (parent && !parent.inList && !parent.type && a.type) {
      parent.type = a.type;
      if (a.detailType && !SINGLE_DETAIL_TYPES.includes(a.detailType)) {
        parent.detailType = a.detailType;
      }
    }
  }
  for (const a of byDepth) {
    const parent = a.parent ? accounts.get(a.parent) : undefined;
    if (!a.type && parent?.type) {
      a.type = parent.type;
      // A card under a card is a card; one-per-company accounts aren't inherited
      if (parent.detailType && !SINGLE_DETAIL_TYPES.includes(parent.detailType)) {
        a.detailType = parent.detailType;
      }
    }
    if (!a.inList && a.type && !a.detailType) {
      a.detailType = detailFromStatement([], a.name.split(':').at(-1)!);
    }
    if (a.type && !a.detailType) a.detailType = defaultDetail(a.type);
  }
  for (const a of accounts.values()) {
    if (!a.type) warnings.push(`Account ${a.name} isn't in the Account List: choose its type.`);
  }

  // ---- lists ----
  const contacts = (kind: 'customers' | 'vendors') => {
    const seen = new Map<string, QboContact>();
    for (const c of parsed.filter((f) => f.kind === kind).flatMap((f) => f.contacts ?? [])) {
      if (!seen.has(c.name.toLowerCase())) seen.set(c.name.toLowerCase(), c);
    }
    return [...seen.values()];
  };
  const customers = contacts('customers');
  const vendors = contacts('vendors');
  if (parsed.some((f) => f.kind === 'products')) {
    warnings.push('Products and services are not imported yet; they arrive with sales (M7).');
  }

  transactions.sort((a, b) => a.date.localeCompare(b.date));
  const latestBs = balanceSheets.at(-1);
  return {
    summary: {
      company: companies[0] ?? null,
      files,
      periods: periodSummaries,
      accounts: [...accounts.values()].sort((a, b) => a.name.localeCompare(b.name)),
      customers: customers.length,
      vendors: vendors.length,
      transactions: transactions.length,
      skipped,
      opening: opening
        ? {
            date: opening.date,
            accounts: opening.balances.size,
            fromTrialBalance: opening.kind === 'net',
          }
        : null,
      errors:
        errors.length > MAX_ERRORS
          ? [...errors.slice(0, MAX_ERRORS), `…and ${errors.length - MAX_ERRORS} more.`]
          : errors,
      warnings,
    },
    transactions,
    customers,
    vendors,
    opening,
    trialBalances,
    balanceSheet: latestBs
      ? { asOf: latestBs.asOf!, file: latestBs.path, lines: latestBs.statement! }
      : null,
  };
}

function defaultDetail(type: AccountType): string {
  return {
    asset: 'other_current_asset',
    liability: 'other_current_liability',
    equity: 'other_equity',
    income: 'other_income',
    expense: 'other_expense',
  }[type];
}
