// An entry opened in place under its row in a list (Journal entries, General
// Ledger): its lines, where it came from, its attachments, and a button to
// open it in full for changes.

import { useEffect, useState } from 'react';
import { formatMoney } from '../shared/money';
import { db } from '../shared/workerClient';
import type { EntryView } from '../worker/companySession';
import { formatDate } from './ledgerUi';
import { formatDateTime } from './ui';

export const SOURCES: Record<string, string> = {
  journal: 'Journal entry',
  qbo_migration: 'From QuickBooks',
  bank: 'From bank review',
  register: 'Quick entry',
};

export function EntryPeek(props: { id: number; onOpen: () => void; lastSavedAt?: string | null }) {
  const [entry, setEntry] = useState<EntryView | null>(null);
  useEffect(() => {
    void db.entry(props.id).then(setEntry);
  }, [props.id, props.lastSavedAt]);
  if (!entry) return <p className="muted small">Loading…</p>;
  return (
    <div className="entry-peek">
      <p className="muted small">
        Entry {entry.id} · {formatDate(entry.date)}
        {entry.ref && ` · Ref ${entry.ref}`} · {SOURCES[entry.sourceType] ?? entry.sourceType}
        {entry.postedAt && ` · posted ${formatDateTime(entry.postedAt)}`}
        {entry.voidedAt &&
          ` · voided ${formatDateTime(entry.voidedAt)}${entry.voidReason ? `: ${entry.voidReason}` : ''}`}
      </p>
      {entry.memo && <p className="entry-peek-memo">{entry.memo}</p>}
      <table className="lines-peek">
        <thead>
          <tr>
            <th>Account</th>
            <th className="num">Debit</th>
            <th className="num">Credit</th>
            <th>Memo</th>
          </tr>
        </thead>
        <tbody>
          {entry.lines.map((l) => (
            <tr key={l.lineNo}>
              <td>{l.account}</td>
              <td className="num">{l.debit ? formatMoney(l.debit) : ''}</td>
              <td className="num">{l.credit ? formatMoney(l.credit) : ''}</td>
              <td className="muted">{[l.memo, l.name].filter(Boolean).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entry.files.length > 0 && (
        <p className="muted small">📎 {entry.files.map((f) => f.fileName).join(', ')}</p>
      )}
      {entry.reconciled.length > 0 && (
        <p className="muted small">
          Reconciled:{' '}
          {entry.reconciled
            .map((r) => `${r.account}, statement of ${formatDate(r.statementDate)}`)
            .join('; ')}
        </p>
      )}
      <div className="buttons">
        <button
          className="secondary"
          onClick={(e) => {
            e.stopPropagation();
            props.onOpen();
          }}
        >
          Open entry
        </button>
      </div>
    </div>
  );
}
