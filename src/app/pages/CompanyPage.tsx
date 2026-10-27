// Company details (CO-1).

import { useEffect, useState } from 'react';
import { normalizeDetails, validateDetails, type CompanyDetails } from '../../shared/company';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { CompanyFields } from '../CompanyFields';
import { Dialog, ErrorText, TextField, formatDateTime, useAction } from '../ui';

type Details = CompanyDetails & { id: string; createdAt: string };

export function CompanyPage({ status }: { status: SessionStatus }) {
  const [saved, setSaved] = useState<Details | null>(null);
  const [draft, setDraft] = useState<CompanyDetails | null>(null);
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    void db.details().then((d) => {
      setSaved(d);
      setDraft(d);
    });
  }, [status.companyId]);

  if (!saved || !draft) return null;

  const changes = normalizeDetails(
    Object.fromEntries(
      (Object.keys(draft) as (keyof CompanyDetails)[])
        .filter((k) => (draft[k] ?? '') !== (saved[k] ?? ''))
        .map((k) => [k, draft[k]]),
    ) as Partial<CompanyDetails>,
  );
  const changed = Object.keys(changes).length > 0;

  const save = () => {
    const problems = validateDetails(changes);
    if (problems.length) {
      setError(problems.join(' '));
      return;
    }
    void run(async () => {
      await db.updateDetails(changes);
      const d = await db.details();
      setSaved(d);
      setDraft(d);
      setDone(true);
    });
  };

  return (
    <section>
      <h2>Company</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset disabled={status.readOnly}>
          <CompanyFields
            value={draft}
            onChange={(d) => {
              setDone(false);
              setDraft({ ...draft, ...d });
            }}
          />
        </fieldset>
        <ErrorText>{error}</ErrorText>
        {!status.readOnly && (
          <div className="buttons">
            <button type="submit" disabled={busy || !changed}>
              Save details
            </button>
            {changed && (
              <button type="button" className="secondary" onClick={() => setDraft(saved)}>
                Undo changes
              </button>
            )}
            {done && !changed && <span className="muted">Details updated.</span>}
          </div>
        )}
      </form>
      <PostedEdits status={status} />
      <p className="muted">
        Company created {formatDateTime(saved.createdAt)} · id <code>{saved.id}</code>
      </p>
    </section>
  );
}

/** Whether posted transactions can be changed and deleted (GL-6 off), per company. */
function PostedEdits({ status }: { status: SessionStatus }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => {
    void db.postedEdits().then(setOn);
  }, [status.companyId]);
  if (on === null) return null;

  const set = (value: boolean, pass?: string) =>
    run(async () => {
      await db.setPostedEdits(value, pass);
      setOn(value);
      setAsking(false);
      setPassphrase('');
    });

  return (
    <>
      <h3>Posted transactions</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          disabled={status.readOnly || busy}
          onChange={(e) => (e.target.checked ? setAsking(true) : void set(false))}
        />
        <span>
          Allow changing and deleting posted transactions
          <span className="hint">
            Off (the accountant’s way): a posted transaction is corrected by voiding it and entering
            the corrected copy, which the Edit buttons do for you. On: Edit changes it in place and
            Delete removes it. Either way the audit log keeps every version, closed periods still
            need your passphrase, and reconciled transactions and QuickBooks history can’t be
            deleted.
          </span>
        </span>
      </label>
      <ErrorText>{asking ? null : error}</ErrorText>
      {asking && (
        <Dialog
          title="Allow changing posted transactions"
          onClose={busy ? undefined : () => setAsking(false)}
        >
          <p>
            Enter your passphrase to allow changing and deleting posted transactions in this
            company.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void set(true, passphrase);
            }}
          >
            <TextField
              label="Passphrase"
              type="password"
              value={passphrase}
              onChange={setPassphrase}
              autoFocus
            />
            <ErrorText>{error}</ErrorText>
            <div className="buttons">
              <button type="submit" disabled={busy || !passphrase}>
                Allow
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
