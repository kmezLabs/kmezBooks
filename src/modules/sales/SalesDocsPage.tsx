// Invoices and estimates (AR-3 to AR-5, AR-7): the list with what's owed, the
// document form with product and service lines, and receiving payments.
// Documents never post; a payment posts its income (cash basis, GL-8).

import { Fragment, useEffect, useState } from 'react';
import type { Payee } from '../../ledger/payees';
import {
  AccountSelect,
  MoneyInput,
  formatDate,
  todayIso,
  useClosedPeriodOverride,
} from '../../app/ledgerUi';
import { download } from '../../app/export/exportReport';
import { announce } from '../../app/statusMessages';
import { Dialog, ErrorText, TextField, useAction } from '../../app/ui';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney, parseMoney, type Cents } from '../../shared/money';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import type { CustomerBalance, Doc, DocKind, DocState } from './documents';
import type { Item } from './items';
import { addDays } from './math';
import type { Payment } from './payments';
import {
  DocLinesTable,
  LINES_ERROR,
  blankRow,
  defaultIncomeAccount,
  linesFromRows,
  rowsFrom,
  type LineRow,
} from './DocLines';
import { CustomerSelect, StateBadge } from './salesUi';

type Filter = 'all' | 'open' | 'overdue' | 'paid' | 'accepted' | 'declined' | 'void';

const FILTERS: Record<DocKind, Filter[]> = {
  invoice: ['all', 'open', 'overdue', 'paid', 'void'],
  estimate: ['all', 'open', 'accepted', 'declined', 'void'],
};

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  open: 'Open',
  overdue: 'Overdue',
  paid: 'Paid',
  accepted: 'Accepted',
  declined: 'Declined',
  void: 'Void',
};

function matches(d: Doc, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'open')
    return d.kind === 'invoice' ? d.owed > 0 : d.state === 'draft' || d.state === 'sent';
  return d.state === (f as DocState);
}

const noun = (kind: DocKind) => (kind === 'invoice' ? 'invoice' : 'estimate');

export function SalesDocsPage({
  status,
  kind,
  onMakeRecurring,
}: {
  status: SessionStatus;
  kind: DocKind;
  /** Start a recurring invoice from this one (AR-9) */
  onMakeRecurring?: (d: Doc) => void;
}) {
  const [view, setView] = useState<{ id: string | null; copyOf?: Doc } | null>(null);
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [balances, setBalances] = useState<CustomerBalance[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [receiving, setReceiving] = useState<{
    customerId: string | null;
    docId: string | null;
  } | null>(null);
  const [version, setVersion] = useState(0);
  const readOnly = status.readOnly;

  useEffect(() => {
    void db.salesDocs({ kind }).then(setDocs);
    if (kind === 'invoice') void db.customerBalances().then(setBalances);
  }, [kind, status.companyId, status.lastSavedAt, version]);

  const changed = () => setVersion((v) => v + 1);
  const payDialog = receiving && (
    <ReceivePaymentDialog
      customerId={receiving.customerId}
      docId={receiving.docId}
      onClose={() => {
        setReceiving(null);
        changed();
      }}
    />
  );

  if (view) {
    return (
      <>
        <DocForm
          key={view.id ?? 'new'}
          kind={kind}
          id={view.id}
          copyOf={view.copyOf}
          readOnly={readOnly}
          version={version}
          onDone={(id) => {
            setView(id ? { id } : null);
            changed();
          }}
          onDuplicate={(d) => setView({ id: null, copyOf: d })}
          onReceivePayment={(d) => setReceiving({ customerId: d.customerId, docId: d.id })}
          onMakeRecurring={onMakeRecurring}
          onChanged={changed}
        />
        {payDialog}
      </>
    );
  }
  if (!docs) return null;
  const shown = docs.filter((d) => matches(d, filter));
  const owed = docs.reduce((s, d) => s + d.owed, 0);
  const overdue = docs.filter((d) => d.state === 'overdue').reduce((s, d) => s + d.owed, 0);

  return (
    <section>
      <h2>{kind === 'invoice' ? 'Invoices' : 'Estimates'}</h2>
      <p className="muted">
        {kind === 'invoice'
          ? 'An invoice records what a customer owes; nothing goes into the books until a payment comes in, which then counts as income on the day it arrives (cash basis).'
          : 'An estimate is a quote. Turn it into an invoice when the customer accepts.'}
      </p>
      <div className="buttons">
        {!readOnly && <button onClick={() => setView({ id: null })}>New {noun(kind)}</button>}
        {!readOnly && kind === 'invoice' && (
          <button
            className="secondary"
            onClick={() => setReceiving({ customerId: null, docId: null })}
          >
            Receive payment
          </button>
        )}
        <span className="segmented" role="group" aria-label="Show">
          {FILTERS[kind].map((f) => (
            <button
              key={f}
              type="button"
              className={f === filter ? '' : 'secondary'}
              aria-pressed={f === filter}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABELS[f]}
            </button>
          ))}
        </span>
      </div>
      {kind === 'invoice' && owed > 0 && (
        <p>
          Customers owe <strong>{formatMoney(owed)}</strong>
          {overdue > 0 && (
            <>
              , of which <strong>{formatMoney(overdue)}</strong> is overdue
            </>
          )}
          .
        </p>
      )}
      {shown.length === 0 ? (
        <p className="muted">
          No {noun(kind)}s{filter === 'all' ? ' yet' : ''}.
        </p>
      ) : (
        <table className="list two-line">
          <thead>
            <tr>
              <th>Date</th>
              <th className="wide">Customer</th>
              <th className="num">Total</th>
              {kind === 'invoice' && <th className="num">Owed</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="clickable" onClick={() => setView({ id: d.id })}>
                <td className="nowrap">
                  <div>{formatDate(d.date)}</div>
                  <div className="sub">No. {d.number}</div>
                </td>
                <td className="wide">
                  <div className="line">{d.customer}</div>
                  <div className="sub line">
                    {d.kind === 'invoice' && d.dueDate ? `Due ${formatDate(d.dueDate)}` : ''}
                    {d.memo ? `${d.dueDate ? ' · ' : ''}${d.memo}` : ''}
                  </div>
                </td>
                <td className="num">{formatMoney(d.total)}</td>
                {kind === 'invoice' && <td className="num">{d.owed ? formatMoney(d.owed) : ''}</td>}
                <td className="nowrap">
                  <StateBadge state={d.state} />
                  {!readOnly && d.owed > 0 && (
                    <>
                      {' '}
                      <button
                        className="link"
                        onClick={(e) => {
                          e.stopPropagation();
                          setReceiving({ customerId: d.customerId, docId: d.id });
                        }}
                      >
                        Receive payment
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {kind === 'invoice' && balances.length > 0 && (
        <>
          <h3>What customers owe</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Customer</th>
                <th className="num">Invoices</th>
                <th>Oldest due</th>
                <th className="num">Overdue</th>
                <th className="num">Owed</th>
              </tr>
            </thead>
            <tbody>
              {balances.map((b) => (
                <tr key={b.customerId}>
                  <td>{b.customer}</td>
                  <td className="num">{b.invoices}</td>
                  <td>{formatDate(b.oldestDue)}</td>
                  <td className="num">{b.overdue ? formatMoney(b.overdue) : ''}</td>
                  <td className="num">{formatMoney(b.owed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {payDialog}
    </section>
  );
}

// ---- the document form ----

function DocForm(props: {
  kind: DocKind;
  id: string | null;
  copyOf?: Doc;
  readOnly: boolean;
  version: number;
  onDone: (id: string | null) => void;
  onDuplicate: (d: Doc) => void;
  onReceivePayment: (d: Doc) => void;
  onMakeRecurring?: (d: Doc) => void;
  onChanged: () => void;
}) {
  const [doc, setDoc] = useState<Doc | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [customerId, setCustomerId] = useState(props.copyOf?.customerId ?? '');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(todayIso());
  const [termsDays, setTermsDays] = useState<number | null>(props.copyOf?.termsDays ?? null);
  const [dueDate, setDueDate] = useState('');
  const [dueTouched, setDueTouched] = useState(false);
  const [memo, setMemo] = useState(props.copyOf?.memo ?? '');
  const [rows, setRows] = useState<LineRow[]>(props.copyOf ? rowsFrom(props.copyOf.lines) : []);
  const [loaded, setLoaded] = useState(false);
  const { busy, error, setError, run } = useAction();
  const override = useClosedPeriodOverride();

  useEffect(() => {
    void db.accounts().then(setAccounts);
    void db.items().then(setItems);
    if (!props.id) void db.nextDocNumber(props.kind).then(setNumber);
  }, [props.id, props.kind]);

  useEffect(() => {
    if (!props.id) return;
    void db.salesDoc(props.id).then((d) => {
      setDoc(d);
      setCustomerId(d.customerId);
      setNumber(d.number);
      setDate(d.date);
      setTermsDays(d.termsDays);
      setDueDate(d.dueDate ?? '');
      setDueTouched(true);
      setMemo(d.memo ?? '');
      setRows(rowsFrom(d.lines));
      setLoaded(true);
    });
    if (props.kind === 'invoice') void db.payments({ docId: props.id }).then(setPayments);
  }, [props.id, props.kind, props.version]);

  const defaultAccount = defaultIncomeAccount(accounts);
  // A new document starts with one empty line once the accounts are known
  if (!props.id && !props.copyOf && rows.length === 0 && defaultAccount) {
    setRows([blankRow(defaultAccount)]);
  }
  const shownDue = dueTouched
    ? dueDate
    : termsDays !== null && date
      ? addDays(date, termsDays)
      : date;

  const locked = !!doc?.hasPayments;
  const editable = !props.readOnly && doc?.status !== 'void';

  const save = () => {
    const lines = linesFromRows(rows);
    if (!lines) {
      setError(LINES_ERROR);
      return;
    }
    const input = {
      kind: props.kind,
      number,
      customerId,
      date,
      dueDate: props.kind === 'invoice' ? (dueTouched ? dueDate || null : null) : null,
      termsDays,
      memo,
      lines,
    };
    void run(async () => {
      if (props.id) {
        await db.updateSalesDoc(props.id, input);
        props.onDone(props.id);
      } else {
        props.onDone(await db.createSalesDoc(input));
      }
    });
  };

  if (props.id && !loaded) return null;
  const title = doc
    ? `${props.kind === 'invoice' ? 'Invoice' : 'Estimate'} ${doc.number}`
    : `New ${noun(props.kind)}`;

  return (
    <section>
      <div className="buttons">
        <button className="link" onClick={() => props.onDone(null)}>
          ← {props.kind === 'invoice' ? 'Invoices' : 'Estimates'}
        </button>
      </div>
      <h2>
        {title} {doc && <StateBadge state={doc.state} />}
      </h2>
      {doc && props.kind === 'invoice' && doc.status !== 'void' && (
        <p>
          Total {formatMoney(doc.total)} · paid {formatMoney(doc.paid)} ·{' '}
          <strong>owed {formatMoney(doc.owed)}</strong>
        </p>
      )}
      {locked && (
        <p className="muted">
          This invoice has payments, so its customer and lines are fixed. Void the payments below to
          change them; the number, dates and message can still change.
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset disabled={!editable} className="plain">
          <div className="fields">
            {locked ? (
              <label>
                Customer
                <input value={doc!.customer} readOnly />
              </label>
            ) : (
              <CustomerSelect
                label="Customer"
                value={customerId}
                onChange={(p: Payee) => {
                  setCustomerId(p.id);
                  setTermsDays(p.termsDays);
                  if (!dueTouched) setDueDate('');
                }}
              />
            )}
            <TextField label="Number" value={number} onChange={setNumber} width="short" />
            <label className="short">
              Date
              <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
            </label>
            {props.kind === 'invoice' && (
              <label className="short">
                Due
                <input
                  type="date"
                  value={shownDue}
                  onChange={(e) => {
                    setDueTouched(true);
                    setDueDate(e.target.value);
                  }}
                />
                <span className="hint">
                  {termsDays !== null ? `Terms: ${termsDays} days` : 'Due on receipt'}
                </span>
              </label>
            )}
          </div>
          <DocLinesTable
            rows={rows}
            onChange={setRows}
            accounts={accounts}
            items={items}
            locked={locked}
          />
          <TextField
            label={props.kind === 'invoice' ? 'Message to the customer' : 'Message'}
            value={memo}
            onChange={setMemo}
          />
        </fieldset>
        <ErrorText>{error ?? override.error}</ErrorText>
        <div className="buttons">
          {editable && (
            <button type="submit" disabled={busy || !customerId}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
          <button type="button" className="secondary" onClick={() => props.onDone(null)}>
            {editable ? 'Cancel' : 'Back'}
          </button>
          {doc && !props.readOnly && (
            <DocActions
              doc={doc}
              payments={payments}
              busy={busy}
              run={run}
              onDone={props.onDone}
              onDuplicate={props.onDuplicate}
              onReceivePayment={props.onReceivePayment}
              onMakeRecurring={props.onMakeRecurring}
              onChanged={props.onChanged}
            />
          )}
        </div>
      </form>
      {doc && props.kind === 'invoice' && payments.length > 0 && (
        <>
          <h3>Payments</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th className="num">On this invoice</th>
                <th className="num">Payment</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className={p.status === 'void' ? 'inactive' : undefined}>
                  <td>{formatDate(p.date)}</td>
                  <td>{[p.method, p.ref].filter(Boolean).join(' ')}</td>
                  <td className="num">
                    {formatMoney(p.applications.find((a) => a.docId === doc.id)?.amount ?? 0)}
                  </td>
                  <td className="num">
                    {formatMoney(p.amount)}
                    {p.applications.length > 1 && (
                      <span className="muted small">
                        {' '}
                        ({p.applications.map((a) => a.number).join(', ')})
                      </span>
                    )}
                  </td>
                  <td>
                    {p.status === 'void' ? (
                      <span className="badge small">void</span>
                    ) : (
                      !props.readOnly && (
                        <button
                          className="link"
                          disabled={override.busy}
                          onClick={() => {
                            if (
                              !confirm(
                                'Void this payment? Its entry is voided and the invoice is owed again.',
                              )
                            )
                              return;
                            void override.attempt(async (pass) => {
                              await db.voidPayment(p.id, null, pass);
                              props.onChanged();
                            });
                          }}
                        >
                          Void payment
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {override.dialog}
    </section>
  );
}

function DocActions(props: {
  doc: Doc;
  payments: Payment[];
  busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<boolean>;
  onDone: (id: string | null) => void;
  onDuplicate: (d: Doc) => void;
  onReceivePayment: (d: Doc) => void;
  onMakeRecurring?: (d: Doc) => void;
  onChanged: () => void;
}) {
  const d = props.doc;
  const [sending, setSending] = useState(false);
  const act = (fn: () => Promise<unknown>, then: () => void = props.onChanged) =>
    void props.run(async () => {
      await fn();
      then();
    });
  if (d.status === 'void') {
    return (
      <button type="button" className="secondary" onClick={() => props.onDuplicate(d)}>
        Duplicate
      </button>
    );
  }
  return (
    <>
      {d.kind === 'invoice' && d.owed > 0 && (
        <button type="button" className="secondary" onClick={() => props.onReceivePayment(d)}>
          Receive payment
        </button>
      )}
      {d.status === 'draft' && (
        <button
          type="button"
          className="secondary"
          disabled={props.busy}
          onClick={() =>
            act(async () => {
              await db.markDocSent(d.id);
              announce(`${d.kind === 'invoice' ? 'Invoice' : 'Estimate'} ${d.number} marked sent`);
            })
          }
        >
          Mark as sent
        </button>
      )}
      {d.kind === 'estimate' && !d.convertedTo && (
        <>
          <button
            type="button"
            disabled={props.busy}
            onClick={() =>
              act(
                () => db.convertEstimate(d.id, todayIso()),
                () => props.onDone(null),
              )
            }
          >
            Convert to invoice
          </button>
          {d.status !== 'accepted' && (
            <button
              type="button"
              className="secondary"
              disabled={props.busy}
              onClick={() => act(() => db.setEstimateStatus(d.id, 'accepted'))}
            >
              Accepted
            </button>
          )}
          {d.status !== 'declined' && (
            <button
              type="button"
              className="secondary"
              disabled={props.busy}
              onClick={() => act(() => db.setEstimateStatus(d.id, 'declined'))}
            >
              Declined
            </button>
          )}
        </>
      )}
      <button type="button" onClick={() => setSending(true)}>
        Send…
      </button>
      <button
        type="button"
        className="secondary"
        disabled={props.busy}
        onClick={() =>
          void props.run(async () => {
            const pdf = await db.docPdf(d.id);
            download(pdf.fileName, pdf.bytes as Uint8Array<ArrayBuffer>, 'application/pdf');
          })
        }
      >
        Download PDF
      </button>
      {sending && (
        <SendDialog
          doc={d}
          onClose={() => setSending(false)}
          onSent={() => {
            setSending(false);
            props.onChanged();
          }}
        />
      )}
      <button type="button" className="secondary" onClick={() => props.onDuplicate(d)}>
        Duplicate
      </button>
      {d.kind === 'invoice' && props.onMakeRecurring && (
        <button
          type="button"
          className="secondary"
          title="Make an invoice like this one every month (or quarter, or year)"
          onClick={() => props.onMakeRecurring!(d)}
        >
          Make recurring
        </button>
      )}
      {!d.hasPayments && (
        <button
          type="button"
          className="secondary"
          disabled={props.busy}
          onClick={() => {
            if (!confirm(`Void ${d.kind} ${d.number}? It stays on record, marked void.`)) return;
            act(() => db.voidSalesDoc(d.id));
          }}
        >
          Void
        </button>
      )}
      {props.payments.length === 0 && !d.convertedTo && d.status === 'draft' && (
        <button
          type="button"
          className="secondary"
          disabled={props.busy}
          onClick={() => {
            if (!confirm(`Delete draft ${d.kind} ${d.number}?`)) return;
            act(
              () => db.deleteSalesDoc(d.id),
              () => props.onDone(null),
            );
          }}
        >
          Delete
        </button>
      )}
    </>
  );
}

// ---- receiving a payment ----

const METHODS = ['Check', 'ACH', 'Card', 'Cash', 'Zelle', 'Other'];

function ReceivePaymentDialog(props: {
  customerId: string | null;
  docId: string | null;
  onClose: () => void;
}) {
  const [customerId, setCustomerId] = useState(props.customerId ?? '');
  const [open, setOpen] = useState<Doc[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [deposit, setDeposit] = useState('');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('Check');
  const [ref, setRef] = useState('');
  const { attempt, busy, error, setError, dialog } = useClosedPeriodOverride();

  useEffect(() => {
    void db.accounts().then((list) => {
      setAccounts(list);
      const bank = list.find((a) => a.active && a.type === 'asset' && a.detailType === 'bank');
      setDeposit((d) => d || bank?.id || '');
    });
  }, []);

  useEffect(() => {
    if (!customerId) return;
    void db.salesDocs({ kind: 'invoice', customerId, openOnly: true }).then((docs) => {
      const oldestFirst = [...docs].reverse();
      setOpen(oldestFirst);
      setAmounts(
        Object.fromEntries(
          oldestFirst.map((d) => [
            d.id,
            !props.docId || d.id === props.docId ? formatMoney(d.owed) : '',
          ]),
        ),
      );
    });
  }, [customerId, props.docId]);

  const applications = open
    .map((d) => ({ docId: d.id, amount: amounts[d.id]?.trim() ? parseMoney(amounts[d.id]!) : 0 }))
    .filter((a) => a.amount !== 0);
  const total: Cents = applications.reduce((s, a) => s + (a.amount ?? 0), 0);

  const save = () => {
    if (applications.some((a) => a.amount === null || a.amount! < 0)) {
      setError('Enter each amount paid as a positive amount.');
      return;
    }
    void attempt(async (passphrase) => {
      await db.receivePayment(
        {
          customerId,
          date,
          depositAccountId: deposit,
          method,
          ref,
          memo: null,
          applications: applications as { docId: string; amount: number }[],
        },
        passphrase,
      );
      announce(`Received ${formatMoney(total)}${open[0] ? ` from ${open[0].customer}` : ''}`);
      props.onClose();
    });
  };

  return (
    <Dialog title="Receive payment" onClose={busy ? undefined : props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <CustomerSelect label="Customer" value={customerId} onChange={(p) => setCustomerId(p.id)} />
        {customerId && open.length === 0 && <p className="muted">This customer owes nothing.</p>}
        {open.length > 0 && (
          <table className="list">
            <thead>
              <tr>
                <th>Invoice</th>
                <th>Due</th>
                <th className="num">Owed</th>
                <th className="num">Paid now</th>
              </tr>
            </thead>
            <tbody>
              {open.map((d) => (
                <Fragment key={d.id}>
                  <tr>
                    <td>
                      {d.number} <span className="muted small">{formatDate(d.date)}</span>
                    </td>
                    <td>{formatDate(d.dueDate)}</td>
                    <td className="num">{formatMoney(d.owed)}</td>
                    <td>
                      <MoneyInput
                        ariaLabel={`Paid on invoice ${d.number}`}
                        value={amounts[d.id] ?? ''}
                        onChange={(v) => setAmounts({ ...amounts, [d.id]: v })}
                      />
                    </td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total received</td>
                <td className="num">
                  <strong>{formatMoney(total)}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        )}
        <div className="fields">
          <label className="short">
            Date
            <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
          </label>
          <AccountSelect
            label="Deposited to"
            accounts={accounts.filter((a) => a.type === 'asset')}
            value={deposit}
            onChange={setDeposit}
          />
          <label className="short">
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <TextField label="Ref / check no." value={ref} onChange={setRef} width="short" />
        </div>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy || !customerId || !deposit || total <= 0}>
            {busy ? 'Saving…' : `Receive ${formatMoney(total)}`}
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

// ---- sending: the share sheet, or download plus the mail app (AR-4) ----

type DocPdf = Awaited<ReturnType<typeof db.docPdf>>;

/**
 * Send an invoice or estimate. Sending straight from the app would need a
 * server, so the PDF goes through the share sheet where Chrome offers one
 * with files, or is downloaded while the mail app opens with the email filled
 * in. Either marks the document sent.
 */
function SendDialog(props: { doc: Doc; onClose: () => void; onSent: () => void }) {
  const [pdf, setPdf] = useState<DocPdf | null>(null);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => {
    void db.docPdf(props.doc.id).then((p) => {
      setPdf(p);
      setTo(p.email ?? '');
      setSubject(p.subject);
      setBody(p.body);
    });
  }, [props.doc.id]);

  const file = pdf
    ? new File([pdf.bytes as Uint8Array<ArrayBuffer>], pdf.fileName, { type: 'application/pdf' })
    : null;
  const canShare =
    !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });

  const sent = async () => {
    await db.markDocSent(props.doc.id);
    announce(
      `${props.doc.kind === 'invoice' ? 'Invoice' : 'Estimate'} ${props.doc.number} marked sent`,
    );
    props.onSent();
  };

  return (
    <Dialog
      title={`Send ${props.doc.kind} ${props.doc.number}`}
      onClose={busy ? undefined : props.onClose}
    >
      {!pdf ? (
        <p className="muted">Making the PDF…</p>
      ) : (
        <>
          <TextField
            label="To"
            value={to}
            onChange={setTo}
            hint={to ? undefined : 'No email on file for this customer (add it on Payees)'}
          />
          <TextField label="Subject" value={subject} onChange={setSubject} />
          <label>
            Message
            <textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
          <p className="muted small">
            {pdf.fileName} ·{' '}
            <button
              type="button"
              className="link"
              onClick={() => {
                const url = URL.createObjectURL(file!);
                window.open(url, '_blank', 'noopener');
                setTimeout(() => URL.revokeObjectURL(url), 60_000);
              }}
            >
              Preview
            </button>
          </p>
          <ErrorText>{error}</ErrorText>
          <div className="buttons">
            {canShare && (
              <button
                type="button"
                disabled={busy}
                title="Your system's share sheet, with the PDF attached: pick your mail app"
                onClick={() =>
                  void run(async () => {
                    try {
                      await navigator.share({ files: [file!], title: subject, text: body });
                    } catch (e) {
                      if (e instanceof DOMException && e.name === 'AbortError') return;
                      throw e;
                    }
                    await sent();
                  })
                }
              >
                Share…
              </button>
            )}
            <button
              type="button"
              className={canShare ? 'secondary' : undefined}
              disabled={busy}
              title="Saves the PDF and opens your mail app with this email; attach the PDF there"
              onClick={() =>
                void run(async () => {
                  download(pdf.fileName, pdf.bytes as Uint8Array<ArrayBuffer>, 'application/pdf');
                  const a = document.createElement('a');
                  a.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
                    `${body}\n\n(${pdf.fileName} is attached.)`,
                  )}`;
                  a.click();
                  await sent();
                })
              }
            >
              Download and email
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>
              Cancel
            </button>
          </div>
          {!canShare && (
            <p className="muted small">
              Your mail app opens with the email filled in; attach the PDF that was just saved to
              your Downloads folder.
            </p>
          )}
        </>
      )}
    </Dialog>
  );
}
