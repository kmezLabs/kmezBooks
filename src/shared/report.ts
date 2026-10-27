// One shape for every report, so the screen, CSV, Excel and print all share a
// renderer (RP-1 to RP-6). Amount cells are integer cents, percent cells are
// hundredths of a percent (RP-10); text cells are strings.

import { formatMoney, type Cents } from './money';

export type Cell = string | Cents | null;

/** Where clicking a figure leads (RP-5). */
export type Drill =
  | { kind: 'account'; accountId: string; from: string | null; to: string }
  | { kind: 'pl'; from: string | null; to: string }
  | { kind: 'entry'; entryId: number };

export interface ReportColumn {
  label: string;
  numeric: boolean;
  /** Numeric cells are cents unless this says percent (hundredths of a percent: 1234 = 12.34%). */
  unit?: 'percent';
}

export interface ReportRow {
  /** section: a heading; row: an account or line; subtotal/total: sums */
  kind: 'section' | 'row' | 'subtotal' | 'total';
  depth: number;
  cells: Cell[];
  drill?: Drill;
}

export type ReportKind = 'pl' | 'bs' | 'tb' | 'gl';

export interface Report {
  kind: ReportKind;
  title: string;
  company: string;
  /** "January 1 – October 26, 2026" or "As of October 26, 2026" */
  period: string;
  basis: 'Cash basis';
  columns: ReportColumn[];
  rows: ReportRow[];
  generatedAt: string;
  /** Shown under the report, e.g. that a long general ledger was cut short. */
  notes: string[];
}

export interface ReportRequest {
  kind: ReportKind;
  /** P&L and general ledger; null means from the first entry */
  from?: string | null;
  /** P&L and general ledger: end date; balance sheet and trial balance: as-of date */
  to: string;
  /** General ledger: one account, or every account */
  accountId?: string | null;
  /** P&L: add a "% of Income" column (RP-10) */
  percentOfIncome?: boolean;
}

export const REPORT_TITLES: Record<ReportKind, string> = {
  pl: 'Profit and Loss',
  bs: 'Balance Sheet',
  tb: 'Trial Balance',
  gl: 'General Ledger',
};

/** 1234 → "12.34%"; negatives as "-12.34%". */
export function formatPercent(hundredths: number): string {
  if (!Number.isSafeInteger(hundredths)) throw new Error(`Not a percentage: ${hundredths}`);
  const digits = String(Math.abs(hundredths)).padStart(3, '0');
  return `${hundredths < 0 ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}%`;
}

/** 1234 → "0.1234": the fraction a spreadsheet cell formatted as a percentage needs. */
export function percentToDecimal(hundredths: number): string {
  const digits = String(Math.abs(hundredths)).padStart(5, '0');
  return `${hundredths < 0 ? '-' : ''}${digits.slice(0, -4)}.${digits.slice(-4)}`;
}

/** A numeric cell as the screen shows it. */
export function formatNumber(cell: number, column: ReportColumn | undefined): string {
  return column?.unit === 'percent' ? formatPercent(cell) : formatMoney(cell);
}
