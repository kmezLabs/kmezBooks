// Unlock a company folder (US-1), and decide what to do when another device
// has it open (DF-4).

import { useState } from 'react';
import type { LockInfo } from '../worker/lockFile';
import type { OpenMode } from '../worker/companySession';
import { db } from '../shared/workerClient';
import { afterOpen } from './afterOpen';
import { deviceName } from './settings';
import { Dialog, ErrorText, TextField, formatDateTime, useAction } from './ui';

export function OpenCompanyDialog(props: {
  handle: FileSystemDirectoryHandle;
  title: string;
  onClose: () => void;
}) {
  const [passphrase, setPassphrase] = useState('');
  const [locked, setLocked] = useState<{ lock: LockInfo; stale: boolean } | null>(null);
  const { busy, error, run } = useAction();

  const open = (mode: OpenMode) =>
    run(async () => {
      const outcome = await db.open(props.handle, passphrase, { device: deviceName(), mode });
      if (outcome.kind === 'locked') {
        setLocked(outcome);
        return;
      }
      await afterOpen(props.handle, outcome.status);
    });

  return (
    <Dialog title={`Open ${props.title}`} onClose={busy ? undefined : props.onClose}>
      {!locked ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void open('edit');
          }}
        >
          <TextField
            label="Passphrase"
            type="password"
            value={passphrase}
            onChange={setPassphrase}
            autoFocus
            autoComplete="current-password"
          />
          <ErrorText>{error}</ErrorText>
          <div className="buttons">
            <button type="submit" disabled={busy || !passphrase}>
              {busy ? 'Opening…' : 'Open'}
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={props.onClose}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          {locked.stale ? (
            <p>
              <strong>{locked.lock.device}</strong> opened this company on{' '}
              {formatDateTime(locked.lock.openedAt)} and was last seen{' '}
              {formatDateTime(locked.lock.heartbeatAt)}. It looks like that session ended without
              closing (a crash or a closed laptop).
            </p>
          ) : (
            <p>
              <strong>{locked.lock.device}</strong> has this company open right now (since{' '}
              {formatDateTime(locked.lock.openedAt)}). Only one device can make changes at a time.
            </p>
          )}
          <ErrorText>{error}</ErrorText>
          <div className="buttons">
            {locked.stale && (
              <button disabled={busy} onClick={() => open('takeOver')}>
                Take over and edit here
              </button>
            )}
            <button
              className={locked.stale ? 'secondary' : undefined}
              disabled={busy}
              onClick={() => open('readOnly')}
            >
              Open read-only
            </button>
            <button className="secondary" disabled={busy} onClick={props.onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
