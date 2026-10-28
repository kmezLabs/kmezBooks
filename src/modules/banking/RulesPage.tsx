// Bank rules (BK-5): suggest a category, payee and memo for imported
// transactions by payee or description text, amount, direction and account.
// The first matching rule in the list wins; a rule can also post on import.

import { useEffect, useState } from 'react';
import { AccountSelect, MoneyInput, PayeeField, cents } from '../../app/ledgerUi';
import { Dialog, ErrorText, TextField, useAction } from '../../app/ui';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney } from '../../shared/money';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import type { BankAccount } from './bankAccounts';
import type { Direction, RuleInput, RuleRow } from './rules';

const DIRECTIONS: Record<Direction, string> = {
  any: 'Money in or out',
  out: 'Money out (spent, charges)',
  in: 'Money in (received, payments)',
};

export function RulesPage({ status }: { status: SessionStatus }) {
  const [rules, setRules] = useState<RuleRow[] | null>(null);
  const [ledger, setLedger] = useState<AccountRow[]>([]);
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [editing, setEditing] = useState<RuleRow | 'new' | null>(null);
  const [version, setVersion] = useState(0);
  const { busy, error, run } = useAction();
  const readOnly = status.readOnly;

  useEffect(() => {
    void db.bankRules().then(setRules);
    void db.accounts().then(setLedger);
    void db.bankAccounts().then(setBanks);
  }, [status.companyId, status.lastSavedAt, version]);

  if (!rules) return null;
  const names = new Map(ledger.map((a) => [a.id, a.fullName]));
  const changed = () => setVersion((v) => v + 1);

  return (
    <section>
      <h2>Bank rules</h2>
      <p className="muted">
        Rules suggest how to add imported transactions to the books. The first rule in the list that
        fits a transaction wins, so put specific rules above general ones. A rule set to add
        automatically adds matching transactions as they are imported.
      </p>
      {!readOnly && (
        <div className="buttons">
          <button onClick={() => setEditing('new')}>New rule</button>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {rules.length === 0 ? (
        <p className="muted">No rules yet.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Rule</th>
              <th>When</th>
              <th>Then</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rules.map((r, i) => (
              <tr key={r.id} className={r.active ? undefined : 'inactive'}>
                <td>
                  <strong>{r.name}</strong>
                  {!r.active && <span className="badge small">off</span>}
                  {r.autoPost && <span className="badge small">adds automatically</span>}
                </td>
                <td>{conditions(r, names)}</td>
                <td>
                  {names.get(r.categoryId) ?? '?'}
                  {r.payee && <span className="muted"> · payee “{r.payee}”</span>}
                  {r.memo && <span className="muted"> · memo “{r.memo}”</span>}
                </td>
                <td className="actions">
                  {!readOnly && (
                    <>
                      <button
                        className="link"
                        disabled={busy || i === 0}
                        aria-label={`Move ${r.name} up`}
                        onClick={() =>
                          void run(async () => {
                            await db.bankMoveRule(r.id, 'up');
                            changed();
                          })
                        }
                      >
                        ↑
                      </button>
                      <button
                        className="link"
                        disabled={busy || i === rules.length - 1}
                        aria-label={`Move ${r.name} down`}
                        onClick={() =>
                          void run(async () => {
                            await db.bankMoveRule(r.id, 'down');
                            changed();
                          })
                        }
                      >
                        ↓
                      </button>
                      <button className="link" onClick={() => setEditing(r)}>
                        Edit
                      </button>
                      <button
                        className="link muted"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            if (!confirm(`Delete the rule “${r.name}”?`)) return;
                            await db.bankDeleteRule(r.id);
                            changed();
                          })
                        }
                      >
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <RuleDialog
          rule={editing === 'new' ? null : editing}
          ledger={ledger}
          banks={banks}
          onClose={(saved) => {
            setEditing(null);
            if (saved) changed();
          }}
        />
      )}
    </section>
  );
}

function conditions(r: RuleRow, names: Map<string, string>): string {
  const parts: string[] = [];
  if (r.textContains) parts.push(`payee or description contains “${r.textContains}”`);
  if (r.direction !== 'any') parts.push(r.direction === 'in' ? 'money in' : 'money out');
  if (r.amountMin !== null && r.amountMin === r.amountMax)
    parts.push(`amount is ${formatMoney(r.amountMin)}`);
  else {
    if (r.amountMin !== null) parts.push(`amount at least ${formatMoney(r.amountMin)}`);
    if (r.amountMax !== null) parts.push(`amount at most ${formatMoney(r.amountMax)}`);
  }
  if (r.accountId) parts.push(`in ${names.get(r.accountId) ?? '?'}`);
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function RuleDialog(props: {
  rule: RuleRow | null;
  ledger: AccountRow[];
  banks: BankAccount[];
  onClose: (saved: boolean) => void;
}) {
  const r = props.rule;
  const [name, setName] = useState(r?.name ?? '');
  const [textContains, setText] = useState(r?.textContains ?? '');
  const [direction, setDirection] = useState<Direction>(r?.direction ?? 'any');
  const [amountMin, setMin] = useState(r?.amountMin != null ? formatMoney(r.amountMin) : '');
  const [amountMax, setMax] = useState(r?.amountMax != null ? formatMoney(r.amountMax) : '');
  const [accountId, setAccount] = useState(r?.accountId ?? '');
  const [categoryId, setCategory] = useState(r?.categoryId ?? '');
  const [payee, setPayee] = useState(r?.payee ?? '');
  const [memo, setMemo] = useState(r?.memo ?? '');
  const [autoPost, setAutoPost] = useState(r?.autoPost ?? false);
  const [active, setActive] = useState(r?.active ?? true);
  const { busy, error, run } = useAction();

  const input = (): RuleInput => ({
    name,
    active,
    accountId: accountId || null,
    direction,
    textContains: textContains || null,
    amountMin: amountMin.trim() ? cents(amountMin) : null,
    amountMax: amountMax.trim() ? cents(amountMax) : null,
    categoryId,
    payee: payee || null,
    memo: memo || null,
    autoPost,
  });

  return (
    <Dialog
      title={r ? `Edit rule “${r.name}”` : 'New rule'}
      onClose={busy ? undefined : () => props.onClose(false)}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            if (r) await db.bankUpdateRule(r.id, input());
            else await db.bankCreateRule(input());
            props.onClose(true);
          });
        }}
      >
        <TextField label="Name" value={name} onChange={setName} autoFocus />
        <h4>When a transaction</h4>
        <div className="fields">
          <TextField
            label="Payee or description contains"
            value={textContains}
            onChange={setText}
            hint="Ignoring capitals, e.g. “city power”"
          />
          <label>
            Direction
            <select value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
              {(Object.keys(DIRECTIONS) as Direction[]).map((d) => (
                <option key={d} value={d}>
                  {DIRECTIONS[d]}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="fields">
          <label className="short">
            Amount at least
            <MoneyInput ariaLabel="Amount at least" value={amountMin} onChange={setMin} />
          </label>
          <label className="short">
            At most
            <MoneyInput ariaLabel="Amount at most" value={amountMax} onChange={setMax} />
          </label>
          <label>
            In account
            <select value={accountId} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Any bank or card account</option>
              {props.banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <h4>Then</h4>
        <div className="fields">
          <AccountSelect
            label="Category"
            accounts={props.ledger}
            value={categoryId}
            onChange={setCategory}
          />
        </div>
        <div className="fields">
          <label>
            Payee
            <PayeeField value={payee} onChange={setPayee} />
            <span className="hint">Optional: replaces the bank’s payee</span>
          </label>
          <TextField label="Memo" value={memo} onChange={setMemo} hint="Optional" />
        </div>
        <label className="check">
          <input
            type="checkbox"
            checked={autoPost}
            onChange={(e) => setAutoPost(e.target.checked)}
          />
          <span>
            Add to the books automatically on import
            <span className="hint">
              Otherwise the rule only suggests. Transactions that might already be in the books are
              always left for review.
            </span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Rule is on</span>
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy}>
            Save rule
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => props.onClose(false)}
          >
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
