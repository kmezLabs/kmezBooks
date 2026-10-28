// Reconcile (BK-7, BK-8): check an account's entries off against a statement
// until the difference is zero, then finish. Finished reconciliations are kept
// as reports, which flag entries voided since.

import { useEffect, useState } from 'react';
import { MoneyInput, cents, formatDate, todayIso } from '../../app/ledgerUi';
import { ErrorText, formatDateTime, useAction } from '../../app/ui';
import { formatMoney, type Cents } from '../../shared/money';
import { db } from '../../shared/workerClient';
import type { SessionStatus } from '../../worker/companySession';
import type { BankAccount } from './bankAccounts';
import {
  AccountTabs,
  count,
  flowCells,
  flowLabels,
  ledgerBalance,
  statementBalance,
} from './bankUi';
import type { ReconcileState, ReconciliationReport, ReconciliationSummary } from './reconcile';

export function ReconcilePage({ status }: { status: SessionStatus }) {
  const [accounts, setAccounts] = useState<BankAccount[] | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [state, setState] = useState<ReconcileState | null>(null);
  const [history, setHistory] = useState<ReconciliationSummary[]>([]);
  const [report, setReport] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    void db.bankAccounts().then((list) => {
      setAccounts(list);
      setAccountId((current) =>
        current && list.some((a) => a.id === current) ? current : (list[0]?.id ?? null),
      );
    });
  }, [status.companyId]);

  useEffect(() => {
    if (!accountId) return;
    let current = true;
    void Promise.all([db.reconcileState(accountId), db.reconcileHistory(accountId)]).then(
      ([s, h]) => {
        if (!current) return;
        setState(s);
        setHistory(h);
      },
    );
    return () => {
      current = false;
    };
  }, [accountId, status.lastSavedAt, version]);

  if (!accounts) return null;
  const account = accounts.find((a) => a.id === accountId);
  const changed = () => setVersion((v) => v + 1);

  return (
    <section className="reconcile">
      <h2>Reconcile</h2>
      {accounts.length === 0 ? (
        <p>There are no bank or card accounts to reconcile.</p>
      ) : (
        <>
          <AccountTabs
            accounts={accounts}
            value={accountId}
            onChange={(id) => {
              setAccountId(id);
              setReport(null);
              setState(null);
            }}
          />
          {report ? (
            <ReportView id={report} onBack={() => setReport(null)} />
          ) : (
            account &&
            state &&
            state.accountId === account.id &&
            (state.open ? (
              <Working
                account={account}
                state={state}
                readOnly={status.readOnly}
                onChanged={changed}
              />
            ) : (
              <Start
                account={account}
                state={state}
                history={history}
                readOnly={status.readOnly}
                onChanged={changed}
                onReport={setReport}
              />
            ))
          )}
        </>
      )}
    </section>
  );
}

function Start(props: {
  account: BankAccount;
  state: ReconcileState;
  history: ReconciliationSummary[];
  readOnly: boolean;
  onChanged: () => void;
  onReport: (id: string) => void;
}) {
  const { account, state } = props;
  const [date, setDate] = useState(state.suggested?.statementDate ?? todayIso());
  const suggestedBalance = state.suggested?.endingBalance ?? null;
  const [ending, setEnding] = useState(
    suggestedBalance === null ? '' : formatMoney(statementBalance(account.type, suggestedBalance)),
  );
  const { busy, error, run } = useAction();
  const show = (c: Cents) => formatMoney(statementBalance(account.type, c));

  return (
    <>
      <p>
        {state.last ? (
          <>
            Last reconciled: statement of <strong>{formatDate(state.last.statementDate)}</strong>,
            ending balance <strong>{show(state.last.endingBalance)}</strong>.
          </>
        ) : (
          <>
            {account.name} hasn’t been reconciled yet. The first reconciliation starts from zero:
            check off everything the bank shows up to the statement date, including history brought
            over from QuickBooks. “Check all” does that in one step.
          </>
        )}
      </p>
      {!props.readOnly && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await db.reconcileStart(account.id, date, ledgerBalance(account.type, cents(ending)));
              props.onChanged();
            });
          }}
        >
          <div className="fields">
            <label className="short">
              Statement date
              <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="short">
              {account.type === 'liability' ? 'Statement balance owed' : 'Statement ending balance'}
              <MoneyInput
                ariaLabel="Statement ending balance"
                value={ending}
                onChange={setEnding}
              />
            </label>
          </div>
          {state.suggested && (
            <p className="muted small">
              {suggestedBalance === null
                ? 'The statement date is from the last imported statement. Its file gives the balance on the day it was downloaded, not at the statement’s end, so enter the ending balance from the statement itself.'
                : 'Filled in from the last imported statement; check it against the statement itself.'}
            </p>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="buttons">
            <button type="submit" disabled={busy || !date || !ending.trim()}>
              Start reconciling
            </button>
          </div>
        </form>
      )}
      <h3>Finished reconciliations</h3>
      {props.history.length === 0 ? (
        <p className="muted">None yet.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Statement date</th>
              <th className="num">Beginning balance</th>
              <th className="num">Ending balance</th>
              <th className="num">Items cleared</th>
              <th>Finished</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {props.history.map((h) => (
              <tr key={h.id}>
                <td>{formatDate(h.statementDate)}</td>
                <td className="num">{show(h.beginningBalance)}</td>
                <td className="num">{show(h.endingBalance)}</td>
                <td className="num">{h.clearedCount}</td>
                <td>{formatDateTime(h.finishedAt)}</td>
                <td>
                  {h.changedCount > 0 && (
                    <span className="badge small warn">
                      {count(h.changedCount, 'item')} voided since
                    </span>
                  )}{' '}
                  <button className="link" onClick={() => props.onReport(h.id)}>
                    Report
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function Working(props: {
  account: BankAccount;
  state: ReconcileState;
  readOnly: boolean;
  onChanged: () => void;
}) {
  const { account, state } = props;
  const open = state.open!;
  const [editing, setEditing] = useState(false);
  const [date, setDate] = useState(open.statementDate);
  const [ending, setEnding] = useState(
    formatMoney(statementBalance(account.type, open.endingBalance)),
  );
  const { busy, error, run } = useAction();
  const show = (c: Cents) => formatMoney(statementBalance(account.type, c));
  const labels = flowLabels(account.type);
  const done = state.difference === 0;
  const act = (fn: () => Promise<unknown>) =>
    void run(async () => {
      await fn();
      props.onChanged();
    });

  return (
    <>
      <div className="reconcile-summary">
        {editing ? (
          <form
            className="fields"
            onSubmit={(e) => {
              e.preventDefault();
              act(async () => {
                await db.reconcileUpdate(open.id, date, ledgerBalance(account.type, cents(ending)));
                setEditing(false);
              });
            }}
          >
            <label className="short">
              Statement date
              <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
            </label>
            <label className="short">
              Ending balance
              <MoneyInput
                ariaLabel="Statement ending balance"
                value={ending}
                onChange={setEnding}
              />
            </label>
            <div className="buttons">
              <button type="submit" disabled={busy}>
                Save
              </button>
              <button type="button" className="secondary" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <table className="kv">
            <tbody>
              <tr>
                <th>Statement date</th>
                <td>
                  {formatDate(open.statementDate)}{' '}
                  {!props.readOnly && (
                    <button className="link" onClick={() => setEditing(true)}>
                      change
                    </button>
                  )}
                </td>
              </tr>
              <tr>
                <th>Beginning balance</th>
                <td className="num">{show(state.beginningBalance)}</td>
              </tr>
              <tr>
                <th>Cleared ({count(state.clearedCount, 'item')})</th>
                <td className="num">{show(state.clearedTotal)}</td>
              </tr>
              <tr>
                <th>Cleared balance</th>
                <td className="num">{show(state.beginningBalance + state.clearedTotal)}</td>
              </tr>
              <tr>
                <th>Statement ending balance</th>
                <td className="num">{show(open.endingBalance)}</td>
              </tr>
              <tr className={done ? 'difference zero' : 'difference'}>
                <th>Difference</th>
                <td className="num">{show(state.difference)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
      <ErrorText>{error}</ErrorText>
      {!props.readOnly && (
        <div className="buttons">
          <button disabled={busy || !done} onClick={() => act(() => db.reconcileFinish(open.id))}>
            Finish
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => act(() => db.reconcileSetAllCleared(open.id, true))}
          >
            Check all
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => act(() => db.reconcileSetAllCleared(open.id, false))}
          >
            Uncheck all
          </button>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              if (confirm('Stop this reconciliation? Everything checked off is unchecked.')) {
                act(() => db.reconcileCancel(open.id));
              }
            }}
          >
            Cancel reconciliation
          </button>
          <span className="muted small">Your progress is saved as you go.</span>
        </div>
      )}
      {state.itemCount > state.items.length && (
        <p className="muted">
          Showing the newest {state.items.length.toLocaleString('en-US')} of{' '}
          {state.itemCount.toLocaleString('en-US')} items. “Check all” includes the older ones too.
        </p>
      )}
      <table className="list reconcile-items">
        <thead>
          <tr>
            <th aria-label="Cleared" />
            <th>Date</th>
            <th>Ref</th>
            <th>Payee</th>
            <th>Memo</th>
            <th className="num">{labels.out}</th>
            <th className="num">{labels.in}</th>
          </tr>
        </thead>
        <tbody>
          {state.items.map((i) => {
            const flow = flowCells(i.amount);
            const toggle = () =>
              !props.readOnly && act(() => db.reconcileSetCleared(open.id, [i.lineId], !i.cleared));
            return (
              <tr
                key={i.lineId}
                className={i.cleared ? 'clickable cleared' : 'clickable'}
                onClick={toggle}
              >
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Cleared: ${formatDate(i.date)} ${i.name ?? ''}`}
                    checked={i.cleared}
                    disabled={props.readOnly || busy}
                    onClick={(e) => e.stopPropagation()}
                    onChange={toggle}
                  />
                </td>
                <td className="nowrap">{formatDate(i.date)}</td>
                <td>{i.ref}</td>
                <td>{i.name}</td>
                <td>{i.memo}</td>
                <td className="num">{flow.out}</td>
                <td className="num">{flow.in}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {state.items.length === 0 && (
        <p className="muted">No entries in this account on or before the statement date.</p>
      )}
    </>
  );
}

function ReportView({ id, onBack }: { id: string; onBack: () => void }) {
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const { error, run } = useAction();
  useEffect(() => {
    void run(async () => setReport(await db.reconcileReport(id)));
  }, [id, run]);

  if (!report) return <ErrorText>{error}</ErrorText>;
  const { summary: s } = report;
  const show = (c: Cents) => formatMoney(statementBalance(report.accountType, c));
  const labels = flowLabels(report.accountType);
  const sum = (items: { amount: Cents }[], sign: 1 | -1) =>
    items.filter((i) => Math.sign(i.amount) === sign).reduce((t, i) => t + Math.abs(i.amount), 0);
  // As finished: items voided since still count, so the figures agree with the statement
  const cleared = report.cleared;

  const items = (title: string, list: ReconciliationReport['cleared']) => (
    <>
      <h3>
        {title} ({list.length})
      </h3>
      {list.length === 0 ? (
        <p className="muted">None.</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <th>Date</th>
              <th>Ref</th>
              <th>Payee</th>
              <th>Memo</th>
              <th className="num">{labels.out}</th>
              <th className="num">{labels.in}</th>
            </tr>
          </thead>
          <tbody>
            {list.map((i) => {
              const flow = flowCells(i.amount);
              return (
                <tr key={i.lineId} className={i.voided ? 'inactive' : undefined}>
                  <td className="nowrap">{formatDate(i.date)}</td>
                  <td>{i.ref}</td>
                  <td>
                    {i.name}
                    {i.voided && <span className="badge small warn">voided since</span>}
                  </td>
                  <td>{i.memo}</td>
                  <td className="num">{flow.out}</td>
                  <td className="num">{flow.in}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );

  return (
    <div className="report-sheet reconcile-report">
      <div className="buttons no-print">
        <button className="link" onClick={onBack}>
          ← Back
        </button>
        <button className="secondary" onClick={() => window.print()}>
          Print or save as PDF
        </button>
      </div>
      <header className="report-head">
        <div className="report-company">{report.account}</div>
        <h2>Reconciliation report</h2>
        <div>Statement of {formatDate(s.statementDate)}</div>
        <div className="muted">Finished {formatDateTime(s.finishedAt)}</div>
      </header>
      {s.changedCount > 0 && (
        <p className="warning">
          {count(s.changedCount, 'cleared item')} {s.changedCount === 1 ? 'has' : 'have'} been
          voided since this reconciliation, so the books no longer agree with this statement.
        </p>
      )}
      <table className="kv">
        <tbody>
          <tr>
            <th>Beginning balance</th>
            <td className="num">{show(s.beginningBalance)}</td>
          </tr>
          <tr>
            <th>Cleared {labels.ins}</th>
            <td className="num">{formatMoney(sum(cleared, 1))}</td>
          </tr>
          <tr>
            <th>Cleared {labels.outs}</th>
            <td className="num">{formatMoney(sum(cleared, -1))}</td>
          </tr>
          <tr>
            <th>Statement ending balance</th>
            <td className="num">{show(s.endingBalance)}</td>
          </tr>
        </tbody>
      </table>
      {items('Cleared items', report.cleared)}
      {items(`Not cleared on or before ${formatDate(s.statementDate)}`, report.outstanding)}
    </div>
  );
}
