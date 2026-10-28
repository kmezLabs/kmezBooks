// Transactions (GL-9): the home panel. Every entry (or every income and
// expense) in date order, opening at the latest; filters at the top, totals
// and Add Transaction at the bottom. With one account chosen it reads like a
// bank register, with the balance after each transaction. Quick changes from
// the list: edit, void and, where the company allows it, delete (GL-6).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  RegisterQuery,
  RegisterResult,
  RegisterRow,
  SimpleEntry,
} from '../../ledger/register';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney, type Cents } from '../../shared/money';
import { RANGE_PRESETS, rangeFor, type RangePreset } from '../../shared/periods';
import { db } from '../../shared/workerClient';
import { SOURCES } from '../EntryPeek';
import type { SessionStatus } from '../../worker/companySession';
import {
  AccountSelect,
  MoneyInput,
  cents,
  formatDate,
  todayIso,
  useClosedPeriodOverride,
  PayeeField,
} from '../ledgerUi';
import { registerAccount, setRegisterAccount } from '../settings';
import { Dialog, ErrorText } from '../ui';

const PAGE = 200;
type Period = RangePreset | 'all';

const DEFAULT_PERIOD: Exclude<RangePreset, 'custom'> = 'this_year_to_date';

/** With one account chosen: how its money in and out are named, and how its balance reads. */
interface AccountView {
  out: string;
  in: string;
  /** A card or loan shows what's owed as a positive balance */
  sign: 1 | -1;
}

function accountView(a: AccountRow | undefined): AccountView | null {
  if (!a) return null;
  if (a.type === 'liability') return { out: 'Charge', in: 'Payment', sign: -1 };
  if (a.type === 'asset') return { out: 'Payment', in: 'Deposit', sign: 1 };
  return { out: 'Decrease', in: 'Increase', sign: a.type === 'expense' ? 1 : -1 };
}

export function RegisterPage(props: {
  status: SessionStatus;
  onOpenEntry: (id: number) => void;
  /** Only this payee's transactions, chosen on the Payees page (GL-11) */
  payee?: { id: string; name: string } | null;
  onClearPayee?: () => void;
}) {
  const companyId = props.status.companyId ?? '';
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [fyStartMonth, setFyStartMonth] = useState(1);
  const [postedEdits, setPostedEdits] = useState(false);
  // Opens on this year to date (owner's choice, Oct 28); calendar year until
  // the company's fiscal year is read
  const [period, setPeriod] = useState<Period>(DEFAULT_PERIOD);
  const periodNow = useRef<Period>(DEFAULT_PERIOD);
  const [query, setQuery] = useState<RegisterQuery>(() => ({
    scope: 'all',
    order: 'asc',
    accountId: registerAccount(companyId),
    ...rangeFor(DEFAULT_PERIOD, todayIso(), 1),
  }));
  const [limit, setLimit] = useState(PAGE);
  const [result, setResult] = useState<RegisterResult | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  // Where to put the view after the next result: at the latest transaction,
  // or where it was after loading earlier ones
  const scroll = useRef<'latest' | { fromBottom: number } | null>('latest');
  const readOnly = props.status.readOnly;

  useEffect(() => {
    void db.accounts().then((list) => {
      setAccounts(list);
      // A remembered account that no longer exists is forgotten
      setQuery((q) =>
        q.accountId && !list.some((a) => a.id === q.accountId) ? { ...q, accountId: null } : q,
      );
    });
    void db.details().then((d) => {
      setFyStartMonth(d.fiscalYearStartMonth);
      // A preset follows the company's fiscal year, and today's date
      const p = periodNow.current;
      if (p !== 'all' && p !== 'custom') {
        setQuery((q) => ({ ...q, ...rangeFor(p, todayIso(), d.fiscalYearStartMonth) }));
      }
    });
    void db.postedEdits().then(setPostedEdits);
  }, [props.status.companyId, props.status.lastSavedAt]);

  useEffect(() => {
    let current = true;
    const t = setTimeout(() => {
      void db
        .register({
          ...query,
          payeeId: props.payee?.id ?? null,
          limit,
          balanceAccountId: query.accountId ?? null,
        })
        .then((r) => current && setResult(r));
    }, 150);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [query, limit, props.status.lastSavedAt, version, props.payee?.id]);

  useLayoutEffect(() => {
    const target = scroll.current;
    if (!result || !target) return;
    scroll.current = null;
    const root = document.documentElement;
    if (target === 'latest') {
      window.scrollTo(0, query.order === 'asc' ? root.scrollHeight : 0);
    } else {
      window.scrollTo(0, root.scrollHeight - target.fromBottom);
    }
  }, [result, query.order]);

  const changed = () => {
    setOpen(null);
    setVersion((v) => v + 1);
  };
  const setQ = (q: Partial<RegisterQuery>) => {
    setLimit(PAGE);
    scroll.current = 'latest';
    setQuery({ ...query, ...q });
  };
  const choosePeriod = (p: Period) => {
    setPeriod(p);
    periodNow.current = p;
    if (p === 'all') setQ({ from: null, to: null });
    else if (p !== 'custom') setQ(rangeFor(p, todayIso(), fyStartMonth));
  };
  const more = () => {
    if (query.order === 'asc') {
      const root = document.documentElement;
      scroll.current = { fromBottom: root.scrollHeight - window.scrollY };
    }
    setLimit(limit + PAGE);
  };

  const chosen = accounts.find((a) => a.id === query.accountId);
  const view = accountView(chosen);
  const net = result ? result.totals.income - result.totals.expense : 0;
  const remaining = result ? result.count - result.rows.length : 0;
  const moreButton = remaining > 0 && (
    <div className="buttons">
      <button className="secondary" onClick={more}>
        {query.order === 'asc' ? 'Show earlier' : 'Show more'} ({remaining.toLocaleString('en-US')}{' '}
        more)
      </button>
    </div>
  );

  return (
    <section className="register">
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
              choosePeriod('custom');
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
              choosePeriod('custom');
              setQ({ to: e.target.value || null });
            }}
          />
        </label>
        <AccountSelect
          label="Account"
          accounts={accounts}
          value={query.accountId ?? ''}
          onChange={(id) => {
            setRegisterAccount(companyId, id || null);
            setQ({ accountId: id || null });
          }}
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
        <label className="medium">
          Show
          <select
            value={query.scope}
            onChange={(e) => setQ({ scope: e.target.value as 'pl' | 'all' })}
          >
            <option value="all">All transactions</option>
            <option value="pl">Income and expenses</option>
          </select>
        </label>
        <label className="short">
          Order
          <select
            value={query.order}
            onChange={(e) => setQ({ order: e.target.value as 'asc' | 'desc' })}
          >
            <option value="asc">Oldest first</option>
            <option value="desc">Newest first</option>
          </select>
        </label>
        {props.payee && (
          <span className="filter-chip">
            Payee: <strong>{props.payee.name}</strong>{' '}
            <button
              className="link"
              title="Show every payee's transactions"
              onClick={() => props.onClearPayee?.()}
            >
              ✕
            </button>
          </span>
        )}
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
          {query.order === 'asc' && moreButton}
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
                  {view ? (
                    <>
                      <th className="num">{view.out}</th>
                      <th className="num">{view.in}</th>
                      <th className="num">Balance</th>
                    </>
                  ) : (
                    <>
                      <th className="num">Income</th>
                      <th className="num">Expense</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <RegisterLine
                    key={r.id}
                    row={r}
                    view={view}
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
          {query.order === 'desc' && moreButton}
          <div className="register-foot">
            <p className="register-totals">
              <span>
                Income <strong>{formatMoney(result.totals.income)}</strong>
              </span>
              <span>
                Expenses <strong>{formatMoney(result.totals.expense)}</strong>
              </span>
              <span>
                Net{' '}
                <strong className={net < 0 ? 'error-text' : undefined}>{formatMoney(net)}</strong>
              </span>
              <span className="muted">
                {result.count.toLocaleString('en-US')}{' '}
                {result.count === 1 ? 'transaction' : 'transactions'}
              </span>
            </p>
            {!readOnly && <button onClick={() => setAdding(true)}>Add Transaction</button>}
          </div>
        </>
      )}
      {adding && (
        <Dialog title="Add transaction" onClose={() => setAdding(false)}>
          <QuickAdd
            accounts={accounts}
            defaultMoneyAccount={
              chosen && (chosen.type === 'asset' || chosen.type === 'liability') ? chosen.id : ''
            }
            onAdded={() => {
              setAdding(false);
              scroll.current = 'latest';
              changed();
            }}
            onCancel={() => setAdding(false)}
          />
        </Dialog>
      )}
    </section>
  );
}

function RegisterLine(props: {
  row: RegisterRow;
  view: AccountView | null;
  open: boolean;
  onToggle: () => void;
  accounts: AccountRow[];
  postedEdits: boolean;
  readOnly: boolean;
  onChanged: () => void;
  onOpenEntry: (id: number) => void;
}) {
  const r = props.row;
  const v = props.view;
  const isVoid = r.status === 'void';
  const money = (c: Cents | null) => (c ? formatMoney(c) : '');
  const moved = r.accountAmount ?? 0;
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
        {v ? (
          <>
            {/* Money out lowers the balance as it reads: a credit for a bank, a charge for a card */}
            <td className="num">{money(moved * v.sign < 0 ? Math.abs(moved) : null)}</td>
            <td className="num">{money(moved * v.sign > 0 ? Math.abs(moved) : null)}</td>
            <td className="num">{r.balance === null ? '' : formatMoney(r.balance * v.sign)}</td>
          </>
        ) : (
          <>
            <td className="num">{money(r.income)}</td>
            <td className="num">{money(r.expense)}</td>
          </>
        )}
      </tr>
      {props.open && (
        <tr className="editor">
          <td colSpan={v ? 8 : 7}>
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

const blankLine = (): LineDraft => ({ accountId: '', amount: '', memo: '' });

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
              <PayeeField value={payee} onChange={setPayee} />
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
        type="button"
        onClick={() => props.onChange([...props.lines, blankLine()])}
      >
        Split: add a line
      </button>
    </>
  );
}

/**
 * Add an expense or a deposit: the Add Transaction dialog (EX-1 to EX-3).
 * Payee, ref or check number, one category or a split over several, and
 * receipts attached (EX-2). A vendor's default category (AP-1) fills in the
 * category of an expense when the payee is chosen.
 */
function QuickAdd(props: {
  accounts: AccountRow[];
  defaultMoneyAccount: string;
  onAdded: () => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [date, setDate] = useState(todayIso());
  const [ref, setRef] = useState('');
  const [payee, setPayee] = useState('');
  const [money, setMoney] = useState(props.defaultMoneyAccount);
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);
  const [memo, setMemo] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const { attempt, busy, error, dialog } = useClosedPeriodOverride();
  const exclude = new Set(money ? [money] : []);
  const categories = props.accounts.filter(
    (a) => a.type === (kind === 'expense' ? 'expense' : 'income'),
  );
  const others = props.accounts.filter((a) => a.type !== 'asset' && a.type !== 'liability');
  const set = (i: number, c: Partial<LineDraft>) =>
    setLines(lines.map((l, n) => (n === i ? { ...l, ...c } : l)));
  const total = lines.reduce((t, l) => t + cents(l.amount), 0);
  const split = lines.length > 1;

  const choosePayee = (name: string) => {
    setPayee(name);
    if (kind !== 'expense') return;
    void db.payeeDefaultCategory(name).then((category) => {
      // Only into an empty category, never over one already chosen
      if (!category) return;
      setLines((current) =>
        current.length === 1 && !current[0]!.accountId
          ? [{ ...current[0]!, accountId: category }]
          : current,
      );
    });
  };

  const add = () =>
    attempt(async (passphrase) => {
      const id = await db.addRegisterEntry(
        {
          kind,
          moneyAccountId: money,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            amount: cents(l.amount),
            memo: l.memo.trim() || null,
          })),
        },
        { date, ref, name: payee, memo },
        passphrase,
      );
      for (const f of files) await db.addAttachment('journal_entry', String(id), f);
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
              setLines(lines.map((l) => ({ ...l, accountId: '' })));
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
        <label className="short">
          {kind === 'expense' ? 'Ref / check no.' : 'Ref'}
          <input value={ref} onChange={(e) => setRef(e.target.value)} />
        </label>
        <label>
          Payee
          <PayeeField
            value={payee}
            onChange={choosePayee}
            placeholder={kind === 'expense' ? 'Paid to' : 'Received from'}
          />
        </label>
        <MoneyAccountSelect
          kind={kind}
          accounts={props.accounts}
          value={money}
          onChange={setMoney}
        />
      </div>
      {split ? (
        <>
          <CategoryLines
            accounts={categories.length ? categories : others}
            lines={lines}
            onChange={setLines}
            set={set}
            exclude={money}
          />
          <p className="muted small">Total {formatMoney(total)}</p>
        </>
      ) : (
        <div className="fields">
          <AccountSelect
            label="Category"
            accounts={categories.length ? categories : others}
            value={lines[0]!.accountId}
            exclude={exclude}
            onChange={(accountId) => set(0, { accountId })}
          />
          <label className="short">
            Amount
            <MoneyInput
              ariaLabel="Amount"
              value={lines[0]!.amount}
              onChange={(amount) => set(0, { amount })}
            />
          </label>
          <button
            type="button"
            className="link split-link"
            title="Spread the amount over several categories"
            onClick={() => setLines([...lines, blankLine()])}
          >
            Split
          </button>
        </div>
      )}
      <div className="fields">
        <label>
          Memo
          <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
        <label>
          {kind === 'expense' ? 'Receipts' : 'Attachments'}
          <input
            type="file"
            multiple
            accept="image/*,application/pdf"
            onChange={(e) => setFiles([...(e.target.files ?? [])])}
          />
          <span className="hint">Images or PDFs, stored encrypted in the company folder</span>
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="buttons">
        <button
          type="submit"
          disabled={busy || !money || lines.some((l) => !l.accountId || cents(l.amount) <= 0)}
        >
          Add {kind}
        </button>
        <button type="button" className="secondary" disabled={busy} onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {dialog}
    </form>
  );
}
