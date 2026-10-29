// Pieces shared by the banking screens: the account picker, and amounts
// shown the way a bank or card statement shows them.

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

/** The bank or card account a banking screen works on, as a drop-down (owner, Oct 29). */
export function AccountPicker(props: {
  accounts: BankAccount[];
  value: string | null;
  onChange: (id: string) => void;
  /** Say how many transactions wait for review in each */
  showWaiting?: boolean;
}) {
  const chosen = props.accounts.find((a) => a.id === props.value);
  return (
    <div className="fields account-picker">
      <label>
        Account
        <select value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value)}>
          {props.accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {props.showWaiting && a.waiting > 0 ? ` (${a.waiting} to review)` : ''}
            </option>
          ))}
        </select>
        {chosen?.feedLabel && <span className="hint">{chosen.feedLabel}</span>}
      </label>
    </div>
  );
}

/** "1 transaction", "23 transactions" */
export const count = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
