// Bills (AP-2 to AP-5): bills due, sorted by due date, the bill form with
// lines by account and attachments, and paying bills. A bill never posts; a
// payment posts its expenses on the day it's paid (cash basis, GL-8).

import { useEffect, useState } from 'react';
import type { Payee } from '../../ledger/payees';
import {
  AccountSelect,
  MoneyInput,
  formatDate,
  openAttachmentFile,
  todayIso,
  useClosedPeriodOverride,
} from '../../app/ledgerUi';
import { PartySelect } from '../../app/PartySelect';
import { Dialog, ErrorText, TextField, formatBytes, useAction } from '../../app/ui';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney, parseMoney, type Cents } from '../../shared/money';
import { addDays } from '../../shared/periods';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import type { AttachmentRow } from '../../worker/attachments';
import type { BillPayment } from './billPayments';
import { NOT_ON_BILLS, PAID_FROM, type BillState } from './billRules';
import type { Bill, BillInput, BillLineInput, BillsDue } from './bills';

type Filter = 'due' | 'all' | 'paid' | 'void';

const FILTER_LABELS: Record<Filter, string> = {
  due: 'Bills due',
  all: 'All',
  paid: 'Paid',
  void: 'Void',
};

const STATE_LABELS: Record<BillState, string> = {
  open: 'open',
  partial: 'partly paid',
  paid: 'paid',
  overdue: 'overdue',
  void: 'void',
};

function BillBadge({ state }: { state: BillState }) {
  return (
    <span
      className={`badge small${state === 'overdue' ? ' warn' : ''}${state === 'void' ? ' muted' : ''}`}
    >
      {STATE_LABELS[state]}
    </span>
  );
}

const billName = (b: { vendor: string; number: string | null }) =>
  `${b.vendor}${b.number ? ` ${b.number}` : ''}`;

/** Accounts a bill line can go to: anything but money accounts, A/R and A/P. */
const lineAccounts = (accounts: AccountRow[]) =>
  accounts.filter((a) => !NOT_ON_BILLS.includes(a.detailType));

export function BillsPage({ status }: { status: SessionStatus }) {
  const [view, setView] = useState<{ id: string | null; copyOf?: Bill } | null>(null);
  const [bills, setBills] = useState<Bill[] | null>(null);
  const [due, setDue] = useState<BillsDue | null>(null);
  const [filter, setFilter] = useState<Filter>('due');
  const [paying, setPaying] = useState<{ vendorId: string | null; billId: string | null } | null>(
    null,
  );
  const [version, setVersion] = useState(0);
  const readOnly = status.readOnly;

  useEffect(() => {
    void db.bills(filter === 'due' ? { openOnly: true } : {}).then(setBills);
    void db.billsDue().then(setDue);
  }, [filter, status.companyId, status.lastSavedAt, version]);

  const changed = () => setVersion((v) => v + 1);
  const payDialog = paying && (
    <PayBillsDialog
      vendorId={paying.vendorId}
      billId={paying.billId}
      onClose={() => {
        setPaying(null);
        changed();
      }}
    />
  );

  if (view) {
    return (
      <>
        <BillForm
          key={view.id ?? 'new'}
          id={view.id}
          copyOf={view.copyOf}
          readOnly={readOnly}
          version={version}
          onDone={(id) => {
            setView(id ? { id } : null);
            changed();
          }}
          onDuplicate={(b) => setView({ id: null, copyOf: b })}
          onPay={(b) => setPaying({ vendorId: b.vendorId, billId: b.id })}
          onChanged={changed}
        />
        {payDialog}
      </>
    );
  }
  if (!bills) return null;
  const shown = bills.filter((b) =>
    filter === 'paid' ? b.state === 'paid' : filter === 'void' ? b.state === 'void' : true,
  );

  return (
    <section>
      <h2>Bills</h2>
      <p className="muted">
        A bill records what you owe a vendor; nothing goes into the books until you pay it, which
        then counts as an expense on the day you pay (cash basis).
      </p>
      <div className="buttons">
        {!readOnly && <button onClick={() => setView({ id: null })}>New bill</button>}
        {!readOnly && (
          <button className="secondary" onClick={() => setPaying({ vendorId: null, billId: null })}>
            Pay bills
          </button>
        )}
        <span className="segmented" role="group" aria-label="Show">
          {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
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
      {due && due.owed > 0 && (
        <p>
          You owe <strong>{formatMoney(due.owed)}</strong> on bills
          {due.overdue > 0 && (
            <>
              ; <strong>{formatMoney(due.overdue)}</strong> is overdue
            </>
          )}
          {due.dueSoon > 0 && (
            <>
              ; <strong>{formatMoney(due.dueSoon)}</strong> is due within a week
            </>
          )}
          .
        </p>
      )}
      {shown.length === 0 ? (
        <p className="muted">
          {filter === 'due' ? 'No bills due.' : `No bills${filter === 'all' ? ' yet' : ''}.`}
        </p>
      ) : (
        <table className="list two-line">
          <thead>
            <tr>
              <th>Due</th>
              <th className="wide">Vendor</th>
              <th className="num">Total</th>
              <th className="num">Owed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.id} className="clickable" onClick={() => setView({ id: b.id })}>
                <td className="nowrap">
                  <div>{formatDate(b.dueDate)}</div>
                  <div className="sub">Billed {formatDate(b.date)}</div>
                </td>
                <td className="wide">
                  <div className="line">
                    {b.vendor}
                    {b.attachments > 0 && (
                      <span title={`${b.attachments} attachment(s)`}> 📎{b.attachments}</span>
                    )}
                  </div>
                  <div className="sub line">
                    {[b.number ? `No. ${b.number}` : '', b.memo ?? ''].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td className="num">{formatMoney(b.total)}</td>
                <td className="num">{b.owed ? formatMoney(b.owed) : ''}</td>
                <td className="nowrap">
                  <BillBadge state={b.state} />
                  {!readOnly && b.owed > 0 && (
                    <>
                      {' '}
                      <button
                        className="link"
                        onClick={(e) => {
                          e.stopPropagation();
                          setPaying({ vendorId: b.vendorId, billId: b.id });
                        }}
                      >
                        Pay
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {payDialog}
    </section>
  );
}

// ---- the bill form ----

interface LineRow {
  key: number;
  accountId: string;
  description: string;
  amount: string;
}

let nextKey = 1;
const blankRow = (accountId = ''): LineRow => ({
  key: nextKey++,
  accountId,
  description: '',
  amount: '',
});
const rowsFrom = (lines: BillLineInput[]): LineRow[] =>
  lines.map((l) => ({
    key: nextKey++,
    accountId: l.accountId,
    description: l.description ?? '',
    amount: formatMoney(l.amount),
  }));

function BillForm(props: {
  id: string | null;
  copyOf?: Bill;
  readOnly: boolean;
  version: number;
  onDone: (id: string | null) => void;
  onDuplicate: (b: Bill) => void;
  onPay: (b: Bill) => void;
  onChanged: () => void;
}) {
  const c = props.copyOf;
  const [bill, setBill] = useState<Bill | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [payments, setPayments] = useState<BillPayment[]>([]);
  const [files, setFiles] = useState<AttachmentRow[]>([]);
  // Files chosen for a bill not saved yet; added once it is
  const [pending, setPending] = useState<File[]>([]);
  const [vendorId, setVendorId] = useState(c?.vendorId ?? '');
  const [defaultAccount, setDefaultAccount] = useState('');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(todayIso());
  const [termsDays, setTermsDays] = useState<number | null>(c?.termsDays ?? null);
  const [dueDate, setDueDate] = useState('');
  const [dueTouched, setDueTouched] = useState(false);
  const [memo, setMemo] = useState(c?.memo ?? '');
  const [rows, setRows] = useState<LineRow[]>(c ? rowsFrom(c.lines) : [blankRow()]);
  const [loaded, setLoaded] = useState(false);
  const { busy, error, setError, run } = useAction();
  const override = useClosedPeriodOverride();

  useEffect(() => {
    void db.accounts().then(setAccounts);
  }, []);

  useEffect(() => {
    if (!props.id) return;
    void db.bill(props.id).then((b) => {
      setBill(b);
      setVendorId(b.vendorId);
      setNumber(b.number ?? '');
      setDate(b.date);
      setTermsDays(b.termsDays);
      setDueDate(b.dueDate);
      setDueTouched(true);
      setMemo(b.memo ?? '');
      setRows(rowsFrom(b.lines));
      setLoaded(true);
    });
    void db.billPayments({ billId: props.id }).then(setPayments);
    void db.billFiles(props.id).then(setFiles);
  }, [props.id, props.version]);

  const shownDue = dueTouched
    ? dueDate
    : termsDays !== null && date
      ? addDays(date, termsDays)
      : date;
  const locked = !!bill?.hasPayments;
  const editable = !props.readOnly && bill?.status !== 'void';
  const total = rows.reduce((s, r) => s + (parseMoney(r.amount) ?? 0), 0);
  const setRow = (key: number, change: Partial<LineRow>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const chooseVendor = (p: Payee) => {
    setVendorId(p.id);
    setTermsDays(p.termsDays);
    if (!dueTouched) setDueDate('');
    // The vendor's default category fills lines with no account yet (AP-1)
    if (p.defaultAccountId) {
      setDefaultAccount(p.defaultAccountId);
      setRows(rows.map((r) => (r.accountId ? r : { ...r, accountId: p.defaultAccountId! })));
    }
  };

  const save = () => {
    const lines: BillLineInput[] = [];
    for (const r of rows) {
      if (!r.amount.trim() && !r.description.trim()) continue;
      const amount = parseMoney(r.amount);
      if (amount === null) {
        setError('Each line needs an amount.');
        return;
      }
      lines.push({ accountId: r.accountId, description: r.description, amount });
    }
    const input: BillInput = {
      vendorId,
      number,
      date,
      dueDate: dueTouched ? dueDate || null : null,
      termsDays,
      memo,
      lines,
    };
    void run(async () => {
      if (props.id) {
        await db.updateBill(props.id, input);
        props.onDone(props.id);
      } else {
        const id = await db.createBill(input);
        for (const f of pending) await db.addAttachment('bill', id, f);
        props.onDone(id);
      }
    });
  };

  if (props.id && !loaded) return null;
  return (
    <section>
      <div className="buttons">
        <button className="link" onClick={() => props.onDone(null)}>
          ← Bills
        </button>
      </div>
      <h2>
        {bill ? `Bill from ${billName(bill)}` : 'New bill'}{' '}
        {bill && <BillBadge state={bill.state} />}
      </h2>
      {bill && bill.status !== 'void' && (
        <p>
          Total {formatMoney(bill.total)} · paid {formatMoney(bill.paid)} ·{' '}
          <strong>owed {formatMoney(bill.owed)}</strong>
        </p>
      )}
      {locked && (
        <p className="muted">
          This bill has payments, so its vendor and lines are fixed. Void the payments below to
          change them; the number, dates and memo can still change.
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
                Vendor
                <input value={bill!.vendor} readOnly />
              </label>
            ) : (
              <PartySelect kind="vendor" label="Vendor" value={vendorId} onChange={chooseVendor} />
            )}
            <TextField
              label="Bill no."
              value={number}
              onChange={setNumber}
              width="short"
              hint="The vendor's, if any"
            />
            <label className="short">
              Date
              <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
            </label>
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
          </div>
          <table className="lines bill-lines">
            <thead>
              <tr>
                <th>Account</th>
                <th>Description</th>
                <th className="num">Amount</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <td>
                    <AccountSelect
                      accounts={lineAccounts(accounts)}
                      value={r.accountId}
                      onChange={(accountId) => setRow(r.key, { accountId })}
                      emptyLabel={`Line ${i + 1} account`}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`Line ${i + 1} description`}
                      value={r.description}
                      disabled={locked}
                      onChange={(e) => setRow(r.key, { description: e.target.value })}
                    />
                  </td>
                  <td>
                    <MoneyInput
                      ariaLabel={`Line ${i + 1} amount`}
                      value={r.amount}
                      onChange={(amount) => setRow(r.key, { amount })}
                    />
                  </td>
                  <td>
                    {rows.length > 1 && !locked && (
                      <button
                        type="button"
                        className="link muted"
                        aria-label={`Remove line ${i + 1}`}
                        onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
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
                <td colSpan={2}>
                  {!locked && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => setRows([...rows, blankRow(defaultAccount)])}
                    >
                      + Add line
                    </button>
                  )}
                </td>
                <td className="num">
                  <strong>{formatMoney(total)}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
          <TextField label="Memo" value={memo} onChange={setMemo} />
        </fieldset>

        <h3>Attachments</h3>
        {files.length === 0 && pending.length === 0 && <p className="muted">None.</p>}
        <ul className="files">
          {files.map((f) => (
            <li key={f.id}>
              <button
                type="button"
                className="link"
                onClick={() => void run(() => openAttachmentFile(f.id))}
              >
                {f.fileName}
              </button>{' '}
              <span className="muted">{formatBytes(f.size)}</span>{' '}
              {!props.readOnly && (
                <button
                  type="button"
                  className="link muted"
                  onClick={() =>
                    void run(async () => {
                      await db.removeAttachment(f.id);
                      setFiles(await db.billFiles(props.id!));
                    })
                  }
                >
                  remove
                </button>
              )}
            </li>
          ))}
          {pending.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              {f.name} <span className="muted">{formatBytes(f.size)}, added on save</span>{' '}
              <button
                type="button"
                className="link muted"
                onClick={() => setPending(pending.filter((_, n) => n !== i))}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
        {!props.readOnly && (
          <label className="file-add">
            Add attachment
            <input
              type="file"
              multiple
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = '';
                if (!props.id) return setPending([...pending, ...picked]);
                void run(async () => {
                  for (const f of picked) await db.addAttachment('bill', props.id!, f);
                  setFiles(await db.billFiles(props.id!));
                  props.onChanged();
                });
              }}
            />
          </label>
        )}

        <ErrorText>{error ?? override.error}</ErrorText>
        <div className="buttons">
          {editable && (
            <button type="submit" disabled={busy || !vendorId}>
              {busy ? 'Saving…' : 'Save'}
            </button>
          )}
          <button type="button" className="secondary" onClick={() => props.onDone(null)}>
            {editable ? 'Cancel' : 'Back'}
          </button>
          {bill && !props.readOnly && (
            <>
              {bill.owed > 0 && (
                <button type="button" onClick={() => props.onPay(bill)}>
                  Pay
                </button>
              )}
              <button type="button" className="secondary" onClick={() => props.onDuplicate(bill)}>
                Duplicate
              </button>
              {bill.status !== 'void' && !bill.hasPayments && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`Void this bill from ${billName(bill)}? It stays on record.`))
                      return;
                    void run(async () => {
                      await db.voidBill(bill.id);
                      props.onChanged();
                    });
                  }}
                >
                  Void
                </button>
              )}
              {payments.length === 0 && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (!confirm(`Delete this bill from ${billName(bill)}?`)) return;
                    void run(async () => {
                      await db.deleteBill(bill.id);
                      props.onDone(null);
                    });
                  }}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </div>
      </form>

      {bill && payments.length > 0 && (
        <>
          <h3>Payments</h3>
          <table className="list">
            <thead>
              <tr>
                <th>Date</th>
                <th>Method</th>
                <th className="num">On this bill</th>
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
                    {formatMoney(p.applications.find((a) => a.billId === bill.id)?.amount ?? 0)}
                  </td>
                  <td className="num">
                    {formatMoney(p.amount)}
                    {p.applications.length > 1 && (
                      <span className="muted small"> ({p.applications.length} bills)</span>
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
                                'Void this payment? Its entry is voided and the bill is owed again.',
                              )
                            )
                              return;
                            void override.attempt(async (pass) => {
                              await db.voidBillPayment(p.id, null, pass);
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

// ---- paying bills ----

const METHODS = ['Check', 'ACH', 'Card', 'Cash', 'Other'];

function PayBillsDialog(props: {
  vendorId: string | null;
  billId: string | null;
  onClose: () => void;
}) {
  const [vendorId, setVendorId] = useState(props.vendorId ?? '');
  const [open, setOpen] = useState<Bill[]>([]);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [from, setFrom] = useState('');
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('Check');
  const [ref, setRef] = useState('');
  const { attempt, busy, error, setError, dialog } = useClosedPeriodOverride();

  useEffect(() => {
    void db.accounts().then((list) => {
      setAccounts(list);
      const bank = list.find((a) => a.active && a.detailType === 'bank');
      setFrom((f) => f || bank?.id || '');
    });
  }, []);

  useEffect(() => {
    if (!vendorId) return;
    void db.bills({ vendorId, openOnly: true }).then((list) => {
      setOpen(list);
      setAmounts(
        Object.fromEntries(
          list.map((b) => [
            b.id,
            !props.billId || b.id === props.billId ? formatMoney(b.owed) : '',
          ]),
        ),
      );
    });
  }, [vendorId, props.billId]);

  const applications = open
    .map((b) => ({ billId: b.id, amount: amounts[b.id]?.trim() ? parseMoney(amounts[b.id]!) : 0 }))
    .filter((a) => a.amount !== 0);
  const total: Cents = applications.reduce((s, a) => s + (a.amount ?? 0), 0);

  const save = () => {
    if (applications.some((a) => a.amount === null || a.amount! < 0)) {
      setError('Enter each amount paid as a positive amount.');
      return;
    }
    void attempt(async (passphrase) => {
      await db.payBills(
        {
          vendorId,
          date,
          accountId: from,
          method,
          ref,
          memo: null,
          applications: applications as { billId: string; amount: number }[],
        },
        passphrase,
      );
      props.onClose();
    });
  };

  return (
    <Dialog title="Pay bills" onClose={busy ? undefined : props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <PartySelect
          kind="vendor"
          label="Vendor"
          value={vendorId}
          onChange={(p) => setVendorId(p.id)}
        />
        {vendorId && open.length === 0 && <p className="muted">Nothing is owed to this vendor.</p>}
        {open.length > 0 && (
          <table className="list">
            <thead>
              <tr>
                <th>Bill</th>
                <th>Due</th>
                <th className="num">Owed</th>
                <th className="num">Pay now</th>
              </tr>
            </thead>
            <tbody>
              {open.map((b) => (
                <tr key={b.id}>
                  <td>
                    {b.number ?? <span className="muted">no number</span>}{' '}
                    <span className="muted small">{formatDate(b.date)}</span>
                  </td>
                  <td>
                    {formatDate(b.dueDate)} {b.state === 'overdue' && <BillBadge state="overdue" />}
                  </td>
                  <td className="num">{formatMoney(b.owed)}</td>
                  <td>
                    <MoneyInput
                      ariaLabel={`Pay on the bill due ${formatDate(b.dueDate)}`}
                      value={amounts[b.id] ?? ''}
                      onChange={(v) => setAmounts({ ...amounts, [b.id]: v })}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={3}>Total paid</td>
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
            label="Paid from"
            accounts={accounts.filter((a) => PAID_FROM.includes(a.detailType))}
            value={from}
            onChange={setFrom}
          />
          <label className="short">
            Method
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <TextField
            label={method === 'Check' ? 'Check no.' : 'Ref'}
            value={ref}
            onChange={setRef}
            width="short"
          />
        </div>
        <p className="muted small">
          One payment, so one line on your statement; its expenses go to each bill's accounts.
        </p>
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy || !vendorId || !from || total <= 0}>
            {busy ? 'Saving…' : `Pay ${formatMoney(total)}`}
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
