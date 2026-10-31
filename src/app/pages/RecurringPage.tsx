// Recurring journal entries (GL-5): monthly depreciation and the like. Each
// posts on its dates when the company is opened; this page lists them, adds
// and changes them, and posts or skips one that is waiting.

import { useEffect, useState } from 'react';
import type { Recurring, RecurringInput } from '../../ledger/recurring';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney } from '../../shared/money';
import { FREQUENCIES, describeSchedule, type Frequency } from '../../shared/schedule';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import {
  LineEditor,
  blankLine,
  lineTotals,
  linesFrom,
  linesToCents,
  type LineDraft,
} from '../LineEditor';
import { PayeeField, formatDate, todayIso, useClosedPeriodOverride } from '../ledgerUi';
import { ErrorText, TextField, useAction } from '../ui';

/** A new recurring entry filled in from a posted one ("Make recurring"). */
export type RecurringDraft = Omit<RecurringInput, 'lines'> & {
  lines: { accountId: string; debit: number; credit: number; memo: string | null }[];
};

export function RecurringPage(props: {
  status: SessionStatus;
  /** Open the form on this, from a journal entry's Make recurring */
  draft: RecurringDraft | null;
  onDraftUsed: () => void;
}) {
  const [list, setList] = useState<Recurring[] | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [editing, setEditing] = useState<Recurring | RecurringDraft | 'new' | null>(props.draft);
  const [result, setResult] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const { busy, error, run } = useAction();
  const override = useClosedPeriodOverride();
  const readOnly = props.status.readOnly;

  useEffect(() => {
    void db.recurringList().then(setList);
    void db.accounts().then(setAccounts);
  }, [props.status.companyId, props.status.lastSavedAt, version]);

  const changed = () => setVersion((v) => v + 1);

  if (editing) {
    return (
      <RecurringForm
        accounts={accounts}
        editing={editing}
        onDone={() => {
          setEditing(null);
          props.onDraftUsed();
          changed();
        }}
      />
    );
  }
  if (!list) return null;

  return (
    <section>
      <h2>Recurring entries</h2>
      <p className="muted">
        Journal entries that repeat, such as monthly depreciation or amortization. Each posts on its
        dates when you open the company; nothing runs while kmezBooks is closed. To start one from
        an entry already in the books, open the entry and use <strong>Make recurring</strong>.
      </p>
      {!readOnly && (
        <div className="buttons">
          <button onClick={() => setEditing('new')}>New recurring entry</button>
          <button
            className="secondary"
            disabled={busy}
            title="Post what has come due since the company was opened"
            onClick={() =>
              void run(async () => {
                const r = await db.postDueRecurring();
                setResult(
                  r.posted.length
                    ? `Posted ${r.posted.length} recurring ${r.posted.length === 1 ? 'entry' : 'entries'}.`
                    : 'Nothing is due.',
                );
                changed();
              })
            }
          >
            Post due now
          </button>
        </div>
      )}
      {result && <p className="notice">{result}</p>}
      <ErrorText>{error ?? override.error}</ErrorText>
      {list.length === 0 ? (
        <p className="muted">No recurring entries yet.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Schedule</th>
              <th>Next</th>
              <th className="num">Amount</th>
              <th>Last posted</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((r) => {
              const due = r.active && r.nextDate !== null && r.nextDate <= todayIso();
              return (
                <tr key={r.id} className={r.active ? undefined : 'inactive'}>
                  <td>
                    <button className="link" onClick={() => setEditing(r)}>
                      {r.name}
                    </button>{' '}
                    {!r.active && <span className="badge small">inactive</span>}
                  </td>
                  <td>{describeSchedule(r.frequency, r.dayOfMonth, r.startDate)}</td>
                  <td className="nowrap">
                    {r.nextDate ? formatDate(r.nextDate) : <span className="muted">ended</span>}
                    {due && <span className="badge small warn"> waiting</span>}
                  </td>
                  <td className="num">{formatMoney(r.amount)}</td>
                  <td className="nowrap">{r.lastPosted ? formatDate(r.lastPosted) : ''}</td>
                  <td className="actions nowrap">
                    {!readOnly && r.active && r.nextDate && (
                      <>
                        {due && (
                          <button
                            className="link"
                            disabled={busy || override.busy}
                            title="Post this date now (a closed period asks for your passphrase)"
                            onClick={() =>
                              void override.attempt(async (p) => {
                                await db.postRecurringNow(r.id, p);
                                changed();
                              })
                            }
                          >
                            Post now
                          </button>
                        )}{' '}
                        <button
                          className="link"
                          disabled={busy}
                          title={`Don't post ${formatDate(r.nextDate)}; go on to the next date`}
                          onClick={() =>
                            void run(async () => {
                              if (!confirm(`Skip ${r.name} for ${formatDate(r.nextDate)}?`)) return;
                              await db.skipRecurring(r.id);
                              changed();
                            })
                          }
                        >
                          Skip next
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {override.dialog}
    </section>
  );
}

const isSaved = (t: Recurring | RecurringDraft): t is Recurring => 'id' in t;

function RecurringForm(props: {
  accounts: AccountRow[];
  editing: Recurring | RecurringDraft | 'new';
  onDone: () => void;
}) {
  const t = props.editing === 'new' ? null : props.editing;
  const existing = t && isSaved(t) ? t : null;
  const [name, setName] = useState(t?.name ?? '');
  const [frequency, setFrequency] = useState<Frequency>(t?.frequency ?? 'monthly');
  const [day, setDay] = useState(String(t?.dayOfMonth ?? 1));
  const [startDate, setStartDate] = useState(t?.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(t?.endDate ?? '');
  const [ref, setRef] = useState(t?.ref ?? '');
  const [payee, setPayee] = useState(t?.payee ?? '');
  const [memo, setMemo] = useState(t?.memo ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    t ? linesFrom(t.lines) : [blankLine(), blankLine()],
  );
  const { busy, error, setError, run } = useAction();
  const { used, badAmount, balanced } = lineTotals(lines);

  const save = () => {
    if (badAmount) {
      setError('Amounts must be numbers with at most two decimals.');
      return;
    }
    const input: RecurringInput = {
      name,
      frequency,
      dayOfMonth: Number(day),
      startDate,
      endDate: endDate || null,
      ref,
      payee,
      memo,
      lines: linesToCents(used).map(({ name: _, ...l }) => l),
    };
    void run(async () => {
      if (existing) await db.updateRecurring(existing.id, input);
      else await db.createRecurring(input);
      props.onDone();
    });
  };

  return (
    <section>
      <h2>{existing ? existing.name : 'New recurring entry'}</h2>
      {existing && (
        <p className="muted">
          {existing.lastPosted
            ? `Last posted ${formatDate(existing.lastPosted)}. `
            : 'Not posted yet. '}
          {existing.nextDate ? `Next on ${formatDate(existing.nextDate)}.` : 'It has ended.'}{' '}
          Changes apply to the dates still to come; entries already posted stay as they are.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="fields">
          <TextField
            label="Name"
            value={name}
            onChange={setName}
            autoFocus={!t}
            hint="e.g. Depreciation"
          />
          <label className="short">
            Repeats
            <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
              {(Object.keys(FREQUENCIES) as Frequency[]).map((f) => (
                <option key={f} value={f}>
                  {FREQUENCIES[f]}
                </option>
              ))}
            </select>
          </label>
          <label className="short">
            On day
            <select value={day} onChange={(e) => setDay(e.target.value)}>
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d === 31 ? 'Last day' : d}
                </option>
              ))}
            </select>
          </label>
          <label className="short">
            Starting
            <input
              type="date"
              value={startDate}
              required
              onChange={(e) => setStartDate(e.target.value)}
            />
          </label>
          <label className="short">
            Ending
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            <span className="hint">Optional</span>
          </label>
        </div>
        <div className="fields">
          <TextField label="Ref" value={ref} onChange={setRef} width="short" />
          <label>
            Payee
            <PayeeField value={payee} onChange={setPayee} placeholder="Optional" />
          </label>
          <TextField
            label="Memo"
            value={memo}
            onChange={setMemo}
            width="long"
            hint="Each entry's memo; the name if left empty"
          />
        </div>
        <LineEditor accounts={props.accounts} lines={lines} onChange={setLines} />
        <p className="muted small">
          {describeSchedule(frequency, Number(day), startDate)}, from {formatDate(startDate)}
          {endDate ? ` to ${formatDate(endDate)}` : ''}.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy || !balanced || !name.trim()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={props.onDone}>
            Cancel
          </button>
          {existing && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await db.setRecurringActive(existing.id, !existing.active);
                  props.onDone();
                })
              }
            >
              {existing.active ? 'Make inactive' : 'Make active'}
            </button>
          )}
          {existing && !existing.hasRuns && (
            <button
              type="button"
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  if (!confirm(`Delete ${existing.name}?`)) return;
                  await db.deleteRecurring(existing.id);
                  props.onDone();
                })
              }
            >
              Delete
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
