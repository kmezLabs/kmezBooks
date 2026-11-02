// Root: follows the worker's session status and shows the start screen or the
// open company. Also the app-wide safety nets: lock after inactivity (US-1),
// save when the tab is hidden, and warn before closing with unsaved work (DF-2).

import * as Comlink from 'comlink';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { SessionStatus } from '../worker/companySession';
import { db } from '../shared/workerClient';
import { AboutDialog } from './AboutDialog';
import { StartScreen } from './StartScreen';
import { StatusBar } from './StatusBar';
import { UpdateBanner } from './UpdateBanner';
import { Workspace } from './Workspace';
import { lockAfterMinutes } from './settings';
import { companyLabel, windowTitle } from './statusText';

const ACTIVITY = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;

function useInactivityLock(open: boolean, onLocked: () => void) {
  const last = useRef(0);
  // Latest callback without restarting the timer on every render
  const locked = useRef(onLocked);
  useEffect(() => {
    locked.current = onLocked;
  });
  useEffect(() => {
    if (!open) return;
    last.current = Date.now();
    const seen = () => (last.current = Date.now());
    ACTIVITY.forEach((e) => window.addEventListener(e, seen, { passive: true }));
    const timer = setInterval(() => {
      if (Date.now() - last.current > lockAfterMinutes() * 60_000) {
        // If the save fails the company stays open and shows why
        void db.close().then(
          () => locked.current(),
          () => {},
        );
      }
    }, 15_000);
    return () => {
      clearInterval(timer);
      ACTIVITY.forEach((e) => window.removeEventListener(e, seen));
    };
  }, [open]);
}

// The installed app's own window, not a browser tab. "Open in kmezBooks" moves
// a tab into one without reloading, so this follows the change.
const INSTALLED =
  '(display-mode: standalone), (display-mode: window-controls-overlay), (display-mode: minimal-ui)';

function useInstalledWindow(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia(INSTALLED);
      query.addEventListener('change', changed);
      return () => query.removeEventListener('change', changed);
    },
    () => window.matchMedia(INSTALLED).matches,
  );
}

export function App() {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [about, setAbout] = useState(false);
  const showAbout = () => setAbout(true);

  useEffect(() => {
    const update = (s: SessionStatus) => {
      setStatus(s);
      // A company opened: the "locked after inactivity" notice has done its job
      if (s.open) setNotice(null);
    };
    void db.subscribe(Comlink.proxy(update)).then(update);
  }, []);

  useInactivityLock(!!status?.open, () =>
    setNotice(
      `Closed after ${lockAfterMinutes()} minutes without activity. Open the company again to continue.`,
    ),
  );

  // The open company's name on the browser tab and the installed app's title bar
  // (CO-2), with "– Test" for a test company (CO-7)
  const title = windowTitle(
    status?.open ? companyLabel(status.legalName, status.test) : null,
    useInstalledWindow(),
  );
  useEffect(() => {
    document.title = title;
  }, [title]);

  const unsaved = !!status && (status.dirty || status.saving);
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') void db.save().catch(() => {});
    };
    const leaving = (e: BeforeUnloadEvent) => {
      if (unsaved) e.preventDefault();
    };
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('beforeunload', leaving);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('beforeunload', leaving);
    };
  }, [unsaved]);

  if (!status) return <p className="loading">Loading…</p>;
  return (
    // Fills the window: the banner and status bar stay put, the screen between them scrolls
    <div className="app-shell">
      <UpdateBanner status={status} />
      <div className="screen">
        {status.open ? (
          <Workspace status={status} onAbout={showAbout} />
        ) : (
          <StartScreen notice={notice} onAbout={showAbout} />
        )}
      </div>
      <StatusBar status={status} onAbout={showAbout} />
      {/* One About panel for every screen (CO-8) */}
      {about && <AboutDialog onClose={() => setAbout(false)} />}
    </div>
  );
}
