// The debit and credit lines of a journal entry, as typed: used by the journal
// entry form and by recurring entries (GL-4, GL-5). Amounts stay text until
// saved; lineTotals() says whether they balance.

import type { AccountRow } from '../shared/accounts';
import { formatMoney, parseMoney } from '../shared/money';
import { AccountSelect, MoneyInput, cents } from './ledgerUi';

export interface LineDraft {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  /** A line's own payee (MG-3), kept from the entry it was filled from */
  name?: string | null;
}

let nextKey = 1;
export const blankLine = (): LineDraft => ({
  key: nextKey++,
  accountId: '',
  debit: '',
  credit: '',
  memo: '',
});

/** Lines of a saved entry or template, ready to edit. */
export function linesFrom(
  lines: {
    accountId: string;
    debit: number;
    credit: number;
    memo: string | null;
    name?: string | null;
  }[],
): LineDraft[] {
  return lines.map((l) => ({
    ...blankLine(),
    accountId: l.accountId,
    debit: l.debit ? formatMoney(l.debit) : '',
    credit: l.credit ? formatMoney(l.credit) : '',
    memo: l.memo ?? '',
    name: l.name,
  }));
}

/** The lines in use, their totals, and whether every amount reads as money. */
export function lineTotals(lines: LineDraft[]) {
  const used = lines.filter((l) => l.accountId || l.debit.trim() || l.credit.trim());
  const debits = used.reduce((s, l) => s + cents(l.debit), 0);
  const credits = used.reduce((s, l) => s + cents(l.credit), 0);
  return {
    used,
    debits,
    credits,
    difference: debits - credits,
    badAmount: lines.some((l) => parseMoney(l.debit) === null || parseMoney(l.credit) === null),
    /** At least two lines, with something on them, that balance */
    balanced: debits - credits === 0 && debits > 0 && used.length >= 2,
  };
}

/** The lines as cents, for saving. */
export const linesToCents = (used: LineDraft[]) =>
  used.map((l) => ({
    accountId: l.accountId,
    debit: cents(l.debit),
    credit: cents(l.credit),
    memo: l.memo,
    name: l.name ?? null,
  }));

export function LineEditor(props: {
  accounts: AccountRow[];
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
}) {
  const { lines, onChange } = props;
  const { debits, credits, difference } = lineTotals(lines);
  const setLine = (key: number, changes: Partial<LineDraft>) =>
    onChange(lines.map((l) => (l.key === key ? { ...l, ...changes } : l)));
  const addLine = () => {
    const line = blankLine();
    // Offer the amount that balances the entry
    if (difference > 0) line.credit = formatMoney(difference);
    if (difference < 0) line.debit = formatMoney(-difference);
    onChange([...lines, line]);
  };

  return (
    <table className="lines">
      <thead>
        <tr>
          <th>Account</th>
          <th className="num">Debit</th>
          <th className="num">Credit</th>
          <th>Line memo</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => (
          <tr key={l.key}>
            <td>
              <AccountSelect
                accounts={props.accounts}
                value={l.accountId}
                onChange={(accountId) => setLine(l.key, { accountId })}
              />
            </td>
            <td>
              <MoneyInput
                ariaLabel={`Line ${i + 1} debit`}
                value={l.debit}
                onChange={(debit) =>
                  setLine(l.key, debit.trim() ? { debit, credit: '' } : { debit })
                }
              />
            </td>
            <td>
              <MoneyInput
                ariaLabel={`Line ${i + 1} credit`}
                value={l.credit}
                onChange={(credit) =>
                  setLine(l.key, credit.trim() ? { credit, debit: '' } : { credit })
                }
              />
            </td>
            <td>
              <input
                aria-label={`Line ${i + 1} memo`}
                value={l.memo}
                onChange={(e) => setLine(l.key, { memo: e.target.value })}
              />
            </td>
            <td>
              {lines.length > 2 && (
                <button
                  type="button"
                  className="link muted"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => onChange(lines.filter((x) => x.key !== l.key))}
                >
                  ✕
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <td>
            <button type="button" className="link" onClick={addLine}>
              + Add line
            </button>
          </td>
          <td className="num">{formatMoney(debits)}</td>
          <td className="num">{formatMoney(credits)}</td>
          <td colSpan={2} className={difference === 0 ? 'muted' : 'error-text'}>
            {difference === 0
              ? debits > 0
                ? 'Balanced'
                : ''
              : `Out of balance by ${formatMoney(Math.abs(difference))}`}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}
