// Period close (PC-1, PC-2, PC-3). The trial balance is in Reports.

import { useEffect, useState } from 'react';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { formatDate } from '../ledgerUi';
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

export function CloseBooksPage({ status }: { status: SessionStatus }) {
  return (
    <section>
      <h2>Close books</h2>
      <ClosingDate status={status} />
      <h3>Year end</h3>
      <p className="muted">
        Nothing needs to be run at year end (PC-3). The balance sheet and trial balance show each
        earlier year's net income in Retained Earnings, and income and expenses start again from
        zero at the start of each fiscal year. Check the books in Reports, for example with the
        trial balance as of the closing date.
      </p>
    </section>
  );
}
