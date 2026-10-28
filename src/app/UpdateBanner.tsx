// "A new version is ready" (M8). The service worker installs a new version in
// the background and keeps it waiting (registerType 'prompt'), so the running
// page never loses files it still needs. The owner chooses when to switch:
// an open company is saved and closed first (DF-2), and if that fails the
// update waits and the reason shows.

import { useRegisterSW } from 'virtual:pwa-register/react';
import type { SessionStatus } from '../worker/companySession';
import { db } from '../shared/workerClient';
import { ErrorText, useAction } from './ui';

/** How often an open app looks for a new version */
const CHECK_EVERY = 60 * 60 * 1000;

export function UpdateBanner({ status }: { status: SessionStatus }) {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      if (registration) setInterval(() => void registration.update(), CHECK_EVERY);
    },
  });
  const { busy, error, run } = useAction();
  if (!needRefresh) return null;

  return (
    <div className="update-banner" role="status">
      <span>A new version of EasyBooks is ready.</span>
      <button
        disabled={busy || status.saving}
        onClick={() =>
          void run(async () => {
            // Saves first; a failed save throws and the update waits
            if (status.open) await db.close();
            await updateServiceWorker(true);
          })
        }
      >
        {status.open ? 'Save, close and update' : 'Update now'}
      </button>
      {status.open && (
        <span className="hint">
          The company is saved and closed; open it again after the update.
        </span>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
