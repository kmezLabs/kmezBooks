// QuickBooks Online report and list exports, as written by "Export data" or a
// report's "Export to Excel" (MG-1, MG-2, MG-5). Every export has the company
// on row 1, the title on row 2 and the period on row 3, a header row naming
// the columns, and a footer with the run time and, for reports with an
// accounting method, "Cash Basis" or "Accrual Basis". Columns are found by
// their header text, so customised or reordered columns still read.

import { decimalToCents, serialToIsoDate, type Cell, type Sheet, type SheetRow } from './xlsx';

export type QboKind =
  | 'journal'
  | 'generalLedger'
  | 'trialBalance'
  | 'balanceSheet'
  | 'profitAndLoss'
  | 'accountList'
  | 'customers'
  | 'vendors'
  | 'employees'
  | 'products';

const TITLES: Record<string, QboKind> = {
  journal: 'journal',
  'general ledger': 'generalLedger',
  'trial balance': 'trialBalance',
  'balance sheet': 'balanceSheet',
  'profit and loss': 'profitAndLoss',
  'account list': 'accountList',
  'customer contact list': 'customers',
  'vendor contact list': 'vendors',
  'employee contact list': 'employees',
  'product/service list': 'products',
  'products and services': 'products',
};

export const KIND_LABELS: Record<QboKind, string> = {
  journal: 'Journal',
  generalLedger: 'General Ledger',
  trialBalance: 'Trial Balance',
  balanceSheet: 'Balance Sheet',
  profitAndLoss: 'Profit and Loss',
  accountList: 'Account List',
  customers: 'Customer list',
  vendors: 'Vendor list',
  employees: 'Employee list',
  products: 'Products and services',
};

export type Basis = 'cash' | 'accrual' | null;

export interface Period {
  from: string;
  to: string;
}

export interface QboHeader {
  kind: QboKind;
  company: string;
  title: string;
  /** Row 3 as written, e.g. "January - December 2025" or "As of December 31, 2025" */
  subtitle: string;
  basis: Basis;
  /** The day it was run, from the footer ("Monday, Nov 02, 2026 02:06:45 PM GMT-8") */
  run: string | null;
}

/** A problem in a file, with where it is. */
export class QboFileError extends Error {
  override name = 'QboFileError';
}

const text = (c: Cell | undefined) => (c ? c.text : '');
const norm = (s: string) => s.trim().toLowerCase();

/** The report kind from row 2's title, or null for a workbook that isn't a QuickBooks export. */
export function readHeader(sheet: Sheet): QboHeader | null {
  const first = sheet.rows.slice(0, 4).map((r) => text(r.cells[0]).trim());
  const kind = TITLES[norm(first[1] ?? '')];
  if (!kind) return null;
  let basis: Basis = null;
  let run: string | null = null;
  for (const row of sheet.rows.slice(-6)) {
    const t = text(row.cells[0]);
    if (/cash basis/i.test(t)) basis = 'cash';
    else if (/accrual basis/i.test(t)) basis = 'accrual';
    run = runDate(t) ?? run;
  }
  return {
    kind,
    company: first[0] ?? '',
    title: first[1] ?? '',
    subtitle: first[2] ?? '',
    basis,
    run,
  };
}

// ---- dates and periods ----

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

interface DatePart {
  month: number;
  day: number | null;
  year: number | null;
}

/** "December 31, 2025", "December 2025", "December 31", "December" */
function datePart(s: string): DatePart | null {
  const m = /^([A-Za-z]+)\.?(?:\s+(\d{1,2}))?(?:,?\s+(\d{4}))?$/.exec(s.trim());
  if (!m) return null;
  const month = MONTHS.findIndex((x) => x.startsWith(m[1]!.toLowerCase()) && m[1]!.length >= 3);
  if (month < 0) return null;
  return { month: month + 1, day: m[2] ? Number(m[2]) : null, year: m[3] ? Number(m[3]) : null };
}

/** "As of December 31, 2025" → "2025-12-31". */
export function parseAsOf(subtitle: string): string | null {
  const m = /^as of\s+(.+)$/i.exec(subtitle.trim());
  const p = m && datePart(m[1]!);
  if (!p || !p.year) return null;
  return iso(p.year, p.month, p.day ?? lastDay(p.year, p.month));
}

/** "Monday, Nov 02, 2026 02:06:45 PM GMT-8 - Cash Basis" → "2026-11-02". */
export function runDate(footer: string): string | null {
  const m = /^[A-Za-z]+,\s+([A-Za-z]+\.?\s+\d{1,2},\s+\d{4})\b/.exec(footer.trim());
  const p = m && datePart(m[1]!);
  return p && p.day && p.year ? iso(p.year, p.month, p.day) : null;
}

/** Row 3 of a report run for "All Dates", which names no dates (MG-11). */
export const isAllDates = (subtitle: string) => /^all dates$/i.test(subtitle.trim());

/** "January - December 2025", "January 1 - October 27, 2026", "July 2024 - June 2025", "March 2025". */
export function parsePeriod(subtitle: string): Period | null {
  const parts = subtitle.split(/\s+[-–—]\s+/);
  if (parts.length > 2) return null;
  const a = datePart(parts[0]!);
  const b = parts[1] !== undefined ? datePart(parts[1]) : a;
  if (!a || !b) return null;
  const toYear = b.year ?? a.year;
  if (!toYear) return null;
  const fromYear = a.year ?? (a.month > b.month ? toYear - 1 : toYear);
  return {
    from: iso(fromYear, a.month, a.day ?? 1),
    to: iso(toYear, b.month, b.day ?? lastDay(toYear, b.month)),
  };
}

/** A date cell: "01/02/2025" as text, or an Excel date serial. */
export function cellDate(c: Cell | undefined): string | null {
  if (!c) return null;
  if (c.numeric) {
    const n = Number(c.text);
    return Number.isFinite(n) && n > 1 ? serialToIsoDate(n) : null;
  }
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(c.text.trim());
  if (m) return iso(Number(m[3]), Number(m[1]), Number(m[2]));
  return /^\d{4}-\d{2}-\d{2}$/.test(c.text.trim()) ? c.text.trim() : null;
}

/** A Num cell: QuickBooks writes check numbers as numbers ("2045.0" → "2045"). */
function cellRef(c: Cell | undefined): string | null {
  if (!c) return null;
  const t = c.text.trim();
  if (c.numeric && /^-?\d+\.0+$/.test(t)) return t.replace(/\.0+$/, '');
  return t || null;
}

function cellCents(c: Cell | undefined, where: string): number {
  if (!c) return 0;
  const cents = decimalToCents(c.text.replaceAll(',', '').replace(/^\$/, ''));
  if (cents === null) throw new QboFileError(`${where}: "${c.text}" is not an amount.`);
  return cents;
}

// ---- header rows and columns ----

interface Columns {
  headerRow: number;
  index: Map<string, number>;
}

/** Find the header row (within the first rows) holding all of `required`, any spelling in a group. */
function findColumns(sheet: Sheet, required: string[][], file: string): Columns {
  for (const [i, row] of sheet.rows.slice(0, 12).entries()) {
    const index = new Map<string, number>();
    row.cells.forEach((c, col) => {
      if (c && !c.numeric) index.set(norm(c.text), col);
    });
    if (required.every((group) => group.some((name) => index.has(name)))) {
      return { headerRow: i, index };
    }
  }
  throw new QboFileError(
    `${file}: no header row with the columns ${required.map((g) => g[0]).join(', ')}.`,
  );
}

function col(cols: Columns, ...names: string[]): number | null {
  for (const n of names) {
    const i = cols.index.get(n);
    if (i !== undefined) return i;
  }
  return null;
}

const at = (row: SheetRow, i: number | null) => (i === null ? undefined : row.cells[i]);

// ---- Journal and General Ledger ----

export interface QboLine {
  account: string;
  debit: number;
  credit: number;
  memo: string | null;
  name: string | null;
}

export interface QboTransaction {
  date: string;
  type: string;
  num: string | null;
  name: string | null;
  lines: QboLine[];
  /** "Journal.xlsx row 12" */
  source: string;
}

/** Debit and credit cells → one side, positive. QuickBooks sometimes shows negative amounts. */
function sides(debit: number, credit: number): { debit: number; credit: number } {
  const net = debit - credit;
  return net >= 0 ? { debit: net, credit: 0 } : { debit: 0, credit: -net };
}

const DATE = ['date', 'transaction date'];
const TYPE = ['transaction type', 'type'];
const NUM = ['num', 'no.', '#', 'number'];
const NAME = ['name'];
const MEMO = ['memo/description', 'memo', 'description'];
const ACCOUNT = ['account', 'account full name', 'distribution account', 'account name'];
const DEBIT = ['debit'];
const CREDIT = ['credit'];

/**
 * The Journal report: one transaction per block, a first row with the date,
 * type, number and name, a row per line, then a total row.
 */
export function parseJournal(sheet: Sheet, file: string): QboTransaction[] {
  const cols = findColumns(sheet, [DATE, ACCOUNT, DEBIT, CREDIT], file);
  const c = {
    date: col(cols, ...DATE),
    type: col(cols, ...TYPE),
    num: col(cols, ...NUM),
    name: col(cols, ...NAME),
    memo: col(cols, ...MEMO),
    account: col(cols, ...ACCOUNT),
    debit: col(cols, ...DEBIT),
    credit: col(cols, ...CREDIT),
  };
  const out: QboTransaction[] = [];
  let open: QboTransaction | null = null;
  // The debit and credit columns as written, for checking the total row
  let columnSums = { debit: 0, credit: 0 };
  const close = () => {
    if (open) out.push(open);
    open = null;
  };
  for (const row of sheet.rows.slice(cols.headerRow + 1)) {
    const where = `${file} row ${row.r}`;
    const first = text(row.cells[0]).trim();
    if (/^total$/i.test(first)) break;
    const account = text(at(row, c.account)).trim();
    const dateCell = at(row, c.date);
    const debit = cellCents(at(row, c.debit), where);
    const credit = cellCents(at(row, c.credit), where);
    if (dateCell) {
      close();
      const date = cellDate(dateCell);
      if (!date) throw new QboFileError(`${where}: "${dateCell.text}" is not a date.`);
      open = {
        date,
        type: text(at(row, c.type)).trim() || 'Transaction',
        num: cellRef(at(row, c.num)),
        name: text(at(row, c.name)).trim() || null,
        lines: [],
        source: where,
      };
      columnSums = { debit: 0, credit: 0 };
    }
    if (account) {
      if (!open) throw new QboFileError(`${where}: a line without a transaction above it.`);
      columnSums.debit += debit;
      columnSums.credit += credit;
      open.lines.push({
        account,
        ...sides(debit, credit),
        memo: text(at(row, c.memo)).trim() || null,
        name: text(at(row, c.name)).trim() || null,
      });
    } else if (open && (at(row, c.debit) || at(row, c.credit))) {
      // The transaction's total row: check it, then the block is complete
      const tx: QboTransaction = open;
      if (columnSums.debit !== debit || columnSums.credit !== credit) {
        throw new QboFileError(`${tx.source}: the transaction's lines don't add up to its total.`);
      }
      close();
    }
  }
  close();
  return out;
}

export interface GlLine extends QboLine {
  date: string;
  type: string;
  num: string | null;
  source: string;
}

export interface GeneralLedger {
  lines: GlLine[];
  /** Account full name → balance before the period, as the report shows it (normal sign) */
  beginning: Map<string, number>;
}

/** Leading spaces show nesting in QuickBooks reports. */
const indent = (s: string) => /^ */.exec(s)![0].length;

/**
 * The General Ledger report: a section per account (sub-accounts nested,
 * indented), each with a beginning balance, its lines and a total.
 */
export function parseGeneralLedger(sheet: Sheet, file: string): GeneralLedger {
  const cols = findColumns(sheet, [DATE, DEBIT, CREDIT], file);
  const c = {
    date: col(cols, ...DATE),
    type: col(cols, ...TYPE),
    num: col(cols, ...NUM),
    name: col(cols, ...NAME),
    memo: col(cols, ...MEMO),
    account: col(cols, ...ACCOUNT),
    debit: col(cols, ...DEBIT),
    credit: col(cols, ...CREDIT),
    balance: col(cols, 'balance'),
  };
  const lines: GlLine[] = [];
  const beginning = new Map<string, number>();
  const stack: { depth: number; name: string }[] = [];
  const section = () => stack.map((s) => s.name).join(':');
  for (const row of sheet.rows.slice(cols.headerRow + 1)) {
    const where = `${file} row ${row.r}`;
    const label = text(row.cells[0]);
    const dateCell = at(row, c.date);
    // Column A holds only account headings and totals; lines leave it empty
    if (label.trim()) {
      const depth = indent(label);
      while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
      if (/^total for /i.test(label.trim()) || /^total$/i.test(label.trim())) continue;
      stack.push({ depth, name: label.trim() });
      continue;
    }
    if (!dateCell) continue;
    if (/^beginning balance$/i.test(dateCell.text.trim())) {
      beginning.set(section(), cellCents(at(row, c.balance), where));
      continue;
    }
    const date = cellDate(dateCell);
    if (!date) throw new QboFileError(`${where}: "${dateCell.text}" is not a date.`);
    const account = text(at(row, c.account)).trim() || section();
    if (!account) throw new QboFileError(`${where}: a line outside any account.`);
    lines.push({
      date,
      type: text(at(row, c.type)).trim() || 'Transaction',
      num: cellRef(at(row, c.num)),
      name: text(at(row, c.name)).trim() || null,
      memo: text(at(row, c.memo)).trim() || null,
      account,
      ...sides(cellCents(at(row, c.debit), where), cellCents(at(row, c.credit), where)),
      source: where,
    });
  }
  return { lines, beginning };
}

// ---- Trial Balance and Balance Sheet ----

/** Account full name → debit minus credit, in cents. */
export function parseTrialBalance(sheet: Sheet, file: string): Map<string, number> {
  const cols = findColumns(sheet, [DEBIT, CREDIT], file);
  const debit = col(cols, ...DEBIT);
  const credit = col(cols, ...CREDIT);
  const out = new Map<string, number>();
  for (const row of sheet.rows.slice(cols.headerRow + 1)) {
    const name = text(row.cells[0]).trim();
    if (!name) continue;
    if (/^total$/i.test(name)) break;
    const where = `${file} row ${row.r}`;
    const net = cellCents(at(row, debit), where) - cellCents(at(row, credit), where);
    out.set(name, (out.get(name) ?? 0) + net);
  }
  return out;
}

export interface StatementLine {
  /** The headings above the line, outermost first ("ASSETS", "Current Assets", …) */
  path: string[];
  label: string;
  /** As the report shows it: assets debit-positive, liabilities and equity credit-positive */
  cents: number;
  source: string;
}

/**
 * A Balance Sheet or Profit and Loss: indented headings and amount lines.
 * Totals are formulas QuickBooks doesn't evaluate, so only the lines are read.
 */
export function parseStatement(sheet: Sheet, file: string): StatementLine[] {
  const cols = findColumns(sheet, [['total']], file);
  const amount = col(cols, 'total');
  const out: StatementLine[] = [];
  const stack: { depth: number; label: string }[] = [];
  for (const row of sheet.rows.slice(cols.headerRow + 1)) {
    const raw = text(row.cells[0]);
    if (!raw.trim()) continue;
    const depth = indent(raw);
    const label = raw.trim();
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop();
    if (/^total\b/i.test(label)) continue;
    const cell = at(row, amount);
    if (cell) {
      out.push({
        path: stack.map((s) => s.label),
        label,
        cents: cellCents(cell, `${file} row ${row.r}`),
        source: `${file} row ${row.r}`,
      });
    }
    // A line can also head its sub-accounts
    stack.push({ depth, label });
  }
  return out;
}

// ---- lists ----

export interface QboAccountListRow {
  name: string;
  type: string;
  detailType: string;
  description: string | null;
  number: string | null;
}

export function parseAccountList(sheet: Sheet, file: string): QboAccountListRow[] {
  const cols = findColumns(sheet, [['account name', 'account', 'name'], ['type']], file);
  const c = {
    name: col(cols, 'account name', 'account', 'name'),
    type: col(cols, 'type'),
    detail: col(cols, 'detail type'),
    description: col(cols, 'description'),
    number: col(cols, 'account #', 'number', 'account number'),
  };
  const out: QboAccountListRow[] = [];
  for (const row of sheet.rows.slice(cols.headerRow + 1)) {
    const name = text(at(row, c.name)).trim();
    if (!name || /^total$/i.test(name)) continue;
    const type = text(at(row, c.type)).trim();
    if (!type) continue;
    out.push({
      name,
      type,
      detailType: text(at(row, c.detail)).trim(),
      description: text(at(row, c.description)).trim() || null,
      number: cellRef(at(row, c.number)),
    });
  }
  return out;
}

export interface QboContact {
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  /** Customers: billing address; vendors: address */
  address: string | null;
  shippingAddress: string | null;
  accountNumber: string | null;
}

export function parseContactList(sheet: Sheet, file: string, kind: 'customers' | 'vendors') {
  const first = kind === 'customers' ? 'customer' : 'vendor';
  const cols = findColumns(sheet, [[first]], file);
  const c = {
    name: col(cols, first),
    contact: col(cols, 'full name', 'contact'),
    email: col(cols, 'email'),
    phone: col(cols, 'phone numbers', 'phone'),
    address: col(cols, 'billing address', 'address'),
    shipping: col(cols, 'shipping address'),
    account: col(cols, 'account #', 'account number'),
  };
  const out: QboContact[] = [];
  const value = (row: SheetRow, i: number | null) => text(at(row, i)).trim() || null;
  for (const row of sheet.rows.slice(cols.headerRow + 1)) {
    const name = value(row, c.name);
    if (!name) continue;
    out.push({
      name,
      contactName: value(row, c.contact),
      email: value(row, c.email),
      phone: value(row, c.phone),
      address: value(row, c.address),
      shippingAddress: value(row, c.shipping),
      accountNumber: value(row, c.account),
    });
  }
  return out;
}
