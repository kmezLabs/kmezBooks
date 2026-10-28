// Sales arithmetic shared by the documents (worker) and their screens: line
// amounts from quantity and rate, due dates, and what a document is now.

import type { Cents } from '../../shared/money';
import type { DocKind, DocState, StoredStatus } from './documents';

/** quantity (thousandths) × rate (cents), rounded half away from zero to the cent. */
export function lineAmount(quantity: number, rate: Cents): Cents {
  const p = BigInt(quantity) * BigInt(rate);
  const q = p / 1000n;
  const r = p % 1000n;
  const away = (r < 0n ? -r : r) * 2n >= 1000n;
  return Number(away ? q + (p < 0n ? -1n : 1n) : q);
}

/** The day `days` after `date`. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** What a document is now, as of `today`. */
export function stateOf(
  d: { kind: DocKind; status: StoredStatus; dueDate: string | null; total: Cents; paid: Cents },
  today: string,
): DocState {
  if (d.status === 'void' || d.kind === 'estimate') return d.status;
  if (d.total > 0 && d.paid >= d.total) return 'paid';
  if (d.dueDate && d.dueDate < today) return 'overdue';
  if (d.paid > 0) return 'partial';
  return d.status;
}

/** Text like "2.5" or "12" as thousandths (2500, 12000); null if it isn't a quantity. */
export function parseQuantity(text: string): number | null {
  const m = /^(-?)(\d*)(?:\.(\d{0,3}))?$/.exec(text.trim());
  if (!m || (m[2] === '' && !m[3])) return null;
  const n = Number(m[2] || '0') * 1000 + Number((m[3] ?? '').padEnd(3, '0'));
  return m[1] ? -n : n;
}

/** 2500 → "2.5" */
export function formatQuantity(thousandths: number): string {
  const sign = thousandths < 0 ? '-' : '';
  const a = Math.abs(thousandths);
  const frac = String(a % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return `${sign}${Math.floor(a / 1000)}${frac ? `.${frac}` : ''}`;
}
