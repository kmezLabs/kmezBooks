// Pieces shared by the banking screens: the account tabs, and amounts shown
// the way a bank or card statement shows them.

import type { AccountType } from '../../shared/accounts';
import { formatMoney, type Cents } from '../../shared/money';
import type { BankAccount } from './bankAccounts';

/** Column headings for money out of and into the account, and their totals' names. */
export function flowLabels(type: AccountType): {
  out: string;
  in: string;
  outs: string;
  ins: string;
} {
  return type === 'liability'
    ? { out: 'Charge', in: 'Payment', outs: 'charges', ins: 'payments' }
    : { out: 'Spent', in: 'Received', outs: 'withdrawals', ins: 'deposits' };
}

/** A transaction's amount in its column: out (negative) or in (positive). */
export function flowCells(amount: Cents): { out: string; in: string } {
  return amount < 0 ? { out: formatMoney(-amount), in: '' } : { out: '', in: formatMoney(amount) };
}

/**
 * A balance as the statement shows it. The ledger counts debit minus credit;
 * a card statement shows what's owed as a positive amount.
 */
export const statementBalance = (type: AccountType, ledger: Cents): Cents =>
  type === 'liability' ? -ledger : ledger;

export const ledgerBalance = statementBalance;

export function AccountTabs(props: {
  accounts: BankAccount[];
  value: string | null;
  onChange: (id: string) => void;
  showWaiting?: boolean;
}) {
  return (
    <div className="tabs bank-tabs" role="tablist">
      {props.accounts.map((a) => (
        <button
          key={a.id}
          role="tab"
          aria-selected={a.id === props.value}
          className={a.id === props.value ? 'tab active' : 'tab'}
          onClick={() => props.onChange(a.id)}
          title={a.feedLabel ?? undefined}
        >
          {a.name}
          {props.showWaiting && a.waiting > 0 && <span className="badge small">{a.waiting}</span>}
        </button>
      ))}
    </div>
  );
}

/** "1 transaction", "23 transactions" */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
