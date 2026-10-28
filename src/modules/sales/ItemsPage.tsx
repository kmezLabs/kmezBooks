// Products and services (AR-2): picked on invoice and estimate lines, filling
// in the description, rate and income account.

import { useEffect, useState } from 'react';
import { AccountSelect, MoneyInput } from '../../app/ledgerUi';
import { Dialog, ErrorText, TextField, useAction } from '../../app/ui';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney, parseMoney } from '../../shared/money';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import type { Item } from './items';

export function ItemsPage({ status }: { status: SessionStatus }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Item | 'new' | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void db.items(showInactive).then(setItems);
    void db.accounts().then(setAccounts);
  }, [status.companyId, status.lastSavedAt, showInactive, version]);

  if (!items) return null;
  const names = new Map(accounts.map((a) => [a.id, a.fullName]));

  return (
    <section>
      <h2>Products &amp; services</h2>
      <p className="muted">
        What you sell, with a rate and the income account it goes to. Pick them on invoice and
        estimate lines. No stock is tracked.
      </p>
      <div className="buttons">
        {!status.readOnly && (
          <button onClick={() => setEditing('new')}>New product or service</button>
        )}
        <label className="check inline">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>
      {items.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Description</th>
              <th className="num">Rate</th>
              <th>Income account</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr
                key={i.id}
                className={i.active ? 'clickable' : 'clickable inactive'}
                onClick={() => !status.readOnly && setEditing(i)}
              >
                <td>
                  {i.name} {!i.active && <span className="badge small">inactive</span>}
                </td>
                <td className="muted">{i.description}</td>
                <td className="num">{i.rate === null ? '' : formatMoney(i.rate)}</td>
                <td>{names.get(i.incomeAccountId) ?? '?'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <ItemDialog
          item={editing === 'new' ? null : editing}
          accounts={accounts}
          onClose={() => {
            setEditing(null);
            setVersion((v) => v + 1);
          }}
        />
      )}
    </section>
  );
}

function ItemDialog(props: { item: Item | null; accounts: AccountRow[]; onClose: () => void }) {
  const i = props.item;
  const income = props.accounts.filter((a) => a.type === 'income');
  const [name, setName] = useState(i?.name ?? '');
  const [description, setDescription] = useState(i?.description ?? '');
  const [rate, setRate] = useState(i?.rate === null || !i ? '' : formatMoney(i.rate));
  const [account, setAccount] = useState(
    i?.incomeAccountId ?? income.find((a) => a.name === 'Services' || a.name === 'Sales')?.id ?? '',
  );
  const [active, setActive] = useState(i?.active ?? true);
  const { busy, error, setError, run } = useAction();

  const save = () => {
    const cents = rate.trim() ? parseMoney(rate) : null;
    if (rate.trim() && cents === null) {
      setError('Enter the rate as an amount, e.g. 950.00.');
      return;
    }
    const input = { name, description, rate: cents, incomeAccountId: account, active };
    void run(async () => {
      if (i) await db.updateItem(i.id, input);
      else await db.createItem(input);
      props.onClose();
    });
  };

  return (
    <Dialog
      title={i ? i.name : 'New product or service'}
      onClose={busy ? undefined : props.onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} autoFocus={!i} />
        <TextField
          label="Description"
          value={description}
          onChange={setDescription}
          hint="Shown on the invoice line"
        />
        <div className="fields">
          <label className="short">
            Rate
            <MoneyInput ariaLabel="Rate" value={rate} onChange={setRate} />
            <span className="hint">Optional</span>
          </label>
          <AccountSelect
            label="Income account"
            accounts={income}
            value={account}
            onChange={setAccount}
          />
        </div>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy || !name.trim() || !account}>
            Save
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
