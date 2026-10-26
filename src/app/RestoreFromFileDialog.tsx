// Restore a company from a backup file into an empty folder, for when the
// company folder itself is lost (DF-10).

import { useState } from 'react';
import type { BackupPreview } from '../worker/company';
import { db } from '../shared/workerClient';
import { afterOpen } from './afterOpen';
import { pickBackupFile, pickFolder } from './recentFolders';
import { deviceName } from './settings';
import { Dialog, ErrorText, TextField, formatDateTime, useAction } from './ui';

export function RestoreFromFileDialog({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<FileSystemFileHandle | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const { busy, error, run } = useAction();

  const choose = () =>
    run(async () => {
      const picked = await pickBackupFile();
      if (picked) {
        setFile(picked);
        setPreview(null);
      }
    });

  const check = () => run(async () => setPreview(await db.previewBackupFile(file!, passphrase)));

  const restore = () =>
    run(async () => {
      const target = await pickFolder();
      if (!target) return;
      const status = await db.restoreInto(file!, passphrase, target, deviceName());
      await afterOpen(target, status);
    });

  return (
    <Dialog title="Restore from a backup file" onClose={busy ? undefined : onClose}>
      <p className="muted">
        Use this when a company folder is lost. Backups are in each company folder's{' '}
        <code>backups</code> folder, or wherever you chose to keep them. To go back to an earlier
        version of a company you can still open, use its Backups page instead.
      </p>
      <div className="buttons">
        <button className={file ? 'secondary' : undefined} disabled={busy} onClick={choose}>
          {file ? 'Choose another file…' : 'Choose backup file…'}
        </button>
        {file && <span className="muted">{file.name}</span>}
      </div>
      {file && !preview && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void check();
          }}
        >
          <TextField
            label="Passphrase of that backup"
            type="password"
            value={passphrase}
            onChange={setPassphrase}
            autoFocus
            hint="The passphrase the company had when the backup was made."
          />
          <div className="buttons">
            <button type="submit" disabled={busy || !passphrase}>
              Check backup
            </button>
          </div>
        </form>
      )}
      {preview && (
        <>
          <p>
            <strong>{preview.legalName}</strong>, last activity{' '}
            {formatDateTime(preview.latestActivity)}.
          </p>
          <p className="muted">Next, choose an empty folder to restore it into.</p>
          <div className="buttons">
            <button disabled={busy} onClick={restore}>
              {busy ? 'Restoring…' : 'Choose folder and restore'}
            </button>
          </div>
        </>
      )}
      <ErrorText>{error}</ErrorText>
      <div className="buttons">
        <button className="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}
