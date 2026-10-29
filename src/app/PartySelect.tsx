// The customer or vendor picker on documents (AR-3, AP-2): any payee, the
// kind asked for first, with quick add (GL-11).

import { useEffect, useState } from 'react';
import type { Payee } from '../ledger/payees';
import { Combo, type ComboAction, type ComboOption } from './Combo';
import { QuickPayeeDialog } from './QuickPayee';
import { db } from '../shared/workerClient';

/**
 * A customer or a vendor: any payee, customers (or vendors) first, typed to
 * filter. A new name can be added on the spot (GL-11 quick add).
 */
export function PartySelect(props: {
  kind: 'customer' | 'vendor';
  value: string;
  onChange: (payee: Payee) => void;
  label?: string;
}) {
  const [payees, setPayees] = useState<Payee[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const load = () => db.payees({}).then(setPayees);
  useEffect(() => {
    void load();
  }, []);
  const isOne = (p: Payee) => (props.kind === 'customer' ? p.isCustomer : p.isVendor);
  const ordered = [...payees].sort(
    (a, b) => Number(isOne(b)) - Number(isOne(a)) || a.name.localeCompare(b.name),
  );
  const options: ComboOption[] = ordered.map((p) => ({
    value: p.id,
    label: p.name,
    group: isOne(p) ? (props.kind === 'customer' ? 'Customers' : 'Vendors') : 'Other payees',
    keys: [p.name],
  }));
  const actions = (typed: string): ComboAction[] =>
    payees.some((p) => p.name.toLowerCase() === typed.toLowerCase())
      ? []
      : [{ label: `+ Add “${typed}” as a ${props.kind}…`, run: () => setAdding(typed) }];

  const combo = (
    <Combo
      options={options}
      value={props.value}
      onChange={(id) => {
        const p = payees.find((x) => x.id === id);
        if (p) props.onChange(p);
      }}
      emptyLabel={`Choose a ${props.kind}…`}
      actions={actions}
    />
  );
  return (
    <>
      {props.label ? (
        <label>
          {props.label}
          {combo}
        </label>
      ) : (
        combo
      )}
      {adding !== null && (
        <QuickPayeeDialog
          name={adding}
          kind={props.kind}
          onClose={() => setAdding(null)}
          onSaved={async (saved) => {
            setAdding(null);
            const list = await db.payees({});
            setPayees(list);
            const p = list.find((x) => x.name.toLowerCase() === saved.name.toLowerCase());
            if (p) props.onChange(p);
          }}
        />
      )}
    </>
  );
}
