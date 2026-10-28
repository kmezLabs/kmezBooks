// Journal entries (GL-3, GL-4, GL-6, GL-10): list, view, void, attachments,
// new entry, and re-entering a voided one from a filled-in copy.

import { useEffect, useState } from 'react';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney, parseMoney } from '../../shared/money';
import type { EntrySummary } from '../../ledger/entries';
import type { EntryView as EntryData, SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import {
  AccountSelect,
  MoneyInput,
  cents,
  formatDate,
  todayIso,
  useClosedPeriodOverride,
} from '../ledgerUi';
import { Dialog, ErrorText, TextField, formatBytes, formatDateTime, useAction } from '../ui';

type View =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'entry'; id: number }
  | { kind: 'edit'; entry: EntryData }
  | { kind: 'reenter'; entry: EntryData };
const PAGE = 100;

const SOURCES: Record<string, string> = {
  journal: 'Journal entry',
  qbo_migration: 'From QuickBooks',
  bank: 'From bank review',
  register: 'Quick entry',
};

export function JournalPage(props: {
  status: SessionStatus;
  accountFilter: string | null;
  onClearAccountFilter: () => void;
  /** Open straight on this entry (from a report's drill-down, RP-5). */
  initialEntryId?: number | null;
  onBackToReport?: () => void;
  /** The Back button's label when opened from elsewhere */
  backLabel?: string;
}) {
  const [view, setView] = useState<View>(
    props.initialEntryId ? { kind: 'entry', id: props.initialEntryId } : { kind: 'list' },
  );
  if (view.kind === 'new' || view.kind === 'edit' || view.kind === 'reenter') {
    const editing = view.kind === 'edit' ? view.entry : undefined;
    const copyOf = view.kind === 'reenter' ? view.entry : undefined;
    return (
      <NewEntry
        status={props.status}
        editing={editing}
        copyOf={copyOf}
        onDone={(id) =>
          setView(
            id
              ? { kind: 'entry', id }
              : (editing ?? copyOf)
                ? { kind: 'entry', id: (editing ?? copyOf)!.id }
                : { kind: 'list' },
          )
        }
      />
    );
  }
  if (view.kind === 'entry') {
    return (
      <EntryView
        status={props.status}
        id={view.id}
        onEdit={(entry) => setView({ kind: 'edit', entry })}
        onReenter={(entry) => setView({ kind: 'reenter', entry })}
        onDeleted={props.onBackToReport ?? (() => setView({ kind: 'list' }))}
        onBack={props.onBackToReport ?? (() => setView({ kind: 'list' }))}
        backLabel={
          props.onBackToReport ? (props.backLabel ?? '← Back to report') : '← Journal entries'
        }
      />
    );
  }
  return (
    <EntryList
      status={props.status}
      accountFilter={props.accountFilter}
      onClearAccountFilter={props.onClearAccountFilter}
      onNew={() => setView({ kind: 'new' })}
      onOpen={(id) => setView({ kind: 'entry', id })}
    />
  );
}

function EntryList(props: {
  status: SessionStatus;
  accountFilter: string | null;
  onClearAccountFilter: () => void;
  onNew: () => void;
  onOpen: (id: number) => void;
}) {
  const [entries, setEntries] = useState<EntrySummary[]>([]);
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [includeVoid, setIncludeVoid] = useState(false);
  const [accountName, setAccountName] = useState<string | null>(null);
  const query = { search, includeVoid, accountId: props.accountFilter ?? undefined };

  useEffect(() => {
    const t = setTimeout(() => {
      void db.entries({ ...query, limit: PAGE }).then((page) => {
        setEntries(page);
        setMore(page.length === PAGE);
      });
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- query is rebuilt from these each render
  }, [search, includeVoid, props.accountFilter, props.status.companyId, props.status.lastSavedAt]);

  useEffect(() => {
    if (!props.accountFilter) return;
    void db
      .accounts()
      .then((all) =>
        setAccountName(all.find((a) => a.id === props.accountFilter)?.fullName ?? null),
      );
  }, [props.accountFilter]);

  const loadMore = async () => {
    const last = entries.at(-1);
    const page = await db.entries({
      ...query,
      limit: PAGE,
      after: last && { date: last.date, id: last.id },
    });
    setEntries([...entries, ...page]);
    setMore(page.length === PAGE);
  };

  return (
    <section>
      <h2>Journal entries</h2>
      <div className="buttons">
        <button disabled={props.status.readOnly} onClick={props.onNew}>
          New journal entry
        </button>
        <input
          className="search"
          type="search"
          placeholder="Search ref, name or memo"
          aria-label="Search ref, name or memo"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <label className="check inline">
          <input
            type="checkbox"
            checked={includeVoid}
            onChange={(e) => setIncludeVoid(e.target.checked)}
          />
          Show void
        </label>
      </div>
      {props.accountFilter && (
        <p className="notice">
          Entries that use <strong>{accountName ?? 'this account'}</strong>.{' '}
          <button className="link" onClick={props.onClearAccountFilter}>
            Show all
          </button>
        </p>
      )}
      {entries.length === 0 ? (
        <p className="muted">No entries{search || props.accountFilter ? ' match' : ' yet'}.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Date</th>
              <th>No.</th>
              <th>Ref</th>
              <th>Name</th>
              <th>Memo</th>
              <th className="num">Amount</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr
                key={e.id}
                className={e.status === 'void' ? 'clickable inactive' : 'clickable'}
                onClick={() => props.onOpen(e.id)}
              >
                <td>{formatDate(e.date)}</td>
                <td className="muted">{e.id}</td>
                <td>{e.ref}</td>
                <td>{e.name}</td>
                <td>
                  {e.memo}
                  {e.sourceType !== 'journal' && (
                    <span className="muted"> · {SOURCES[e.sourceType] ?? e.sourceType}</span>
                  )}
                </td>
                <td className="num">{formatMoney(e.amount)}</td>
                <td>
                  {e.status === 'void' && <span className="badge small">void</span>}
                  {e.attachments > 0 && (
                    <span className="muted" title={`${e.attachments} attachment(s)`}>
                      {' '}
                      📎{e.attachments}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {more && (
        <div className="buttons">
          <button className="secondary" onClick={loadMore}>
            Show older
          </button>
        </div>
      )}
    </section>
  );
}

interface LineDraft {
  key: number;
  accountId: string;
  debit: string;
  credit: string;
  memo: string;
  /** A line's own payee (MG-3), kept from the entry it was filled from */
  name?: string | null;
}

let nextKey = 1;
const blankLine = (): LineDraft => ({
  key: nextKey++,
  accountId: '',
  debit: '',
  credit: '',
  memo: '',
});

/**
 * A new entry, or a change to a posted one (GL-6: in place, or void and
 * re-enter), or a new entry filled in from a voided one (GL-10).
 */
function NewEntry(props: {
  status: SessionStatus;
  editing?: EntryData;
  copyOf?: EntryData;
  onDone: (id: number | null) => void;
}) {
  const e0 = props.editing;
  const from = e0 ?? props.copyOf;
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [postedEdits, setPostedEdits] = useState(false);
  const [date, setDate] = useState(from?.date ?? todayIso());
  const [ref, setRef] = useState(from?.ref ?? '');
  const [memo, setMemo] = useState(from?.memo ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    from
      ? from.lines.map((l) => ({
          ...blankLine(),
          accountId: l.accountId,
          debit: l.debit ? formatMoney(l.debit) : '',
          credit: l.credit ? formatMoney(l.credit) : '',
          memo: l.memo ?? '',
          name: l.name,
        }))
      : [blankLine(), blankLine()],
  );
  const [files, setFiles] = useState<File[]>([]);
  const { attempt, busy, error, setError, dialog } = useClosedPeriodOverride();

  useEffect(() => {
    void db.accounts().then(setAccounts);
    void db.postedEdits().then(setPostedEdits);
  }, []);

  const used = lines.filter((l) => l.accountId || l.debit.trim() || l.credit.trim());
  const debits = used.reduce((s, l) => s + cents(l.debit), 0);
  const credits = used.reduce((s, l) => s + cents(l.credit), 0);
  const difference = debits - credits;
  const badAmount = lines.some(
    (l) => parseMoney(l.debit) === null || parseMoney(l.credit) === null,
  );

  const setLine = (key: number, changes: Partial<LineDraft>) =>
    setLines(lines.map((l) => (l.key === key ? { ...l, ...changes } : l)));

  const addLine = () => {
    const line = blankLine();
    // Offer the amount that balances the entry
    if (difference > 0) line.credit = formatMoney(difference);
    if (difference < 0) line.debit = formatMoney(-difference);
    setLines([...lines, line]);
  };

  const post = () => {
    if (badAmount) {
      setError('Amounts must be numbers with at most two decimals.');
      return;
    }
    void attempt(async (overridePassphrase) => {
      const entry = {
        date,
        ref,
        memo,
        lines: used.map((l) => ({
          accountId: l.accountId,
          debit: cents(l.debit),
          credit: cents(l.credit),
          memo: l.memo,
          name: l.name ?? null,
        })),
      };
      const id = e0
        ? await db.saveEntryChange(e0.id, { ...entry, name: e0.name }, overridePassphrase)
        : await db.postJournalEntry({ ...entry, name: from?.name ?? null }, overridePassphrase);
      for (const f of files) await db.addAttachment('journal_entry', String(id), f);
      props.onDone(id);
    });
  };

  if (accounts.length === 0) {
    return (
      <section>
        <h2>New journal entry</h2>
        <p>Add accounts first, on the Accounts page.</p>
        <button className="secondary" onClick={() => props.onDone(null)}>
          Back
        </button>
      </section>
    );
  }

  return (
    <section>
      <h2>
        {e0
          ? `${postedEdits ? 'Change' : 'Correct'} journal entry ${e0.id}`
          : from
            ? `Re-enter journal entry ${from.id}`
            : 'New journal entry'}
      </h2>
      {props.copyOf && (
        <p className="muted">
          Filled in from the voided entry{props.copyOf.name ? ` (${props.copyOf.name})` : ''}. Check
          it and post it as a new entry; the voided one stays on record.
        </p>
      )}
      {props.copyOf?.sourceType === 'bank' && (
        <p className="warning">
          This entry came from bank review, and voiding it sent its bank transaction back there.
          Adding it again in Bank transactions keeps it linked to the bank; if you post it here,
          match the bank transaction to this entry so it isn&rsquo;t entered twice.
        </p>
      )}
      {e0 && (
        <p className="muted">
          {postedEdits
            ? 'The entry is changed in place; the audit log keeps what it was.'
            : 'Saving voids the original and posts this corrected copy (GL-6). Allow changing posted transactions on the Company page to change entries in place.'}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          post();
        }}
      >
        <div className="fields">
          <label className="short">
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </label>
          <TextField
            label="Ref"
            value={ref}
            onChange={setRef}
            width="short"
            hint="Journal or check number"
          />
          <TextField label="Memo" value={memo} onChange={setMemo} width="long" />
        </div>
        <table className="lines">
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
              <th>Line memo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.key}>
                <td>
                  <AccountSelect
                    accounts={accounts}
                    value={l.accountId}
                    onChange={(accountId) => setLine(l.key, { accountId })}
                  />
                </td>
                <td>
                  <MoneyInput
                    ariaLabel={`Line ${i + 1} debit`}
                    value={l.debit}
                    onChange={(debit) =>
                      setLine(l.key, debit.trim() ? { debit, credit: '' } : { debit })
                    }
                  />
                </td>
                <td>
                  <MoneyInput
                    ariaLabel={`Line ${i + 1} credit`}
                    value={l.credit}
                    onChange={(credit) =>
                      setLine(l.key, credit.trim() ? { credit, debit: '' } : { credit })
                    }
                  />
                </td>
                <td>
                  <input
                    aria-label={`Line ${i + 1} memo`}
                    value={l.memo}
                    onChange={(e) => setLine(l.key, { memo: e.target.value })}
                  />
                </td>
                <td>
                  {lines.length > 2 && (
                    <button
                      type="button"
                      className="link muted"
                      aria-label={`Remove line ${i + 1}`}
                      onClick={() => setLines(lines.filter((x) => x.key !== l.key))}
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
              <td>
                <button type="button" className="link" onClick={addLine}>
                  + Add line
                </button>
              </td>
              <td className="num">{formatMoney(debits)}</td>
              <td className="num">{formatMoney(credits)}</td>
              <td colSpan={2} className={difference === 0 ? 'muted' : 'error-text'}>
                {difference === 0
                  ? debits > 0
                    ? 'Balanced'
                    : ''
                  : `Out of balance by ${formatMoney(Math.abs(difference))}`}
              </td>
            </tr>
          </tfoot>
        </table>
        <div className="fields">
          <label>
            Attachments
            <input type="file" multiple onChange={(e) => setFiles([...(e.target.files ?? [])])} />
            <span className="hint">
              Receipts or documents, up to 25 MB each. Stored encrypted in the company folder.
            </span>
          </label>
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button
            type="submit"
            disabled={busy || difference !== 0 || debits === 0 || used.length < 2}
          >
            {busy ? 'Saving…' : e0 ? 'Save' : 'Post entry'}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => props.onDone(null)}
          >
            Cancel
          </button>
        </div>
      </form>
      {dialog}
    </section>
  );
}

async function openFile(id: string) {
  const { fileName, mimeType, bytes } = await db.openAttachment(id);
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const a = document.createElement('a');
  a.href = url;
  // Show what the browser can show (PDFs, images); download the rest
  if (!/^(application\/pdf|image\/|text\/plain)/.test(mimeType)) a.download = fileName;
  a.target = '_blank';
  a.rel = 'noopener';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function EntryView(props: {
  status: SessionStatus;
  id: number;
  onBack: () => void;
  onEdit: (entry: EntryData) => void;
  onReenter: (entry: EntryData) => void;
  onDeleted: () => void;
  backLabel: string;
}) {
  const [entry, setEntry] = useState<EntryData | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [postedEdits, setPostedEdits] = useState(false);
  const { busy, error, run } = useAction();
  const removal = useClosedPeriodOverride();
  const reload = () => void db.entry(props.id).then(setEntry);

  useEffect(reload, [props.id, props.status.lastSavedAt]);
  useEffect(() => void db.postedEdits().then(setPostedEdits), [props.status.lastSavedAt]);

  if (!entry) return null;
  const readOnly = props.status.readOnly;
  const total = (k: 'debit' | 'credit') => entry.lines.reduce((s, l) => s + l[k], 0);

  return (
    <section>
      <div className="buttons">
        <button className="link" onClick={props.onBack}>
          {props.backLabel}
        </button>
      </div>
      <h2>
        Journal entry {entry.id} {entry.status === 'void' && <span className="badge">void</span>}
      </h2>
      <p>
        <strong>{formatDate(entry.date)}</strong>
        {entry.ref && <> · Ref {entry.ref}</>}
        {entry.name && <> · {entry.name}</>}
        {entry.memo && <> · {entry.memo}</>}
        <br />
        <span className="muted">
          {SOURCES[entry.sourceType] ?? entry.sourceType} · posted {formatDateTime(entry.postedAt)}
          {entry.voidedAt && (
            <>
              {' '}
              · voided {formatDateTime(entry.voidedAt)}
              {entry.voidReason && `: ${entry.voidReason}`}
            </>
          )}
        </span>
      </p>
      {entry.reconciled.length > 0 && (
        <p className="muted">
          Reconciled:{' '}
          {entry.reconciled
            .map((r) => `${r.account}, statement of ${formatDate(r.statementDate)}`)
            .join('; ')}
        </p>
      )}
      <table className="list">
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
              <td>
                {l.memo}
                {l.name && (
                  <span className="muted">
                    {l.memo ? ' · ' : ''}
                    {l.name}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td />
            <td className="num">{formatMoney(total('debit'))}</td>
            <td className="num">{formatMoney(total('credit'))}</td>
            <td />
          </tr>
        </tfoot>
      </table>

      <h3>Attachments</h3>
      {entry.files.length === 0 && <p className="muted">None.</p>}
      <ul className="files">
        {entry.files.map((f) => (
          <li key={f.id}>
            <button className="link" onClick={() => run(() => openFile(f.id))}>
              {f.fileName}
            </button>{' '}
            <span className="muted">{formatBytes(f.size)}</span>{' '}
            {!readOnly && (
              <button
                className="link muted"
                onClick={() =>
                  run(async () => {
                    await db.removeAttachment(f.id);
                    reload();
                  })
                }
              >
                remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <label className="file-add">
          Add attachment
          <input
            type="file"
            multiple
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = '';
              void run(async () => {
                for (const f of picked)
                  await db.addAttachment('journal_entry', String(entry.id), f);
                reload();
              });
            }}
          />
        </label>
      )}
      <ErrorText>{error ?? removal.error}</ErrorText>
      {removal.dialog}
      {entry.status === 'posted' && !readOnly && (
        <div className="buttons">
          <button className="secondary" disabled={busy} onClick={() => props.onEdit(entry)}>
            {postedEdits ? 'Edit entry' : 'Correct entry'}
          </button>
          <button className="secondary" disabled={busy} onClick={() => setVoiding(true)}>
            Void entry
          </button>
          {postedEdits && (
            <button
              className="secondary"
              disabled={busy || removal.busy}
              onClick={() => {
                if (
                  !confirm(
                    `Delete journal entry ${entry.id}? It is removed from the books; the audit log keeps a record.`,
                  )
                )
                  return;
                void removal.attempt(async (passphrase) => {
                  await db.deleteEntry(entry.id, passphrase);
                  props.onDeleted();
                });
              }}
            >
              Delete entry
            </button>
          )}
        </div>
      )}
      {entry.status === 'void' && !readOnly && (
        <div className="buttons">
          <button
            className="secondary"
            title="A new entry filled in from this one, to check and post; this one stays void"
            onClick={() => props.onReenter(entry)}
          >
            Re-enter
          </button>
        </div>
      )}
      {voiding && (
        <VoidDialog
          id={entry.id}
          reconciled={entry.reconciled}
          onClose={() => {
            setVoiding(false);
            reload();
          }}
        />
      )}
    </section>
  );
}

function VoidDialog(props: {
  id: number;
  reconciled: EntryData['reconciled'];
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const { attempt, busy, error, dialog } = useClosedPeriodOverride();
  return (
    <Dialog title={`Void journal entry ${props.id}`} onClose={busy ? undefined : props.onClose}>
      <p>
        The entry stays on record, marked void, and drops out of every balance and report. This
        can't be undone; to restore it, use Re-enter on the voided entry.
      </p>
      {props.reconciled.length > 0 && (
        <p className="warning">
          This entry was reconciled (
          {props.reconciled
            .map((r) => `${r.account}, statement of ${formatDate(r.statementDate)}`)
            .join('; ')}
          ). Voiding it means the books no longer agree with that statement, and the next
          reconciliation won't balance until a correction is entered. The reconciliation report will
          show it as changed.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void attempt(async (passphrase) => {
            await db.voidEntry(props.id, reason, passphrase);
            props.onClose();
          });
        }}
      >
        <TextField
          label="Reason"
          value={reason}
          onChange={setReason}
          autoFocus
          hint="Optional, kept with the entry"
        />
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy}>
            Void entry
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>
            Cancel
          </button>
        </div>
      </form>
      {dialog}
    </Dialog>
  );
}
