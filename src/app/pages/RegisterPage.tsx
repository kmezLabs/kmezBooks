// Transactions (GL-9): the home panel. Every income and expense (or every
// entry) in date order, with a quick form to add one and quick changes from
// the list: edit, void and, where the company allows it, delete (GL-6).

import { useEffect, useState } from 'react';
import type {
  RegisterQuery,
  RegisterResult,
  RegisterRow,
  SimpleEntry,
} from '../../ledger/register';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney } from '../../shared/money';
import { RANGE_PRESETS, rangeFor, type RangePreset } from '../../shared/periods';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import {
  AccountSelect,
  MoneyInput,
  cents,
  formatDate,
  todayIso,
  useClosedPeriodOverride,
} from '../ledgerUi';
import { ErrorText } from '../ui';

const PAGE = 200;
type Period = RangePreset | 'all';

const SOURCES: Record<string, string> = {
  journal: 'Journal entry',
  qbo_migration: 'From QuickBooks',
  bank: 'From bank review',
  register: 'Quick entry',
};

export function RegisterPage(props: { status: SessionStatus; onOpenEntry: (id: number) => void }) {
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [fyStartMonth, setFyStartMonth] = useState(1);
  const [postedEdits, setPostedEdits] = useState(false);
  const [period, setPeriod] = useState<Period>('all');
  const [query, setQuery] = useState<RegisterQuery>({ scope: 'pl', order: 'desc' });
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [version, setVersion] = useState(0);
  const readOnly = props.status.readOnly;

  useEffect(() => {
    void db.accounts().then(setAccounts);
    void db.details().then((d) => setFyStartMonth(d.fiscalYearStartMonth));
    void db.postedEdits().then(setPostedEdits);
  }, [props.status.companyId, props.status.lastSavedAt]);

  useEffect(() => {
    let current = true;
    const t = setTimeout(() => {
      void db.register({ ...query, limit }).then((r) => current && setResult(r));
    }, 150);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [query, limit, props.status.lastSavedAt, version]);

  const changed = () => {
    setOpen(null);
    setVersion((v) => v + 1);
  };
  const setQ = (q: Partial<RegisterQuery>) => {
    setLimit(PAGE);
    setQuery({ ...query, ...q });
  };
  const choosePeriod = (p: Period) => {
    setPeriod(p);
    if (p === 'all') setQ({ from: null, to: null });
    else if (p !== 'custom') setQ(rangeFor(p, todayIso(), fyStartMonth));
  };
  const net = result ? result.totals.income - result.totals.expense : 0;

  return (
    <section className="register">
      <h2>Transactions</h2>
      {!readOnly && <QuickAdd accounts={accounts} onAdded={changed} />}

      <div className="fields register-filters">
        <label className="short">
          Period
          <select value={period} onChange={(e) => choosePeriod(e.target.value as Period)}>
            <option value="all">All dates</option>
            {(Object.keys(RANGE_PRESETS) as RangePreset[]).map((p) => (
              <option key={p} value={p}>
                {RANGE_PRESETS[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="short">
          From
          <input
            type="date"
            value={query.from ?? ''}
            onChange={(e) => {
              setPeriod('custom');
              setQ({ from: e.target.value || null });
            }}
          />
        </label>
        <label className="short">
          To
          <input
            type="date"
            value={query.to ?? ''}
            onChange={(e) => {
              setPeriod('custom');
              setQ({ to: e.target.value || null });
            }}
          />
        </label>
        <AccountSelect
          label="Account"
          accounts={accounts}
          value={query.accountId ?? ''}
          onChange={(id) => setQ({ accountId: id || null })}
          emptyLabel="Any account"
        />
        <label>
          Search
          <input
            value={query.search ?? ''}
            placeholder="Payee, ref or memo"
            onChange={(e) => setQ({ search: e.target.value })}
          />
        </label>
        <label>
          Show
          <select
            value={query.scope}
            onChange={(e) => setQ({ scope: e.target.value as 'pl' | 'all' })}
          >
            <option value="pl">Income and expenses</option>
            <option value="all">All transactions</option>
          </select>
        </label>
        <label className="short">
          Order
          <select
            value={query.order}
            onChange={(e) => setQ({ order: e.target.value as 'asc' | 'desc' })}
          >
            <option value="desc">Newest first</option>
            <option value="asc">Oldest first</option>
          </select>
        </label>
        <label className="check inline">
          <input
            type="checkbox"
            checked={!!query.includeVoid}
            onChange={(e) => setQ({ includeVoid: e.target.checked })}
          />
          Show void
        </label>
      </div>

      {result && (
        <>
          <p className="register-totals">
            <span>
              Income <strong>{formatMoney(result.totals.income)}</strong>
            </span>
            <span>
              Expenses <strong>{formatMoney(result.totals.expense)}</strong>
            </span>
            <span>
              Net <strong className={net < 0 ? 'error-text' : undefined}>{formatMoney(net)}</strong>
            </span>
            <span className="muted">
              {result.count.toLocaleString('en-US')}{' '}
              {result.count === 1 ? 'transaction' : 'transactions'}
            </span>
          </p>
          {result.rows.length === 0 ? (
            <p className="muted">No transactions match.</p>
          ) : (
            <table className="list register-list">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Ref</th>
                  <th>Payee</th>
                  <th>Category</th>
                  <th>Account</th>
                  <th className="num">Income</th>
                  <th className="num">Expense</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <RegisterLine
                    key={r.id}
                    row={r}
                    open={open === r.id}
                    onToggle={() => setOpen(open === r.id ? null : r.id)}
                    accounts={accounts}
                    postedEdits={postedEdits}
                    readOnly={readOnly}
                    onChanged={changed}
                    onOpenEntry={props.onOpenEntry}
                  />
                ))}
              </tbody>
            </table>
          )}
          {result.rows.length < result.count && (
            <div className="buttons">
              <button className="secondary" onClick={() => setLimit(limit + PAGE)}>
                Show more ({(result.count - result.rows.length).toLocaleString('en-US')} more)
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function RegisterLine(props: {
  row: RegisterRow;
  open: boolean;
  onToggle: () => void;
  accounts: AccountRow[];
  postedEdits: boolean;
  readOnly: boolean;
  onChanged: () => void;
  onOpenEntry: (id: number) => void;
}) {
  const r = props.row;
  const isVoid = r.status === 'void';
  return (
    <>
      <tr
        className={`clickable${isVoid ? ' inactive' : ''}${props.open ? ' open' : ''}`}
        onClick={props.onToggle}
        title="Show details and quick changes"
      >
        <td className="nowrap">{formatDate(r.date)}</td>
        <td>{r.ref}</td>
        <td>
          {r.name ?? <span className="muted">{r.memo}</span>}
          {isVoid && <span className="badge small">void</span>}
          {r.attachments > 0 && (
            <span className="badge small" title={`${r.attachments} attachment(s)`}>
              📎 {r.attachments}
            </span>
          )}
        </td>
        <td>{r.categories}</td>
        <td>{r.accounts}</td>
        <td className="num">{r.income ? formatMoney(r.income) : ''}</td>
        <td className="num">{r.expense ? formatMoney(r.expense) : ''}</td>
      </tr>
      {props.open && (
        <tr className="editor">
          <td colSpan={7}>
            <EntryEditor {...props} />
          </td>
        </tr>
      )}
    </>
  );
}

interface LineDraft {
  accountId: string;
  amount: string;
  memo: string;
}

/** Quick changes to one entry: the income or expense form, void, delete. */
function EntryEditor(props: {
  row: RegisterRow;
  accounts: AccountRow[];
  postedEdits: boolean;
  readOnly: boolean;
  onChanged: () => void;
  onOpenEntry: (id: number) => void;
}) {
  const r = props.row;
  const s = r.simple;
  const [date, setDate] = useState(r.date);
  const [ref, setRef] = useState(r.ref ?? '');
  const [payee, setPayee] = useState(r.name ?? '');
  const [memo, setMemo] = useState(r.memo ?? '');
  const [money, setMoney] = useState(s?.moneyAccountId ?? '');
  const [lines, setLines] = useState<LineDraft[]>(
    s?.lines.map((l) => ({
      accountId: l.accountId,
      amount: formatMoney(l.amount),
      memo: l.memo ?? '',
    })) ?? [],
  );
  const { attempt, busy, error, dialog } = useClosedPeriodOverride();
  const editable = r.status === 'posted' && !props.readOnly;
  const set = (i: number, c: Partial<LineDraft>) =>
    setLines(lines.map((l, n) => (n === i ? { ...l, ...c } : l)));
  const total = lines.reduce((t, l) => t + cents(l.amount), 0);

  const save = () =>
    attempt(async (passphrase) => {
      const simple: SimpleEntry = {
        kind: s!.kind,
        moneyAccountId: money,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          amount: cents(l.amount),
          memo: l.memo.trim() || null,
        })),
      };
      await db.saveSimpleEntry(r.id, simple, { date, ref, name: payee, memo }, passphrase);
      props.onChanged();
    });
  const voidIt = () => {
    const reason = prompt(
      'Void this transaction? It stays on record, marked void, and drops out of every balance and report.\n\nReason (optional):',
    );
    if (reason === null) return;
    void attempt(async (passphrase) => {
      await db.voidEntry(r.id, reason, passphrase);
      props.onChanged();
    });
  };
  const deleteIt = () => {
    if (
      !confirm(
        'Delete this transaction? It is removed from the books; the audit log keeps a record.',
      )
    )
      return;
    void attempt(async (passphrase) => {
      await db.deleteEntry(r.id, passphrase);
      props.onChanged();
    });
  };

  return (
    <div className="review-editor">
      <p className="muted small">
        {SOURCES[r.sourceType] ?? r.sourceType} · entry {r.id}{' '}
        <button className="link" onClick={() => props.onOpenEntry(r.id)}>
          Open in journal
        </button>
      </p>
      {editable && s ? (
        <>
          <div className="fields">
            <label className="short">
              Date
              <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="short">
              Ref
              <input value={ref} onChange={(e) => setRef(e.target.value)} />
            </label>
            <label>
              Payee
              <input value={payee} onChange={(e) => setPayee(e.target.value)} />
            </label>
            <label>
              Memo
              <input value={memo} onChange={(e) => setMemo(e.target.value)} />
            </label>
            <MoneyAccountSelect
              kind={s.kind}
              accounts={props.accounts}
              value={money}
              onChange={setMoney}
            />
          </div>
          <CategoryLines
            accounts={props.accounts}
            lines={lines}
            onChange={setLines}
            set={set}
            exclude={money}
          />
          <p className="muted small">Total {formatMoney(total)}</p>
        </>
      ) : (
        editable && (
          <p className="muted">
            This entry has several accounts on both sides. Change it in the journal.
          </p>
        )
      )}
      <ErrorText>{error}</ErrorText>
      {editable && (
        <div className="buttons">
          {s && (
            <button
              disabled={busy || !money || lines.some((l) => !l.accountId || !cents(l.amount))}
              onClick={() => void save()}
            >
              {props.postedEdits ? 'Save changes' : 'Save correction'}
            </button>
          )}
          <button className="secondary" disabled={busy} onClick={voidIt}>
            Void
          </button>
          {props.postedEdits && (
            <button className="secondary" disabled={busy} onClick={deleteIt}>
              Delete
            </button>
          )}
          {s && !props.postedEdits && (
            <span className="muted small">
              A correction voids this transaction and enters the corrected copy (GL-6).
            </span>
          )}
        </div>
      )}
      {dialog}
    </div>
  );
}

function MoneyAccountSelect(props: {
  kind: 'expense' | 'income';
  accounts: AccountRow[];
  value: string;
  onChange: (id: string) => void;
}) {
  const money = props.accounts.filter((a) => a.type === 'asset' || a.type === 'liability');
  return (
    <AccountSelect
      label={props.kind === 'expense' ? 'Paid from' : 'Deposited to'}
      accounts={money}
      value={props.value}
      onChange={props.onChange}
    />
  );
}

function CategoryLines(props: {
  accounts: AccountRow[];
  lines: LineDraft[];
  onChange: (lines: LineDraft[]) => void;
  set: (i: number, c: Partial<LineDraft>) => void;
  exclude: string;
}) {
  const exclude = new Set(props.exclude ? [props.exclude] : []);
  return (
    <>
      <table className="lines">
        <thead>
          <tr>
            <th>Category</th>
            <th className="num">Amount</th>
            <th>Line memo</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.lines.map((l, i) => (
            <tr key={i}>
              <td>
                <AccountSelect
                  accounts={props.accounts}
                  value={l.accountId}
                  exclude={exclude}
                  onChange={(id) => props.set(i, { accountId: id })}
                />
              </td>
              <td>
                <MoneyInput
                  ariaLabel={`Line ${i + 1} amount`}
                  value={l.amount}
                  onChange={(v) => props.set(i, { amount: v })}
                />
              </td>
              <td>
                <input
                  aria-label={`Line ${i + 1} memo`}
                  value={l.memo}
                  onChange={(e) => props.set(i, { memo: e.target.value })}
                />
              </td>
              <td>
                {props.lines.length > 1 && (
                  <button
                    className="link muted"
                    onClick={() => props.onChange(props.lines.filter((_, n) => n !== i))}
                  >
                    remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        className="link"
        onClick={() => props.onChange([...props.lines, { accountId: '', amount: '', memo: '' }])}
      >
        Split: add a line
      </button>
    </>
  );
}

/** Add an income or expense in one line. */
function QuickAdd(props: { accounts: AccountRow[]; onAdded: () => void }) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [date, setDate] = useState(todayIso());
  const [payee, setPayee] = useState('');
  const [money, setMoney] = useState('');
  const [category, setCategory] = useState('');
  const [amount, setAmount] = useState('');
  const [memo, setMemo] = useState('');
  const [added, setAdded] = useState<string | null>(null);
  const { attempt, busy, error, dialog } = useClosedPeriodOverride();
  const exclude = new Set(money ? [money] : []);
  const categories = props.accounts.filter(
    (a) => a.type === (kind === 'expense' ? 'expense' : 'income'),
  );
  const others = props.accounts.filter((a) => a.type !== 'asset' && a.type !== 'liability');

  const add = () =>
    attempt(async (passphrase) => {
      await db.addRegisterEntry(
        {
          kind,
          moneyAccountId: money,
          lines: [{ accountId: category, amount: cents(amount), memo: null }],
        },
        { date, name: payee, memo },
        passphrase,
      );
      setAdded(
        `Added ${kind === 'expense' ? 'expense' : 'income'} ${formatMoney(cents(amount))}${payee ? ` (${payee})` : ''}.`,
      );
      setPayee('');
      setAmount('');
      setMemo('');
      setCategory('');
      props.onAdded();
    });

  return (
    <form
      className="quick-add"
      onSubmit={(e) => {
        e.preventDefault();
        void add();
      }}
    >
      <div className="segmented" role="group" aria-label="Kind">
        {(['expense', 'income'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={k === kind ? '' : 'secondary'}
            aria-pressed={k === kind}
            onClick={() => {
              setKind(k);
              setCategory('');
            }}
          >
            {k === 'expense' ? 'Expense' : 'Income'}
          </button>
        ))}
      </div>
      <div className="fields">
        <label className="short">
          Date
          <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Payee
          <input
            value={payee}
            onChange={(e) => setPayee(e.target.value)}
            placeholder={kind === 'expense' ? 'Paid to' : 'Received from'}
          />
        </label>
        <MoneyAccountSelect
          kind={kind}
          accounts={props.accounts}
          value={money}
          onChange={setMoney}
        />
        <AccountSelect
          label="Category"
          accounts={categories.length ? categories : others}
          value={category}
          exclude={exclude}
          onChange={setCategory}
        />
        <label className="short">
          Amount
          <MoneyInput ariaLabel="Amount" value={amount} onChange={setAmount} />
        </label>
        <label>
          Memo
          <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
        <div className="buttons">
          <button type="submit" disabled={busy || !money || !category || cents(amount) <= 0}>
            Add {kind}
          </button>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
      {added && !error && <p className="muted small">{added}</p>}
      {dialog}
    </form>
  );
}
