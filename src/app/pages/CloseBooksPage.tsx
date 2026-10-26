// Period close (PC-1, PC-2, PC-3) and a trial balance to check the books.

import { useEffect, useState } from 'react';
import { TYPE_LABELS } from '../../shared/accounts';
import { formatMoney } from '../../shared/money';
import type { TrialBalance } from '../../ledger/balances';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { formatDate, todayIso } from '../ledgerUi';
import { ErrorText, useAction } from '../ui';

function ClosingDate({ status }: { status: SessionStatus }) {
  const [current, setCurrent] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => {
    void db.closingDate().then((d) => {
      setCurrent(d);
      setDate(d ?? '');
    });
  }, [status.companyId, status.lastSavedAt]);

  const save = (value: string | null) =>
    run(async () => {
      await db.setClosingDate(value);
      setCurrent(value);
      setDate(value ?? '');
    });

  return (
    <>
      <h3>Closing date</h3>
      <p>
        {current ? (
          <>
            The books are closed up to and including <strong>{formatDate(current)}</strong>.
          </>
        ) : (
          'No closing date is set: every period is open.'
        )}
      </p>
      <p className="muted">
        Nothing dated on or before the closing date can be posted or voided. You can still make a
        change there by entering your passphrase again; each such change is recorded in the audit
        log. A typical routine is to close each year once the tax return is filed.
      </p>
      <div className="fields">
        <label className="short">
          Close the books through
          <input
            type="date"
            value={date}
            disabled={status.readOnly}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="buttons">
        <button
          disabled={busy || status.readOnly || !date || date === current}
          onClick={() => save(date)}
        >
          Set closing date
        </button>
        {current && (
          <button
            className="secondary"
            disabled={busy || status.readOnly}
            onClick={() => save(null)}
          >
            Remove closing date
          </button>
        )}
      </div>
    </>
  );
}

function TrialBalanceView({ status }: { status: SessionStatus }) {
  const [asOf, setAsOf] = useState(todayIso());
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const { error, run } = useAction();

  useEffect(() => {
    if (!asOf) return;
    void run(async () => setTb(await db.trialBalance(asOf)));
  }, [asOf, run, status.lastSavedAt]);

  return (
    <>
      <h3>Trial balance</h3>
      <div className="fields">
        <label className="short">
          As of
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
      </div>
      <ErrorText>{error}</ErrorText>
      {tb && (
        <>
          <p className="muted">
            Income and expenses since the fiscal year began on {formatDate(tb.fiscalYearStart)};
            earlier years' net income is in Retained Earnings. Nothing needs to be run at year end
            (PC-3).
          </p>
          {tb.rows.length === 0 ? (
            <p className="muted">No posted entries by this date.</p>
          ) : (
            <table className="list">
              <thead>
                <tr>
                  <th>Account</th>
                  <th className="num">Debit</th>
                  <th className="num">Credit</th>
                </tr>
              </thead>
              <tbody>
                {tb.rows.map((r) => (
                  <tr key={r.accountId ?? r.account}>
                    <td>
                      {r.account} <span className="muted">· {TYPE_LABELS[r.type]}</span>
                    </td>
                    <td className="num">{r.debit ? formatMoney(r.debit) : ''}</td>
                    <td className="num">{r.credit ? formatMoney(r.credit) : ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  <td className="num">{formatMoney(tb.totalDebit)}</td>
                  <td className="num">{formatMoney(tb.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </>
      )}
    </>
  );
}

export function CloseBooksPage({ status }: { status: SessionStatus }) {
  return (
    <section>
      <h2>Close books</h2>
      <ClosingDate status={status} />
      <TrialBalanceView status={status} />
    </section>
  );
}
