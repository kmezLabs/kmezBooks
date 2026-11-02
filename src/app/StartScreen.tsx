// No company open: recent companies, open a folder, create, or restore (DF-1, CO-2).

import { useEffect, useState } from 'react';
import { CreateCompanyDialog } from './CreateCompanyDialog';
import { OpenCompanyDialog } from './OpenCompanyDialog';
import { RestoreFromFileDialog } from './RestoreFromFileDialog';
import {
  ensureReadWrite,
  folderPickerSupported,
  forgetFolder,
  listRecentFolders,
  pickFolder,
  type RecentFolder,
} from './recentFolders';
import { ErrorText, formatDateTime, useAction } from './ui';

type Open = { handle: FileSystemDirectoryHandle; title: string };

/** The start screen's title, with About (CO-8) on the right. */
function StartHeader({ onAbout }: { onAbout: () => void }) {
  return (
    <div className="start-header">
      <h1>kmezBooks</h1>
      <button className="link" onClick={onAbout}>
        About
      </button>
    </div>
  );
}

export function StartScreen({ notice, onAbout }: { notice: string | null; onAbout: () => void }) {
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const [opening, setOpening] = useState<Open | null>(null);
  const [dialog, setDialog] = useState<'create' | 'restore' | null>(null);
  const { error, run } = useAction();

  const refresh = () => void listRecentFolders().then(setRecent);
  useEffect(refresh, []);

  // Permission prompts need the click itself, so ask before showing the passphrase dialog
  const openRecent = (f: RecentFolder) =>
    run(async () => {
      if (!(await ensureReadWrite(f.handle)))
        throw new Error(`kmezBooks needs access to the folder ${f.handle.name}.`);
      setOpening({ handle: f.handle, title: f.name });
    });

  const openFolder = () =>
    run(async () => {
      const handle = await pickFolder();
      if (handle) setOpening({ handle, title: handle.name });
    });

  if (!folderPickerSupported()) {
    return (
      <main className="start">
        <StartHeader onAbout={onAbout} />
        <p className="warning">
          This browser can't open folders on your disk, which kmezBooks needs to keep your books.
          Use Chrome on a computer.
        </p>
      </main>
    );
  }

  return (
    <main className="start">
      <StartHeader onAbout={onAbout} />
      {notice && <p className="notice">{notice}</p>}
      <section>
        <h2>Companies</h2>
        {recent.length === 0 ? (
          <p className="muted">No companies opened on this device yet.</p>
        ) : (
          <ul className="company-list">
            {recent.map((f) => (
              <li key={`${f.name}-${f.lastOpened}`}>
                <button className="company" onClick={() => openRecent(f)}>
                  <strong>{f.name}</strong>
                  <span className="muted">
                    Folder {f.handle.name} · last opened {formatDateTime(new Date(f.lastOpened))}
                  </span>
                </button>
                <button
                  className="link muted"
                  title="Remove from this list (the company folder is not touched)"
                  onClick={() => void forgetFolder(f.handle).then(refresh)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button onClick={openFolder}>Open company folder…</button>
          <button className="secondary" onClick={() => setDialog('create')}>
            New company…
          </button>
          <button className="secondary" onClick={() => setDialog('restore')}>
            Restore from backup…
          </button>
        </div>
      </section>

      {opening && (
        <OpenCompanyDialog
          handle={opening.handle}
          title={opening.title}
          onClose={() => setOpening(null)}
        />
      )}
      {dialog === 'create' && <CreateCompanyDialog onClose={() => setDialog(null)} />}
      {dialog === 'restore' && <RestoreFromFileDialog onClose={() => setDialog(null)} />}
    </main>
  );
}
