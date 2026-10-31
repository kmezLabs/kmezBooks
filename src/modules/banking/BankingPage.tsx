// Bank import (BK-1, BK-3 to BK-6, BK-9): import statements, then review
// each transaction: add it to the books with a category or split, match it to
// an entry already there, record a transfer, or exclude it.

import { Fragment, useEffect, useState } from 'react';
import {
  AccountSelect,
  MoneyInput,
  cents,
  formatDate,
  useClosedPeriodOverride,
  PayeeField,
} from '../../app/ledgerUi';
import { announce } from '../../app/statusMessages';
import { Dialog, ErrorText, formatDateTime, useAction } from '../../app/ui';
import type { AccountRow } from '../../shared/accounts';
import { formatMoney } from '../../shared/money';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import type { BankAccount } from './bankAccounts';
import { AccountPicker, count, flowCells, flowLabels, statementBalance } from './bankUi';
import type { QueueItem, QueueView } from './review';
import type { FileProblem, ImportRow, StatementImportResult, StatementPreview } from './statements';

const VIEWS: Record<QueueView, string> = {
  new: 'For review',
  reviewed: 'In the books',
  excluded: 'Excluded',
};

export function BankingPage({ status }: { status: SessionStatus }) {
  const [accounts, setAccounts] = useState<BankAccount[] | null>(null);
  const [ledger, setLedger] = useState<AccountRow[]>([]);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [view, setView] = useState<QueueView>('new');
  const [items, setItems] = useState<QueueItem[]>([]);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [reading, setReading] = useState<{
    statements: StatementPreview[];
    problems: FileProblem[];
  } | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // Bumped after every change, so the lists reload
  const [version, setVersion] = useState(0);
  const { busy, error, run } = useAction();
  const override = useClosedPeriodOverride();
  const readOnly = status.readOnly;

  useEffect(() => {
    void db.bankAccounts().then((list) => {
      setAccounts(list);
      setAccountId((current) =>
        current && list.some((a) => a.id === current)
          ? current
          : ((list.find((a) => a.waiting > 0) ?? list[0])?.id ?? null),
      );
    });
    void db.accounts().then(setLedger);
  }, [status.companyId, status.lastSavedAt, version]);

  useEffect(() => {
    if (!accountId) return;
    let current = true;
    void Promise.all([db.bankQueue(accountId, view), db.bankImports(accountId)]).then(([q, i]) => {
      if (!current) return;
      setItems(q);
      setImports(i);
    });
    return () => {
      current = false;
    };
  }, [accountId, view, status.lastSavedAt, version]);

  if (!accounts) return null;
  const account = accounts.find((a) => a.id === accountId) ?? null;
  const changed = () => {
    setExpanded(null);
    setVersion((v) => v + 1);
  };
  const names = new Map(ledger.map((a) => [a.id, a.fullName]));

  const readFiles = (files: File[]) =>
    run(async () => {
      setResult(null);
      setReading(await db.bankReadStatements(files));
    });

  const bulk = items.filter((t) => t.suggestion && t.matches.length === 0 && !t.transfer);
  // An entry with the transaction's own bank text, e.g. QuickBooks history from its bank feed
  const sure = items.filter((t) => (t.matches[0]?.bankText ?? 0) > 0);
  const matchAll = () =>
    run(async () => {
      const n = await db.bankMatchByBankText(sure.map((t) => t.id));
      setResult(`Matched ${count(n, 'transaction')} to entries already in the books.`);
      changed();
    });
  const acceptAll = () =>
    override.attempt(async (passphrase) => {
      const n = await db.bankAcceptSuggestions(
        bulk.map((t) => t.id),
        passphrase,
      );
      setResult(`Added ${count(n, 'transaction')} to the books.`);
      changed();
    });

  return (
    <section className="banking">
      <h2>Bank import</h2>
      <p className="muted">
        Download statements from your bank or card website as <strong>.qbo</strong> (QuickBooks Web
        Connect) files and import them here. Each transaction waits for review until you add it to
        the books, match it to an entry already there, or exclude it.
      </p>
      {!readOnly && (
        <div className="buttons">
          <label className="file-add">
            Import statements (.qbo)
            <input
              type="file"
              accept=".qbo,.qfx,.ofx"
              multiple
              disabled={busy}
              onChange={(e) => {
                const picked = [...(e.target.files ?? [])];
                e.target.value = '';
                if (picked.length) void readFiles(picked);
              }}
            />
          </label>
        </div>
      )}
      {result && <p className="notice">{result}</p>}
      <ErrorText>{error ?? override.error}</ErrorText>

      {accounts.length === 0 ? (
        <p>
          There are no bank or card accounts yet. Add one on the Accounts page, with the detail type
          Bank or Credit card, then import its statements.
        </p>
      ) : (
        <>
          <AccountPicker
            accounts={accounts}
            value={accountId}
            onChange={(id) => {
              setAccountId(id);
              setExpanded(null);
            }}
            showWaiting
          />
          {account && (
            <>
              <div className="buttons">
                {(Object.keys(VIEWS) as QueueView[]).map((v) => (
                  <button
                    key={v}
                    className={v === view ? '' : 'secondary'}
                    onClick={() => {
                      setView(v);
                      setExpanded(null);
                    }}
                  >
                    {VIEWS[v]}
                    {v === 'new' && ` (${account.waiting})`}
                  </button>
                ))}
                {view === 'new' && sure.length > 0 && !readOnly && (
                  <button
                    className="secondary"
                    disabled={busy || override.busy}
                    title="Transactions whose bank description is on an entry already in the books"
                    onClick={() => void matchAll()}
                  >
                    Match {count(sure.length, 'transaction')} already in the books
                  </button>
                )}
                {view === 'new' && bulk.length > 0 && !readOnly && (
                  <button
                    className="secondary"
                    disabled={busy || override.busy}
                    onClick={() => void acceptAll()}
                  >
                    Add {count(bulk.length, 'suggested transaction')}
                  </button>
                )}
              </div>
              <Queue
                account={account}
                view={view}
                items={items}
                ledger={ledger}
                names={names}
                readOnly={readOnly}
                expanded={expanded}
                onExpand={setExpanded}
                onChanged={changed}
              />
              <Imports
                imports={imports}
                account={account}
                readOnly={readOnly}
                onChanged={changed}
              />
            </>
          )}
        </>
      )}
      {reading && (
        <ImportDialog
          reading={reading}
          ledger={ledger}
          current={account}
          onClose={(r) => {
            setReading(null);
            if (r) {
              setResult(summary(r, names));
              announce(summary(r, names));
              const first = r.statements[0]?.accountId;
              if (first) setAccountId(first);
              setView('new');
              changed();
            } else void db.bankDiscardStatements();
          }}
        />
      )}
      {override.dialog}
    </section>
  );
}

function summary(r: StatementImportResult, names: Map<string, string>): string {
  if (r.statements.length === 0) return 'Nothing was imported.';
  const parts = r.statements.map(
    (s) =>
      `${count(s.added, 'transaction')} into ${names.get(s.accountId) ?? '?'}` +
      (s.duplicates ? ` (${count(s.duplicates, 'was', 'were')} already imported)` : '') +
      (s.flagged ? `; ${s.flagged} may be duplicates, check them` : ''),
  );
  const auto = [
    r.autoMatched ? `${count(r.autoMatched, 'transfer')} matched` : '',
    r.autoPosted ? `${r.autoPosted} added by rules` : '',
  ].filter(Boolean);
  return `Imported ${parts.join('; ')}.${auto.length ? ` ${auto.join(', ')}.` : ''}`;
}

// ---- the queue ----

function Queue(props: {
  account: BankAccount;
  view: QueueView;
  items: QueueItem[];
  ledger: AccountRow[];
  names: Map<string, string>;
  readOnly: boolean;
  expanded: number | null;
  onExpand: (id: number | null) => void;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  const override = useClosedPeriodOverride();
  const labels = flowLabels(props.account.type);

  if (props.items.length === 0) {
    return (
      <p className="muted">
        {props.view === 'new'
          ? 'Nothing waiting for review in this account.'
          : props.view === 'excluded'
            ? 'No excluded transactions.'
            : 'No reviewed transactions yet.'}
      </p>
    );
  }

  const quick = (t: QueueItem) => {
    const m = t.matches[0];
    if (m)
      return () =>
        run(async () => {
          await db.bankMatch(t.id, m.entryId);
          props.onChanged();
        });
    if (t.transfer) {
      const other = t.transfer.txnId;
      return () =>
        override.attempt(async (p) => {
          await db.bankTransfer(t.id, other, p);
          props.onChanged();
        });
    }
    const s = t.suggestion;
    if (s) {
      return () =>
        override.attempt(async (p) => {
          await db.bankCategorize(
            t.id,
            {
              payee: s.payee ?? t.payee,
              memo: s.source === 'rule' ? (s.memo ?? t.memo) : t.memo,
              lines: [{ accountId: s.categoryId, amount: Math.abs(t.amount) }],
            },
            p,
          );
          props.onChanged();
        });
    }
    return null;
  };

  return (
    <>
      <ErrorText>{error ?? override.error}</ErrorText>
      <table className="list bank-queue">
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th className="num">{labels.out}</th>
            <th className="num">{labels.in}</th>
            <th>
              {props.view === 'new'
                ? 'Suggested'
                : props.view === 'reviewed'
                  ? 'In the books as'
                  : ''}
            </th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.items.map((t) => {
            const flow = flowCells(t.amount);
            const action = props.view === 'new' ? quick(t) : null;
            const isOpen = props.expanded === t.id;
            return (
              <Fragment key={t.id}>
                <tr className={isOpen ? 'open' : undefined}>
                  <td className="nowrap">{formatDate(t.date)}</td>
                  <td>
                    <strong>{t.payee ?? t.memo ?? t.type ?? 'Transaction'}</strong>
                    {t.checkNo && <span className="muted"> · Check {t.checkNo}</span>}
                    {t.payee && t.memo && <div className="muted small">{t.memo}</div>}
                  </td>
                  <td className="num">{flow.out}</td>
                  <td className="num">{flow.in}</td>
                  <td>
                    {props.view === 'new' && <SuggestionText t={t} names={props.names} />}
                    {props.view === 'reviewed' && (
                      <>
                        {t.entryAccounts}{' '}
                        <span className="badge small">
                          {t.status === 'matched' ? 'matched' : 'added'}
                        </span>
                      </>
                    )}
                  </td>
                  <td className="actions">
                    {!props.readOnly && props.view === 'new' && (
                      <>
                        {action && (
                          <button disabled={busy || override.busy} onClick={() => void action()}>
                            {t.matches.length ? 'Match' : t.transfer ? 'Transfer' : 'Add'}
                          </button>
                        )}{' '}
                        <button
                          className="secondary"
                          onClick={() => props.onExpand(isOpen ? null : t.id)}
                        >
                          {isOpen ? 'Close' : action ? 'Edit' : 'Review'}
                        </button>
                      </>
                    )}
                    {!props.readOnly && props.view === 'reviewed' && (
                      <button
                        className="secondary"
                        disabled={busy || override.busy}
                        title="Send it back for review; an entry added from here is voided"
                        onClick={() =>
                          void override.attempt(async (p) => {
                            await db.bankUndo(t.id, p);
                            props.onChanged();
                          })
                        }
                      >
                        Undo
                      </button>
                    )}
                    {!props.readOnly && props.view === 'excluded' && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await db.bankRestore(t.id);
                            props.onChanged();
                          })
                        }
                      >
                        Restore
                      </button>
                    )}
                  </td>
                </tr>
                {isOpen && (
                  <tr className="editor">
                    <td colSpan={6}>
                      <ReviewEditor
                        t={t}
                        account={props.account}
                        ledger={props.ledger}
                        names={props.names}
                        onDone={props.onChanged}
                        onCancel={() => props.onExpand(null)}
                      />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      {props.items.length >= 500 && <p className="muted">Showing the newest 500.</p>}
      {override.dialog}
    </>
  );
}

function SuggestionText({ t, names }: { t: QueueItem; names: Map<string, string> }) {
  const m = t.matches[0];
  return (
    <>
      {t.possibleDuplicate && (
        <span
          className="badge small warn"
          title="An earlier imported transaction has the same bank id: the bank may have sent this one twice"
        >
          possible duplicate
        </span>
      )}
      {t.alreadyInBooks && (
        <span
          className="badge small"
          title="The QuickBooks history already has this transaction: Match it rather than adding it again"
        >
          already in the books
        </span>
      )}{' '}
      {m ? (
        <>
          Match {formatDate(m.date)} {m.name ?? m.memo ?? ''}
          <span className="muted">
            {' '}
            · {m.accounts}
            {m.sourceType === 'qbo_migration' ? ' · from QuickBooks' : ''}
            {m.bankText > 0 && <BankTextNote />}
          </span>
        </>
      ) : t.transfer ? (
        <>
          Transfer {t.amount < 0 ? 'to' : 'from'} {t.transfer.account}
        </>
      ) : t.suggestion ? (
        <>
          {names.get(t.suggestion.categoryId) ?? '?'}
          <span className="muted">
            {' '}
            ·{' '}
            {t.suggestion.source === 'rule'
              ? `rule: ${t.suggestion.ruleName}`
              : t.suggestion.source === 'vendor'
                ? `${t.suggestion.payee}'s default`
                : 'like last time'}
          </span>
        </>
      ) : (
        <span className="muted">—</span>
      )}
    </>
  );
}

function BankTextNote() {
  return (
    <span title="The entry's memo has this transaction's description from the bank">
      {' '}
      · same bank text
    </span>
  );
}

interface LineDraft {
  accountId: string;
  amount: string;
  memo: string;
}

function ReviewEditor(props: {
  t: QueueItem;
  account: BankAccount;
  ledger: AccountRow[];
  names: Map<string, string>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = props;
  const total = Math.abs(t.amount);
  const s = t.suggestion;
  const [payee, setPayee] = useState(s?.payee ?? t.payee ?? '');
  const [memo, setMemo] = useState((s?.source === 'rule' ? s.memo : null) ?? t.memo ?? '');
  const [lines, setLines] = useState<LineDraft[]>([
    { accountId: s?.categoryId ?? '', amount: formatMoney(total), memo: '' },
  ]);
  const { busy, error, run } = useAction();
  const override = useClosedPeriodOverride();
  const exclude = new Set([t.accountId]);
  const used = lines.reduce((sum, l) => sum + cents(l.amount), 0);
  const left = total - used;
  const set = (i: number, change: Partial<LineDraft>) =>
    setLines(lines.map((l, n) => (n === i ? { ...l, ...change } : l)));

  const add = () =>
    override.attempt(async (p) => {
      await db.bankCategorize(
        t.id,
        {
          payee: payee.trim() || null,
          memo: memo.trim() || null,
          lines: lines.map((l) => ({
            accountId: l.accountId,
            amount: cents(l.amount),
            memo: l.memo.trim() || null,
          })),
        },
        p,
      );
      props.onDone();
    });

  return (
    <div className="review-editor">
      {t.matches.length > 0 && (
        <>
          <h4>Already in the books?</h4>
          <p className="muted small">
            These entries move the same amount through {props.account.name} within 10 days. Match
            one instead of adding the transaction again.
          </p>
          <ul className="plain">
            {t.matches.map((m) => (
              <li key={m.entryId}>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      await db.bankMatch(t.id, m.entryId);
                      props.onDone();
                    })
                  }
                >
                  Match
                </button>{' '}
                {formatDate(m.date)} · {m.ref ? `Ref ${m.ref} · ` : ''}
                {m.name ?? m.memo ?? `Entry ${m.entryId}`}
                <span className="muted">
                  {' '}
                  · {m.accounts}
                  {m.sourceType === 'qbo_migration' ? ' · from QuickBooks' : ''}
                  {m.bankText > 0 && <BankTextNote />}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {t.transfer && (
        <p>
          <button
            className="secondary"
            disabled={busy || override.busy}
            onClick={() =>
              void override.attempt(async (p) => {
                await db.bankTransfer(t.id, t.transfer!.txnId, p);
                props.onDone();
              })
            }
          >
            Record transfer
          </button>{' '}
          {t.amount < 0 ? 'to' : 'from'} {t.transfer.account}: its {formatDate(t.transfer.date)}{' '}
          transaction is the other side, and both are matched.
        </p>
      )}
      <h4>Add to the books</h4>
      <div className="fields">
        <label>
          Payee
          <PayeeField
            value={payee}
            onChange={setPayee}
            onAdded={(p) =>
              // A new vendor's default category goes into an empty category
              setLines((current) =>
                p.defaultAccountId && current.length === 1 && !current[0]!.accountId
                  ? [{ ...current[0]!, accountId: p.defaultAccountId }]
                  : current,
              )
            }
          />
        </label>
        <label>
          Memo
          <input value={memo} onChange={(e) => setMemo(e.target.value)} />
        </label>
      </div>
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
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <AccountSelect
                  accounts={props.ledger}
                  value={l.accountId}
                  exclude={exclude}
                  onChange={(id) => set(i, { accountId: id })}
                />
              </td>
              <td>
                <MoneyInput
                  ariaLabel={`Line ${i + 1} amount`}
                  value={l.amount}
                  onChange={(v) => set(i, { amount: v })}
                />
              </td>
              <td>
                <input
                  aria-label={`Line ${i + 1} memo`}
                  value={l.memo}
                  onChange={(e) => set(i, { memo: e.target.value })}
                />
              </td>
              <td>
                {lines.length > 1 && (
                  <button
                    className="link muted"
                    onClick={() => setLines(lines.filter((_, n) => n !== i))}
                  >
                    remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="buttons">
        <button
          className="link"
          onClick={() =>
            setLines([
              ...lines,
              { accountId: '', amount: left > 0 ? formatMoney(left) : '', memo: '' },
            ])
          }
        >
          Split: add a line
        </button>
        {left !== 0 && (
          <span className={left < 0 ? 'error-text' : 'muted'}>
            {left > 0 ? `${formatMoney(left)} not yet assigned` : `${formatMoney(-left)} too much`}
          </span>
        )}
      </div>
      <ErrorText>{error ?? override.error}</ErrorText>
      <div className="buttons">
        <button
          disabled={busy || override.busy || left !== 0 || lines.some((l) => !l.accountId)}
          onClick={() => void add()}
        >
          Add to books
        </button>
        <button
          className="secondary"
          disabled={busy}
          title="Leave it out of the books, e.g. a personal charge or a duplicate"
          onClick={() =>
            void run(async () => {
              await db.bankExclude(t.id);
              props.onDone();
            })
          }
        >
          Exclude
        </button>
        <button className="secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
      {override.dialog}
    </div>
  );
}

// ---- import ----

function ImportDialog(props: {
  reading: { statements: StatementPreview[]; problems: FileProblem[] };
  ledger: AccountRow[];
  current: BankAccount | null;
  onClose: (result: StatementImportResult | null) => void;
}) {
  const { statements, problems } = props.reading;
  // One choice per account in the files, even when several files cover it
  const keys = [...new Map(statements.map((s) => [s.key, s])).values()];
  const [choices, setChoices] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      keys.map((s) => [
        s.key,
        // Remembered, or guessed from the account's name, or the tab being viewed
        s.accountId ??
          (keys.length === 1 &&
          props.current &&
          (props.current.type === 'liability') === (s.kind === 'card')
            ? props.current.id
            : ''),
      ]),
    ),
  );
  const { busy, error, run } = useAction();
  const targets = props.ledger.filter((a) => a.type === 'asset' || a.type === 'liability');
  const ready = keys.length > 0 && keys.every((s) => choices[s.key]);

  return (
    <Dialog title="Import statements" onClose={busy ? undefined : () => props.onClose(null)}>
      {problems.length > 0 && (
        <ul className="warning">
          {problems.map((p, i) => (
            <li key={i}>
              <strong>{p.file}</strong>: {p.message}
            </li>
          ))}
        </ul>
      )}
      {keys.length > 0 ? (
        <>
          <p>Choose the account each statement belongs to. EasyBooks remembers it for next time.</p>
          <table className="list">
            <thead>
              <tr>
                <th>In the file</th>
                <th>Period</th>
                <th className="num">Transactions</th>
                <th>Account</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((s) => {
                const files = statements.filter((x) => x.key === s.key);
                const n = files.reduce((sum, f) => sum + f.transactions, 0);
                const starts = files
                  .map((f) => f.startDate)
                  .filter(Boolean)
                  .sort();
                const ends = files
                  .map((f) => f.endDate)
                  .filter(Boolean)
                  .sort();
                return (
                  <tr key={s.key}>
                    <td>
                      {s.label}
                      <div className="muted small">{files.map((f) => f.file).join(', ')}</div>
                    </td>
                    <td className="nowrap">
                      {starts[0]
                        ? `${formatDate(starts[0])} – ${formatDate(ends.at(-1) ?? null)}`
                        : '—'}
                    </td>
                    <td className="num">{n}</td>
                    <td>
                      <AccountSelect
                        accounts={targets}
                        value={choices[s.key] ?? ''}
                        onChange={(id) => setChoices({ ...choices, [s.key]: id })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : (
        <p>None of the files had a statement to import.</p>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="buttons">
        <button
          disabled={busy || !ready}
          onClick={() => void run(async () => props.onClose(await db.bankImport(choices)))}
        >
          Import
        </button>
        <button className="secondary" disabled={busy} onClick={() => props.onClose(null)}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

function Imports(props: {
  imports: ImportRow[];
  account: BankAccount;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const { busy, error, run } = useAction();
  if (props.imports.length === 0) return null;
  return (
    <details className="imports">
      <summary>Statement files imported into {props.account.name}</summary>
      <ErrorText>{error}</ErrorText>
      <table className="list">
        <thead>
          <tr>
            <th>File</th>
            <th>Period</th>
            <th className="num">Added</th>
            <th className="num">Already imported</th>
            <th className="num">Statement balance</th>
            <th>Imported</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.imports.map((i) => (
            <tr key={i.id}>
              <td>{i.fileName}</td>
              <td className="nowrap">
                {i.startDate ? `${formatDate(i.startDate)} – ${formatDate(i.endDate)}` : '—'}
              </td>
              <td className="num">{i.added}</td>
              <td className="num">{i.duplicates}</td>
              <td className="num">
                {i.balance === null
                  ? ''
                  : formatMoney(statementBalance(props.account.type, i.balance))}
              </td>
              <td className="nowrap">{formatDateTime(i.importedAt)}</td>
              <td>
                {!props.readOnly && i.removable > 0 && (
                  <button
                    className="link"
                    disabled={busy}
                    title="Remove its transactions that are still waiting for review or excluded"
                    onClick={() =>
                      void run(async () => {
                        if (
                          !confirm(
                            `Remove the ${count(i.removable, 'transaction')} from ${i.fileName} that are not in the books?`,
                          )
                        )
                          return;
                        await db.bankUndoImport(i.id);
                        props.onChanged();
                      })
                    }
                  >
                    Undo import
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
