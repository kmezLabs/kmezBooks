// Passphrase change (US-1). This device's settings (its name for the lock
// file, DF-4, and the inactivity lock, US-1) are in Settings (CO-10).

import { useState } from 'react';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { ErrorText, TextField, passphraseProblem, useAction } from '../ui';

function ChangePassphrase({ status }: { status: SessionStatus }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAction();

  const change = () => {
    const problem = passphraseProblem(next, confirm);
    if (problem) {
      setError(problem);
      return;
    }
    void run(async () => {
      await db.changePassphrase(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        change();
      }}
    >
      <h3>Change passphrase</h3>
      <p className="muted">
        Takes effect at once. Existing backups keep the passphrase they were made with.
      </p>
      <fieldset disabled={status.readOnly || busy}>
        <div className="fields">
          <TextField
            label="Current passphrase"
            type="password"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
        </div>
        <div className="fields">
          <TextField
            label="New passphrase"
            type="password"
            value={next}
            onChange={setNext}
            autoComplete="new-password"
          />
          <TextField
            label="Repeat it"
            type="password"
            value={confirm}
            onChange={setConfirm}
            autoComplete="new-password"
          />
        </div>
      </fieldset>
      <ErrorText>{error}</ErrorText>
      <div className="buttons">
        <button type="submit" disabled={busy || status.readOnly || !current || !next}>
          Change passphrase
        </button>
        {done && <span className="muted">Passphrase changed.</span>}
      </div>
    </form>
  );
}

export function SecurityPage({ status }: { status: SessionStatus }) {
  return (
    <section>
      <h2>Passphrase</h2>
      <ChangePassphrase status={status} />
    </section>
  );
}
