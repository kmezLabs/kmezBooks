// One shape for every report, so the screen, CSV, Excel and print all share a
// renderer (RP-1 to RP-6). Amount cells are integer cents; text cells are strings.

import type { Cents } from './money';

export type Cell = string | Cents | null;

/** Where clicking a figure leads (RP-5). */
export type Drill =
  | { kind: 'account'; accountId: string; from: string | null; to: string }
  | { kind: 'pl'; from: string | null; to: string }
  | { kind: 'entry'; entryId: number };

export interface ReportColumn {
  label: string;
  numeric: boolean;
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
}

export const REPORT_TITLES: Record<ReportKind, string> = {
  pl: 'Profit and Loss',
  bs: 'Balance Sheet',
  tb: 'Trial Balance',
  gl: 'General Ledger',
};
