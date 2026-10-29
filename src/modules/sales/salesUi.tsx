// Small pieces shared by the sales screens: the customer picker (with quick
// add) and how a document's state reads.

import type { Payee } from '../../ledger/payees';
import { PartySelect } from '../../app/PartySelect';
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

/** A customer: any payee, customers first, with quick add (GL-11). */
export function CustomerSelect(props: {
  value: string;
  onChange: (payee: Payee) => void;
  label?: string;
}) {
  return <PartySelect kind="customer" {...props} />;
}
