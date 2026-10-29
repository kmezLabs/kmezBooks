// The lines of an invoice or estimate, and of a recurring invoice (AR-4,
// AR-9): a product or service fills description, rate and income account;
// quantity × rate fills the amount; a discount is a negative line. Amounts
// stay text while typed and become cents on save.

import { AccountSelect, MoneyInput } from '../../app/ledgerUi';
import { Combo } from '../../app/Combo';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney, parseMoney } from '../../shared/money';
import type { DocLineInput } from './documents';
import type { Item } from './items';
import { formatQuantity, lineAmount, parseQuantity } from './math';

export interface LineRow {
  key: number;
  itemId: string | null;
  description: string;
  quantity: string;
  rate: string;
  amount: string;
  accountId: string;
}

let nextKey = 1;
export const blankRow = (accountId = ''): LineRow => ({
  key: nextKey++,
  itemId: null,
  description: '',
  quantity: '',
  rate: '',
  amount: '',
  accountId,
});

export const rowsFrom = (lines: DocLineInput[]): LineRow[] =>
  lines.map((l) => ({
    key: nextKey++,
    itemId: l.itemId,
    description: l.description ?? '',
    quantity: l.quantity === null ? '' : formatQuantity(l.quantity),
    rate: l.rate === null ? '' : formatMoney(l.rate),
    amount: formatMoney(l.amount),
    accountId: l.incomeAccountId,
  }));

/** The rows as lines in cents, skipping empty ones; null if a number doesn't read. */
export function linesFromRows(rows: LineRow[]): DocLineInput[] | null {
  const lines: DocLineInput[] = [];
  for (const r of rows) {
    if (!r.amount.trim() && !r.itemId && !r.description.trim()) continue;
    const amount = parseMoney(r.amount);
    const quantity = r.quantity.trim() ? parseQuantity(r.quantity) : null;
    const rate = r.rate.trim() ? parseMoney(r.rate) : null;
    if (
      amount === null ||
      (r.quantity.trim() && quantity === null) ||
      (r.rate.trim() && rate === null)
    ) {
      return null;
    }
    lines.push({
      itemId: r.itemId,
      description: r.description,
      quantity,
      rate,
      amount,
      incomeAccountId: r.accountId,
    });
  }
  return lines;
}

export const LINES_ERROR =
  'Each line needs an amount (and quantity and rate as numbers, if given).';

/** The account a new line starts with: Services, else Sales, else the first income account. */
export function defaultIncomeAccount(accounts: AccountRow[]): string {
  const income = accounts.filter((a) => a.type === 'income');
  return (
    income.find((a) => a.name === 'Services')?.id ??
    income.find((a) => a.name === 'Sales')?.id ??
    income[0]?.id ??
    ''
  );
}

export function DocLinesTable(props: {
  rows: LineRow[];
  onChange: (rows: LineRow[]) => void;
  accounts: AccountRow[];
  items: Item[];
  /** An invoice with payments: its lines are fixed */
  locked?: boolean;
}) {
  const { rows, onChange, items, locked } = props;
  const income = props.accounts.filter((a) => a.type === 'income');
  const defaultAccount = defaultIncomeAccount(props.accounts);

  const setRow = (key: number, c: Partial<LineRow>) =>
    onChange(
      rows.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...c };
        // Quantity × rate fills the amount; an amount typed directly stays
        if (('quantity' in c || 'rate' in c) && next.quantity.trim() && next.rate.trim()) {
          const q = parseQuantity(next.quantity);
          const rate = parseMoney(next.rate);
          if (q !== null && rate !== null) next.amount = formatMoney(lineAmount(q, rate));
        }
        return next;
      }),
    );
  const chooseItem = (key: number, itemId: string) => {
    const it = items.find((i) => i.id === itemId);
    const row = rows.find((r) => r.key === key)!;
    if (!it) return setRow(key, { itemId: null });
    const quantity = row.quantity.trim() || '1';
    const q = parseQuantity(quantity);
    onChange(
      rows.map((r) =>
        r.key === key
          ? {
              ...r,
              itemId: it.id,
              description: it.description ?? it.name,
              accountId: it.incomeAccountId,
              quantity,
              rate: it.rate === null ? r.rate : formatMoney(it.rate),
              amount:
                it.rate !== null && q !== null ? formatMoney(lineAmount(q, it.rate)) : r.amount,
            }
          : r,
      ),
    );
  };
  const total = rows.reduce((s, r) => s + (parseMoney(r.amount) ?? 0), 0);

  return (
    <table className="lines doc-lines">
      <thead>
        <tr>
          <th>Product or service</th>
          <th>Description</th>
          <th className="num">Qty</th>
          <th className="num">Rate</th>
          <th className="num">Amount</th>
          <th>Income account</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={r.key}>
            <td>
              <Combo
                options={items.map((it) => ({
                  value: it.id,
                  label: it.name,
                  keys: [it.name],
                }))}
                value={r.itemId ?? ''}
                onChange={(id) => chooseItem(r.key, id)}
                emptyLabel="—"
                ariaLabel={`Line ${i + 1} product or service`}
              />
            </td>
            <td>
              <input
                aria-label={`Line ${i + 1} description`}
                value={r.description}
                disabled={locked}
                onChange={(e) => setRow(r.key, { description: e.target.value })}
              />
            </td>
            <td className="qty">
              <input
                className="money"
                aria-label={`Line ${i + 1} quantity`}
                value={r.quantity}
                disabled={locked}
                onChange={(e) => setRow(r.key, { quantity: e.target.value })}
              />
            </td>
            <td>
              <MoneyInput
                ariaLabel={`Line ${i + 1} rate`}
                value={r.rate}
                onChange={(rate) => setRow(r.key, { rate })}
              />
            </td>
            <td>
              <MoneyInput
                ariaLabel={`Line ${i + 1} amount`}
                value={r.amount}
                onChange={(amount) => setRow(r.key, { amount })}
              />
            </td>
            <td>
              <AccountSelect
                accounts={income}
                value={r.accountId}
                onChange={(accountId) => setRow(r.key, { accountId })}
              />
            </td>
            <td>
              {rows.length > 1 && !locked && (
                <button
                  type="button"
                  className="link muted"
                  aria-label={`Remove line ${i + 1}`}
                  onClick={() => onChange(rows.filter((x) => x.key !== r.key))}
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
          <td colSpan={4}>
            {!locked && (
              <>
                <button
                  type="button"
                  className="link"
                  onClick={() => onChange([...rows, blankRow(defaultAccount)])}
                >
                  + Add line
                </button>{' '}
                <button
                  type="button"
                  className="link"
                  title="A negative line, e.g. -50.00, reducing the total"
                  onClick={() =>
                    onChange([
                      ...rows,
                      {
                        ...blankRow(
                          income.find((a) => a.name === 'Discounts Given')?.id ?? defaultAccount,
                        ),
                        description: 'Discount',
                        amount: '-',
                      },
                    ])
                  }
                >
                  + Add discount
                </button>
              </>
            )}
          </td>
          <td className="num">
            <strong>{formatMoney(total)}</strong>
          </td>
          <td colSpan={2} />
        </tr>
      </tfoot>
    </table>
  );
}
