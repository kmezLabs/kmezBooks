// Small pieces shared by the sales screens: the customer picker (with quick
// add) and how a document's state reads.

import { useEffect, useState } from 'react';
import type { Payee } from '../../ledger/payees';
import { Combo, type ComboAction, type ComboOption } from '../../app/Combo';
import { QuickPayeeDialog } from '../../app/QuickPayee';
import { db } from '../../shared/workerClient';
import type { DocState } from './documents';

export const STATE_LABELS: Record<DocState, string> = {
  draft: 'draft',
  sent: 'sent',
  partial: 'partly paid',
  paid: 'paid',
  overdue: 'overdue',
  accepted: 'accepted',
  declined: 'declined',
  void: 'void',
};

export function StateBadge({ state }: { state: DocState }) {
  const warn = state === 'overdue';
  const quiet = state === 'void' || state === 'declined';
  return (
    <span className={`badge small${warn ? ' warn' : ''}${quiet ? ' muted' : ''}`}>
      {STATE_LABELS[state]}
    </span>
  );
}

/**
 * A customer: any payee, customers first, typed to filter. A new name can be
 * added as a customer on the spot (GL-11 quick add).
 */
export function CustomerSelect(props: {
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
  const ordered = [...payees].sort(
    (a, b) => Number(b.isCustomer) - Number(a.isCustomer) || a.name.localeCompare(b.name),
  );
  const options: ComboOption[] = ordered.map((p) => ({
    value: p.id,
    label: p.name,
    group: p.isCustomer ? 'Customers' : 'Other payees',
    keys: [p.name],
  }));
  const actions = (typed: string): ComboAction[] =>
    payees.some((p) => p.name.toLowerCase() === typed.toLowerCase())
      ? []
      : [{ label: `+ Add “${typed}” as a customer…`, run: () => setAdding(typed) }];

  const combo = (
    <Combo
      options={options}
      value={props.value}
      onChange={(id) => {
        const p = payees.find((x) => x.id === id);
        if (p) props.onChange(p);
      }}
      emptyLabel="Choose a customer…"
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
          kind="customer"
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
