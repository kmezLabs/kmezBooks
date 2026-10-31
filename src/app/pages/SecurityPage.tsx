// Passphrase change (US-1) and this device's settings: its name for the lock
// file (DF-4) and the inactivity lock (US-1).

import { useState } from 'react';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import {
  deviceName,
  deviceNamed,
  lockAfterMinutes,
  setDeviceName,
  setLockAfterMinutes,
} from '../settings';
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

function DeviceSettings() {
  const [name, setName] = useState(deviceName());
  const [minutes, setMinutes] = useState(String(lockAfterMinutes()));
  const [saved, setSaved] = useState(false);
  const n = Number(minutes);
  const valid = name.trim().length > 0 && Number.isInteger(n) && n >= 1 && n <= 240;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setDeviceName(name);
        setLockAfterMinutes(n);
        setSaved(true);
      }}
    >
      <h3>This device</h3>
      <div className="fields">
        <TextField
          label="Device name"
          value={name}
          onChange={(v) => {
            setName(v);
            setSaved(false);
          }}
          hint={
            deviceNamed()
              ? 'Shown to other devices while you have a company open.'
              : 'Filled in from this device. Shown to other devices while you have a company open; give each computer its own name to tell them apart.'
          }
        />
        <TextField
          label="Close company after (minutes idle)"
          value={minutes}
          onChange={(v) => {
            setMinutes(v);
            setSaved(false);
          }}
          width="short"
          hint="1 to 240"
        />
      </div>
      <div className="buttons">
        <button type="submit" disabled={!valid}>
          Save device settings
        </button>
        {saved && <span className="muted">Saved for this device.</span>}
      </div>
    </form>
  );
}

export function SecurityPage({ status }: { status: SessionStatus }) {
  return (
    <section>
      <h2>Passphrase and device</h2>
      <ChangePassphrase status={status} />
      <DeviceSettings />
    </section>
  );
}
