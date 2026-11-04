// The debit and credit lines of a journal entry, as typed: used by the journal
// entry form and by recurring entries (GL-4, GL-5). Amounts stay text until
// saved; lineTotals() says whether they balance. The pure helpers live in
// lineDrafts.ts, so they can be tested without a browser.

import type { AccountRow } from '../shared/accounts';
import { formatMoney } from '../shared/money';
import { AccountSelect, MoneyInput } from './ledgerUi';
import { blankLine, lineTotals, type LineDraft } from './lineDrafts';

export { blankLine, lineTotals, linesFrom, linesToCents, type LineDraft } from './lineDrafts';

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
