// Quick add of a customer or vendor from a payee field (GL-11, AR-1, AP-1):
// a small dialog over the transaction being entered, so the new payee is in
// the list, with its default category, without leaving the transaction.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PayeeInput } from '../ledger/payees';
import type { AccountRow } from '../shared/accounts';
import { db } from '../shared/workerClient';
import { AccountSelect } from './ledgerUi';
import { Dialog, ErrorText, TextField, useAction } from './ui';

export interface QuickPayeeResult {
  name: string;
  /** A vendor's default category, to fill into the transaction */
  defaultAccountId: string | null;
}

export function QuickPayeeDialog(props: {
  name: string;
  kind: 'vendor' | 'customer';
  onSaved: (p: QuickPayeeResult) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(props.name);
  const [isVendor, setIsVendor] = useState(props.kind === 'vendor');
  const [isCustomer, setIsCustomer] = useState(props.kind === 'customer');
  const [category, setCategory] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const { busy, error, run } = useAction();

  useEffect(() => {
    void db.accounts().then(setAccounts);
  }, []);

  const save = () =>
    void run(async () => {
      const input: PayeeInput = {
        name,
        isCustomer,
        isVendor,
        contactName: null,
        email: email || null,
        phone: phone || null,
        address: null,
        shippingAddress: null,
        accountNumber: null,
        termsDays: null,
        defaultAccountId: isVendor && category ? category : null,
        is1099: false,
        notes: null,
        active: true,
      };
      await db.createPayee(input);
      props.onSaved({
        name: name.trim().replace(/\s+/g, ' '),
        defaultAccountId: input.defaultAccountId,
      });
    });

  // Drawn at the page's root, outside the transaction's own form; its events
  // still bubble through React to that form, so submit and Escape stop here
  return createPortal(
    <Dialog
      title={`New ${isVendor && !isCustomer ? 'vendor' : isCustomer && !isVendor ? 'customer' : 'payee'}`}
      onClose={busy ? undefined : props.onClose}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          save();
        }}
      >
        <TextField label="Name" value={name} onChange={setName} autoFocus />
        <div className="fields">
          <label className="check inline">
            <input
              type="checkbox"
              checked={isVendor}
              onChange={(e) => setIsVendor(e.target.checked)}
            />
            Vendor
          </label>
          <label className="check inline">
            <input
              type="checkbox"
              checked={isCustomer}
              onChange={(e) => setIsCustomer(e.target.checked)}
            />
            Customer
          </label>
        </div>
        {isVendor && (
          <AccountSelect
            label="Default category"
            accounts={accounts.filter((a) => a.type !== 'asset' && a.type !== 'liability')}
            value={category}
            onChange={setCategory}
            emptyLabel="None"
          />
        )}
        <div className="fields">
          <TextField label="Email" value={email} onChange={setEmail} />
          <TextField label="Phone" value={phone} onChange={setPhone} />
        </div>
        <p className="muted small">More details (address, terms, 1099) are on the Payees page.</p>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy || !name.trim()}>
            Add{' '}
            {isVendor && !isCustomer ? 'vendor' : isCustomer && !isVendor ? 'customer' : 'payee'}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>,
    document.body,
  );
}
