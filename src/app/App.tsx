// Root: follows the worker's session status and shows the start screen or the
// open company. Also the app-wide safety nets: lock after inactivity (US-1),
// save when the tab is hidden, and warn before closing with unsaved work (DF-2).

import * as Comlink from 'comlink';
import { useEffect, useRef, useState } from 'react';
import type { SessionStatus } from '../worker/companySession';
import { db } from '../shared/workerClient';
import { StartScreen } from './StartScreen';
import { Workspace } from './Workspace';
import { lockAfterMinutes } from './settings';

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

export function App() {
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
      `Locked after ${lockAfterMinutes()} minutes without activity. Open the company again to continue.`,
    ),
  );

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
  return status.open ? <Workspace status={status} /> : <StartScreen notice={notice} />;
}
