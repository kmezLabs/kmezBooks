// Recurring invoices (AR-9): monthly tuition and the like. Each makes a draft
// invoice on its dates when the company is opened, to check and send; this
// page lists them, adds and changes them, and makes or skips the next one.

import { useEffect, useState } from 'react';
import type { Payee } from '../../ledger/payees';
import { formatDate, todayIso } from '../../app/ledgerUi';
import { ErrorText, TextField, useAction } from '../../app/ui';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney } from '../../shared/money';
import { FREQUENCIES, describeSchedule, nextDate, type Frequency } from '../../shared/schedule';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import {
  DocLinesTable,
  LINES_ERROR,
  blankRow,
  defaultIncomeAccount,
  linesFromRows,
  rowsFrom,
  type LineRow,
} from './DocLines';
import type { Doc } from './documents';
import type { Item } from './items';
import type { RecurringInvoice, RecurringInvoiceInput } from './recurringInvoices';
import { CustomerSelect } from './salesUi';

/** A new recurring invoice filled in from an invoice ("Make recurring"). */
export type RecurringInvoiceDraft = RecurringInvoiceInput;

/** What an invoice repeats as: monthly on its day, from the month after it. */
export function draftFromInvoice(d: Doc): RecurringInvoiceDraft {
  const day = Number(d.date.slice(8));
  return {
    name: d.customer,
    customerId: d.customerId,
    frequency: 'monthly',
    dayOfMonth: day,
    startDate: nextDate(d.date, 'monthly', day),
    endDate: null,
    termsDays: d.termsDays,
    memo: d.memo,
    lines: d.lines,
  };
}

export function RecurringInvoicesPage(props: {
  status: SessionStatus;
  /** Open the form on this, from an invoice's Make recurring */
  draft: RecurringInvoiceDraft | null;
  onDraftUsed: () => void;
  onOpenInvoices: () => void;
}) {
  const [list, setList] = useState<RecurringInvoice[] | null>(null);
  const [editing, setEditing] = useState<RecurringInvoice | RecurringInvoiceDraft | 'new' | null>(
    props.draft,
  );
  const [result, setResult] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const { busy, error, run } = useAction();
  const readOnly = props.status.readOnly;

  useEffect(() => {
    void db.recurringInvoices().then(setList);
  }, [props.status.companyId, props.status.lastSavedAt, version]);

  const changed = () => setVersion((v) => v + 1);

  if (editing) {
    return (
      <RecurringInvoiceForm
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
      <h2>Recurring invoices</h2>
      <p className="muted">
        Invoices that repeat, such as monthly tuition. Each is made as a draft on its dates when you
        open the company, ready to check and send from Invoices; nothing runs while EasyBooks is
        closed. To start one from an invoice, open it and use <strong>Make recurring</strong>.
      </p>
      {!readOnly && (
        <div className="buttons">
          <button onClick={() => setEditing('new')}>New recurring invoice</button>
          <button
            className="secondary"
            disabled={busy}
            title="Make what has come due since the company was opened"
            onClick={() =>
              void run(async () => {
                const r = await db.createDueInvoices();
                setResult(
                  r.created.length
                    ? `Made ${r.created.length} ${r.created.length === 1 ? 'invoice' : 'invoices'}.`
                    : 'Nothing is due.',
                );
                changed();
              })
            }
          >
            Create due now
          </button>
        </div>
      )}
      {result && (
        <p className="notice">
          {result}{' '}
          <button className="link" onClick={props.onOpenInvoices}>
            Invoices
          </button>
        </p>
      )}
      <ErrorText>{error}</ErrorText>
      {list.length === 0 ? (
        <p className="muted">No recurring invoices yet.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Customer</th>
              <th>Schedule</th>
              <th>Next</th>
              <th className="num">Amount</th>
              <th>Last made</th>
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
                  <td>{r.customer}</td>
                  <td>{describeSchedule(r.frequency, r.dayOfMonth, r.startDate)}</td>
                  <td className="nowrap">
                    {r.nextDate ? formatDate(r.nextDate) : <span className="muted">ended</span>}
                    {due && <span className="badge small warn"> waiting</span>}
                  </td>
                  <td className="num">{formatMoney(r.total)}</td>
                  <td className="nowrap">{r.lastMade ? formatDate(r.lastMade) : ''}</td>
                  <td className="actions nowrap">
                    {!readOnly && r.active && r.nextDate && (
                      <>
                        <button
                          className="link"
                          disabled={busy}
                          title={`Make the ${formatDate(r.nextDate)} invoice now`}
                          onClick={() =>
                            void run(async () => {
                              await db.createRecurringInvoiceNow(r.id);
                              setResult(
                                `Made the ${formatDate(r.nextDate)} invoice for ${r.customer}.`,
                              );
                              changed();
                            })
                          }
                        >
                          Create now
                        </button>{' '}
                        <button
                          className="link"
                          disabled={busy}
                          title={`Don't make ${formatDate(r.nextDate)}; go on to the next date`}
                          onClick={() =>
                            void run(async () => {
                              if (!confirm(`Skip ${r.name} for ${formatDate(r.nextDate)}?`)) return;
                              await db.skipRecurringInvoice(r.id);
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
    </section>
  );
}

const isSaved = (t: RecurringInvoice | RecurringInvoiceDraft): t is RecurringInvoice => 'id' in t;

function RecurringInvoiceForm(props: {
  editing: RecurringInvoice | RecurringInvoiceDraft | 'new';
  onDone: () => void;
}) {
  const t = props.editing === 'new' ? null : props.editing;
  const existing = t && isSaved(t) ? t : null;
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState(t?.name ?? '');
  const [customerId, setCustomerId] = useState(t?.customerId ?? '');
  const [frequency, setFrequency] = useState<Frequency>(t?.frequency ?? 'monthly');
  const [day, setDay] = useState(String(t?.dayOfMonth ?? 1));
  const [startDate, setStartDate] = useState(t?.startDate ?? todayIso());
  const [endDate, setEndDate] = useState(t?.endDate ?? '');
  const [terms, setTerms] = useState(t?.termsDays === null || !t ? '' : String(t.termsDays));
  const [memo, setMemo] = useState(t?.memo ?? '');
  const [rows, setRows] = useState<LineRow[]>(t ? rowsFrom(t.lines) : []);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    void db.accounts().then(setAccounts);
    void db.items().then(setItems);
  }, []);
  // A new one starts with one empty line once the accounts are known
  const defaultAccount = defaultIncomeAccount(accounts);
  if (!t && rows.length === 0 && defaultAccount) setRows([blankRow(defaultAccount)]);

  const save = () => {
    const lines = linesFromRows(rows);
    if (!lines) return setError(LINES_ERROR);
    const termsDays = terms.trim() === '' ? null : Number(terms);
    if (termsDays !== null && !Number.isInteger(termsDays))
      return setError('Terms are a whole number of days.');
    const input: RecurringInvoiceInput = {
      name,
      customerId,
      frequency,
      dayOfMonth: Number(day),
      startDate,
      endDate: endDate || null,
      termsDays,
      memo,
      lines,
    };
    void run(async () => {
      if (existing) await db.updateRecurringInvoice(existing.id, input);
      else await db.createRecurringInvoice(input);
      props.onDone();
    });
  };

  return (
    <section>
      <h2>{existing ? existing.name : 'New recurring invoice'}</h2>
      {existing && (
        <p className="muted">
          {existing.lastMade ? `Last made ${formatDate(existing.lastMade)}. ` : 'None made yet. '}
          {existing.nextDate ? `Next on ${formatDate(existing.nextDate)}.` : 'It has ended.'}{' '}
          Changes apply to the invoices still to come; those already made stay as they are.
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
            hint="e.g. Tuition, Smith Family"
          />
          <CustomerSelect
            label="Customer"
            value={customerId}
            onChange={(p: Payee) => {
              setCustomerId(p.id);
              setTerms(p.termsDays === null ? '' : String(p.termsDays));
              if (!name.trim()) setName(p.name);
            }}
          />
        </div>
        <div className="fields">
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
          <label className="short">
            Terms (days)
            <input
              inputMode="numeric"
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              placeholder="On receipt"
            />
            <span className="hint">Due this long after each invoice's date</span>
          </label>
        </div>
        <DocLinesTable rows={rows} onChange={setRows} accounts={accounts} items={items} />
        <TextField label="Message to the customer" value={memo} onChange={setMemo} />
        <p className="muted small">
          {describeSchedule(frequency, Number(day), startDate)}, from {formatDate(startDate)}
          {endDate ? ` to ${formatDate(endDate)}` : ''}; each invoice is made as a draft.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy || !customerId || !name.trim()}>
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
                  await db.setRecurringInvoiceActive(existing.id, !existing.active);
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
                  await db.deleteRecurringInvoice(existing.id);
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
