// What bills allow, shared by the worker (validation) and the screens
// (pickers, states): which accounts a line or a payment can use, and what a
// bill is now (AP-2 to AP-4).

import type { Cents } from '../../shared/money';

export type BillState = 'open' | 'partial' | 'paid' | 'overdue' | 'void';

/** Accounts a bill line can't go to: money accounts, and A/R and A/P (cash basis). */
export const NOT_ON_BILLS = [
  'bank',
  'cash_on_hand',
  'undeposited_funds',
  'credit_card',
  'accounts_receivable',
  'accounts_payable',
];

/** Accounts a bill can be paid from: money accounts. */
export const PAID_FROM = ['bank', 'cash_on_hand', 'credit_card', 'line_of_credit'];

/** What a bill is now, as of `today` (AP-4). */
export function billState(
  b: { status: 'open' | 'void'; dueDate: string; total: Cents; paid: Cents },
  today: string,
): BillState {
  if (b.status === 'void') return 'void';
  if (b.total > 0 && b.paid >= b.total) return 'paid';
  if (b.dueDate < today) return 'overdue';
  if (b.paid > 0) return 'partial';
  return 'open';
}
