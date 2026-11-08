// Settings (CO-10), opened from the gear in the top bar and on the start
// screen: this computer's settings, not a company's. Each company's theme is on
// its Company page (CO-11). More app-wide sections can join This device here.

import { useState } from 'react';
import {
  deviceName,
  deviceNamed,
  lockAfterMinutes,
  setDeviceName,
  setLockAfterMinutes,
} from './settings';
import { Dialog, TextField } from './ui';

/** Its name, shown to other devices in the lock file (DF-4), and the inactivity lock (US-1). */
function DeviceSection() {
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

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Settings" onClose={onClose}>
      <p className="muted">
        Settings for this computer. Each company&rsquo;s theme is on its Company page.
      </p>
      <DeviceSection />
      <div className="buttons">
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
