// Chart of accounts (GL-1, GL-2, GL-7).

import { Fragment, useEffect, useState } from 'react';
import {
  ACCOUNT_TYPES,
  TYPE_LABELS,
  detailType,
  detailTypesFor,
  validateAccount,
  type AccountInput,
  type AccountRow,
  type AccountType,
} from '../../shared/accounts';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { AccountSelect, displayBalance } from '../ledgerUi';
import { Dialog, ErrorText, TextField, useAction } from '../ui';

function descendants(accounts: AccountRow[], id: string): Set<string> {
  const out = new Set([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const a of accounts) {
      if (a.parentId && out.has(a.parentId) && !out.has(a.id)) {
        out.add(a.id);
        grew = true;
      }
    }
  }
  return out;
}

function AccountDialog(props: {
  account: AccountRow | null;
  accounts: AccountRow[];
  onClose: () => void;
  onShowEntries: (accountId: string) => void;
}) {
  const a = props.account;
  const [form, setForm] = useState<AccountInput>({
    name: a?.name ?? '',
    number: a?.number ?? '',
    type: a?.type ?? 'expense',
    detailType: a?.detailType ?? 'other_expense',
    parentId: a?.parentId ?? null,
    description: a?.description ?? '',
  });
  const { busy, error, setError, run } = useAction();
  const set = (changes: Partial<AccountInput>) => setForm({ ...form, ...changes });

  const setType = (type: AccountType) =>
    set({ type, detailType: detailTypesFor(type)[0]!.code, parentId: null });

  const save = () => {
    const problems = validateAccount(form);
    if (problems.length) {
      setError(problems.join(' '));
      return;
    }
    void run(async () => {
      if (a) await db.updateAccount(a.id, form);
      else await db.createAccount(form);
      props.onClose();
    });
  };

  return (
    <Dialog
      title={a ? `Account: ${a.fullName}` : 'New account'}
      onClose={busy ? undefined : props.onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="fields">
          <TextField
            label="Name"
            value={form.name}
            onChange={(name) => set({ name })}
            autoFocus={!a}
            width="long"
          />
          <TextField
            label="Number"
            value={form.number ?? ''}
            onChange={(number) => set({ number })}
            width="short"
            hint="Optional"
          />
        </div>
        <div className="fields">
          <label>
            Type
            <select
              value={form.type}
              disabled={a?.hasHistory}
              onChange={(e) => setType(e.target.value as AccountType)}
            >
              {ACCOUNT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            {a?.hasHistory && <span className="hint">Fixed: the account has transactions.</span>}
          </label>
          <label>
            Detail type
            <select value={form.detailType} onChange={(e) => set({ detailType: e.target.value })}>
              {detailTypesFor(form.type).map((t) => (
                <option key={t.code} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="fields">
          <AccountSelect
            label="Sub-account of"
            accounts={props.accounts}
            value={form.parentId ?? ''}
            onChange={(parentId) => set({ parentId: parentId || null })}
            onlyType={form.type}
            exclude={a ? descendants(props.accounts, a.id) : undefined}
            emptyLabel="(none: a top-level account)"
          />
        </div>
        <div className="fields">
          <TextField
            label="Description"
            value={form.description ?? ''}
            onChange={(description) => set({ description })}
          />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy}>
            {a ? 'Save account' : 'Add account'}
          </button>
          {a && (
            <>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await db.setAccountActive(a.id, !a.active);
                    props.onClose();
                  })
                }
              >
                {a.active ? 'Make inactive' : 'Make active'}
              </button>
              {!a.hasHistory && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      await db.deleteAccount(a.id);
                      props.onClose();
                    })
                  }
                >
                  Delete
                </button>
              )}
              {a.hasHistory && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => props.onShowEntries(a.id)}
                >
                  Show entries
                </button>
              )}
            </>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
        </div>
        {a?.hasHistory && (
          <p className="muted">
            An account with transactions can't be deleted; make it inactive to hide it from new
            entries (GL-7).
          </p>
        )}
      </form>
    </Dialog>
  );
}

export function AccountsPage(props: {
  status: SessionStatus;
  onShowEntries: (accountId: string) => void;
}) {
  const [accounts, setAccounts] = useState<AccountRow[] | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<AccountRow | 'new' | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    void db.accounts().then(setAccounts);
  }, [props.status.companyId, props.status.lastSavedAt, editing]);

  if (!accounts) return null;
  const readOnly = props.status.readOnly;

  if (accounts.length === 0) {
    return (
      <section>
        <h2>Accounts</h2>
        <p>This company has no accounts yet.</p>
        <p className="muted">
          Add the standard chart for a US small business on a cash basis, or leave the chart empty
          if you'll bring this company's history over from QuickBooks: the import creates the
          accounts.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button
            disabled={busy || readOnly}
            onClick={() =>
              run(async () => {
                await db.seedChart();
                setAccounts(await db.accounts());
              })
            }
          >
            Add the standard chart of accounts
          </button>
          <button className="secondary" disabled={readOnly} onClick={() => setEditing('new')}>
            Add an account
          </button>
        </div>
        {editing && (
          <AccountDialog
            account={null}
            accounts={accounts}
            onClose={() => setEditing(null)}
            onShowEntries={props.onShowEntries}
          />
        )}
      </section>
    );
  }

  const visible = accounts.filter((a) => showInactive || a.active);
  const inactiveCount = accounts.length - accounts.filter((a) => a.active).length;

  return (
    <section>
      <h2>Accounts</h2>
      <div className="buttons">
        <button disabled={readOnly} onClick={() => setEditing('new')}>
          New account
        </button>
        {inactiveCount > 0 && (
          <label className="check inline">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
            />
            Show {inactiveCount} inactive
          </label>
        )}
      </div>
      <table className="list accounts">
        <thead>
          <tr>
            <th>Account</th>
            <th>Detail type</th>
            <th className="num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {ACCOUNT_TYPES.map((type) => {
            const rows = visible.filter((a) => a.type === type);
            if (rows.length === 0) return null;
            return (
              <Fragment key={type}>
                <tr className="group">
                  <td colSpan={3}>{TYPE_LABELS[type]}</td>
                </tr>
                {rows.map((a) => (
                  <tr
                    key={a.id}
                    className={a.active ? 'clickable' : 'clickable inactive'}
                    onClick={() => !readOnly && setEditing(a)}
                  >
                    <td style={{ paddingLeft: `${0.5 + a.depth * 1.25}rem` }}>
                      {a.number && <span className="muted">{a.number} </span>}
                      {a.name}
                      {!a.active && <span className="badge small">inactive</span>}
                    </td>
                    <td className="muted">{detailType(a.detailType)?.name ?? a.detailType}</td>
                    <td className="num">{a.hasHistory ? displayBalance(a) : ''}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="muted">
        Balances are posted entries to date, shown on each account's normal side. Click an account
        to edit it.
      </p>
      {editing && (
        <AccountDialog
          account={editing === 'new' ? null : editing}
          accounts={accounts}
          onClose={() => setEditing(null)}
          onShowEntries={props.onShowEntries}
        />
      )}
    </section>
  );
}
