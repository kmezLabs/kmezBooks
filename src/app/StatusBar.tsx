// The status bar at the bottom of every screen (CO-6): save state, the last
// backup, online or offline, the latest message after an action, and on the
// far right the app's version and the build it came from, which opens About (CO-8).

import { useEffect, useState } from 'react';
import type { SessionStatus } from '../worker/companySession';
import { formatAgo, versionText } from './statusText';
import { useStatusMessage } from './statusMessages';
import { formatDateTime, formatTime } from './ui';

function SaveState({ status }: { status: SessionStatus }) {
  if (status.readOnly) return <span className="badge">Read-only</span>;
  if (status.saving) return <span className="save-state">Saving…</span>;
  if (status.error) return <span className="save-state error-text">Not saved</span>;
  if (status.dirty) return <span className="save-state">Unsaved changes</span>;
  return (
    <span className="save-state">
      {status.lastSavedAt ? `Saved ${formatTime(status.lastSavedAt)}` : 'All changes saved'}
    </span>
  );
}

function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/** Re-render every minute, so "2 minutes ago" moves on. */
function useMinuteTick() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);
}

export function StatusBar({ status, onAbout }: { status: SessionStatus; onAbout: () => void }) {
  const online = useOnline();
  const message = useStatusMessage();
  useMinuteTick();
  const version = versionText();

  return (
    <footer className="status-bar">
      {status.open && <SaveState status={status} />}
      {status.open && (
        <span
          className={status.backupOverdue ? 'warn-text' : undefined}
          title={status.latestBackupAt ? formatDateTime(status.latestBackupAt) : undefined}
        >
          {status.latestBackupAt
            ? `Backed up ${formatAgo(status.latestBackupAt)}`
            : 'No backup yet'}
        </span>
      )}
      <span className={online ? undefined : 'warn-text'}>
        {online ? 'Online' : 'Offline: everything still works'}
      </span>
      <span className="status-message" aria-live="polite">
        {message}
      </span>
      <button
        className="link status-version"
        title={`${version.title}. Click for About kmezBooks.`}
        onClick={onAbout}
      >
        {version.short}
      </button>
    </footer>
  );
}
