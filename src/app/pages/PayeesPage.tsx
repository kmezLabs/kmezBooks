// Payees (GL-11): the names on transactions, with customer (AR-1) and vendor
// (AP-1) records. Rename a payee everywhere, merge two spellings into one,
// make one inactive, or see its transactions in the register.

import { useEffect, useState } from 'react';
import type { Payee, PayeeInput, PayeeKind } from '../../ledger/payees';
import type { AccountRow } from '../../shared/accounts';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import { AccountSelect, formatDate } from '../ledgerUi';
import { Dialog, ErrorText, TextField, useAction } from '../ui';

const KINDS: Record<PayeeKind, string> = {
  all: 'All',
  customers: 'Customers',
  vendors: 'Vendors',
  other: 'Other names',
};

/** Rows shown at once; search narrows a long list */
const SHOWN = 500;

export function PayeesPage(props: {
  status: SessionStatus;
  onShowTransactions: (payee: { id: string; name: string }) => void;
}) {
  const [kind, setKind] = useState<PayeeKind>('all');
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [payees, setPayees] = useState<Payee[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [editing, setEditing] = useState<Payee | 'new' | null>(null);
  const [version, setVersion] = useState(0);
  const readOnly = props.status.readOnly;

  useEffect(() => {
    void db.accounts().then(setAccounts);
  }, [props.status.companyId, props.status.lastSavedAt]);

  useEffect(() => {
    let current = true;
    const t = setTimeout(() => {
      void db.payees({ kind, search, includeInactive }).then((list) => current && setPayees(list));
    }, 150);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [kind, search, includeInactive, props.status.lastSavedAt, version]);

  const close = () => {
    setEditing(null);
    setVersion((v) => v + 1);
  };

  return (
    <section className="payees">
      <h2>Payees</h2>
      <p className="muted">
        Everyone named on your transactions: customers, vendors, and other names. Renaming a payee
        renames it on every transaction; to bring two spellings together, open one and merge it into
        the other.
      </p>
      <div className="buttons">
        {(Object.keys(KINDS) as PayeeKind[]).map((k) => (
          <button key={k} className={k === kind ? '' : 'secondary'} onClick={() => setKind(k)}>
            {KINDS[k]}
          </button>
        ))}
        {!readOnly && (
          <button className="secondary" onClick={() => setEditing('new')}>
            New payee
          </button>
        )}
      </div>
      <div className="fields">
        <label>
          Search
          <input
            value={search}
            placeholder="Name, contact or email"
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="check inline">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          Show inactive
        </label>
      </div>
      {payees &&
        (payees.length === 0 ? (
          <p className="muted">No payees match.</p>
        ) : (
          <>
            <table className="list payee-list">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Contact</th>
                  <th className="num">Transactions</th>
                  <th>Last used</th>
                </tr>
              </thead>
              <tbody>
                {payees.slice(0, SHOWN).map((p) => (
                  <tr
                    key={p.id}
                    className={p.active ? 'clickable' : 'clickable inactive'}
                    onClick={() => setEditing(p)}
                  >
                    <td>
                      {p.name} {p.isCustomer && <span className="badge small">customer</span>}{' '}
                      {p.isVendor && <span className="badge small">vendor</span>}{' '}
                      {p.is1099 && <span className="badge small">1099</span>}{' '}
                      {!p.active && <span className="badge small">inactive</span>}
                    </td>
                    <td className="muted">
                      {[p.contactName, p.email, p.phone].filter(Boolean).join(' · ')}
                    </td>
                    <td className="num">{p.uses ? p.uses.toLocaleString('en-US') : ''}</td>
                    <td className="nowrap">{formatDate(p.lastUsed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {payees.length > SHOWN && (
              <p className="muted">
                Showing {SHOWN} of {payees.length.toLocaleString('en-US')}. Search to find others.
              </p>
            )}
          </>
        ))}
      {editing && (
        <PayeeDialog
          payee={editing === 'new' ? null : editing}
          kind={kind}
          accounts={accounts}
          readOnly={readOnly}
          onClose={close}
          onShowTransactions={(p) => {
            setEditing(null);
            props.onShowTransactions(p);
          }}
        />
      )}
    </section>
  );
}

const draftOf = (p: Payee | null, kind: PayeeKind) => ({
  name: p?.name ?? '',
  isCustomer: p ? p.isCustomer : kind === 'customers',
  isVendor: p ? p.isVendor : kind === 'vendors',
  contactName: p?.contactName ?? '',
  email: p?.email ?? '',
  phone: p?.phone ?? '',
  address: p?.address ?? '',
  shippingAddress: p?.shippingAddress ?? '',
  accountNumber: p?.accountNumber ?? '',
  termsDays: p?.termsDays === null || p?.termsDays === undefined ? '' : String(p.termsDays),
  defaultAccountId: p?.defaultAccountId ?? '',
  is1099: p?.is1099 ?? false,
  notes: p?.notes ?? '',
  active: p?.active ?? true,
});

function PayeeDialog(props: {
  payee: Payee | null;
  kind: PayeeKind;
  accounts: AccountRow[];
  readOnly: boolean;
  onClose: () => void;
  onShowTransactions: (payee: { id: string; name: string }) => void;
}) {
  const p = props.payee;
  const [d, setD] = useState(() => draftOf(p, props.kind));
  const [merging, setMerging] = useState(false);
  const { busy, error, setError, run } = useAction();
  const set = (changes: Partial<typeof d>) => setD({ ...d, ...changes });

  const save = () => {
    const terms = d.termsDays.trim();
    if (terms && !/^\d+$/.test(terms)) {
      setError('Terms are a number of days.');
      return;
    }
    const input: PayeeInput = {
      ...d,
      termsDays: terms ? Number(terms) : null,
      defaultAccountId: d.defaultAccountId || null,
    };
    void run(async () => {
      if (p) await db.updatePayee(p.id, input);
      else await db.createPayee(input);
      props.onClose();
    });
  };

  const renamed = p && d.name.trim() && d.name.trim() !== p.name;

  return (
    <Dialog title={p ? p.name : 'New payee'} onClose={busy ? undefined : props.onClose}>
      {p && (
        <p className="muted">
          {p.uses
            ? `On ${p.uses.toLocaleString('en-US')} transaction${p.uses === 1 ? '' : 's'}, last ${formatDate(p.lastUsed)}.`
            : 'Not on any transaction yet.'}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextField
          label="Name"
          value={d.name}
          onChange={(name) => set({ name })}
          autoFocus={!p}
          hint={
            renamed && p.uses
              ? `Saving renames it on all ${p.uses.toLocaleString('en-US')} transactions.`
              : undefined
          }
        />
        <div className="fields">
          <label className="check inline">
            <input
              type="checkbox"
              checked={d.isCustomer}
              onChange={(e) => set({ isCustomer: e.target.checked })}
            />
            Customer
          </label>
          <label className="check inline">
            <input
              type="checkbox"
              checked={d.isVendor}
              onChange={(e) => set({ isVendor: e.target.checked })}
            />
            Vendor
          </label>
          <label className="check inline">
            <input
              type="checkbox"
              checked={d.active}
              onChange={(e) => set({ active: e.target.checked })}
            />
            Active
          </label>
        </div>
        <div className="fields">
          <TextField
            label="Contact name"
            value={d.contactName}
            onChange={(contactName) => set({ contactName })}
          />
          <TextField label="Email" value={d.email} onChange={(email) => set({ email })} />
          <TextField label="Phone" value={d.phone} onChange={(phone) => set({ phone })} />
        </div>
        <div className="fields">
          <label>
            {d.isCustomer ? 'Billing address' : 'Address'}
            <textarea
              rows={3}
              value={d.address}
              onChange={(e) => set({ address: e.target.value })}
            />
          </label>
          {d.isCustomer && (
            <label>
              Shipping address
              <textarea
                rows={3}
                value={d.shippingAddress}
                onChange={(e) => set({ shippingAddress: e.target.value })}
              />
            </label>
          )}
        </div>
        <div className="fields">
          {(d.isCustomer || d.isVendor) && (
            <TextField
              label="Terms (days)"
              value={d.termsDays}
              onChange={(termsDays) => set({ termsDays })}
              width="short"
              hint="e.g. 30 for net 30"
            />
          )}
          {d.isVendor && (
            <>
              <TextField
                label="Account number"
                value={d.accountNumber}
                onChange={(accountNumber) => set({ accountNumber })}
                hint="Yours with this vendor"
              />
              <AccountSelect
                label="Default category"
                accounts={props.accounts}
                value={d.defaultAccountId}
                onChange={(defaultAccountId) => set({ defaultAccountId })}
                emptyLabel="None"
              />
            </>
          )}
        </div>
        {d.isVendor && (
          <label className="check">
            <input
              type="checkbox"
              checked={d.is1099}
              onChange={(e) => set({ is1099: e.target.checked })}
            />
            <span>
              Track for 1099
              <span className="hint"> Marks the vendor only; no 1099 forms yet.</span>
            </span>
          </label>
        )}
        <label>
          Notes
          <textarea rows={2} value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          {!props.readOnly && (
            <button type="submit" disabled={busy}>
              Save
            </button>
          )}
          <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
          {p && p.uses > 0 && (
            <button
              type="button"
              className="secondary"
              onClick={() => props.onShowTransactions({ id: p.id, name: p.name })}
            >
              Show transactions
            </button>
          )}
          {p && !props.readOnly && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() => setMerging(true)}
            >
              Merge into…
            </button>
          )}
          {p && !props.readOnly && p.uses === 0 && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!confirm(`Delete ${p.name}?`)) return;
                  await db.deletePayee(p.id);
                  props.onClose();
                })
              }
            >
              Delete
            </button>
          )}
        </div>
      </form>
      {merging && p && (
        <MergeDialog payee={p} onClose={() => setMerging(false)} onMerged={props.onClose} />
      )}
    </Dialog>
  );
}

function MergeDialog(props: { payee: Payee; onClose: () => void; onMerged: () => void }) {
  const [names, setNames] = useState<Payee[]>([]);
  const [into, setInto] = useState('');
  const { busy, error, setError, run } = useAction();
  useEffect(() => {
    void db
      .payees({ includeInactive: true })
      .then((list) => setNames(list.filter((x) => x.id !== props.payee.id)));
  }, [props.payee.id]);
  const target = names.find((x) => x.name.toLowerCase() === into.trim().toLowerCase());

  return (
    <Dialog title={`Merge ${props.payee.name}`} onClose={busy ? undefined : props.onClose}>
      <p>
        Its {props.payee.uses.toLocaleString('en-US')} transaction
        {props.payee.uses === 1 ? '' : 's'} and any bank rules that name it move to the payee you
        choose, which keeps its own details and fills in what it lacks from this one. Then{' '}
        {props.payee.name} is removed. This can&rsquo;t be undone, though the audit log keeps every
        change.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!target) {
            setError('Choose a payee from the list.');
            return;
          }
          void run(async () => {
            await db.mergePayee(props.payee.id, target.id);
            props.onMerged();
          });
        }}
      >
        <label>
          Merge into
          <input
            list="merge-into"
            value={into}
            autoFocus
            autoComplete="off"
            onChange={(e) => setInto(e.target.value)}
          />
          <datalist id="merge-into">
            {names.map((n) => (
              <option key={n.id} value={n.name} />
            ))}
          </datalist>
        </label>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy || !target}>
            Merge
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
