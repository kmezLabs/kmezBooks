// Settings (CO-10), opened from the gear in the top bar and on the start
// screen. Settings here belong to this computer, not to a company's books.
// A theme applies at once; the device's name and idle time save with their button.

import { useState } from 'react';
import {
  THEMES,
  deviceName,
  deviceNamed,
  lockAfterMinutes,
  setDeviceName,
  setLockAfterMinutes,
  setThemeChoice,
  themeChoice,
  type ThemeId,
} from './settings';
import { Dialog, TextField } from './ui';

/** A small page in a theme's own colours (its data-theme sets them). */
function Preview({ theme }: { theme: Exclude<ThemeId, 'system'> }) {
  return (
    <span className="theme-preview" data-theme={theme}>
      <span className="tp-panel">
        <span>
          Aa <span className="tp-muted">12.50</span>
        </span>
        <span className="tp-button">OK</span>
      </span>
    </span>
  );
}

function ThemeSection() {
  const [chosen, setChosen] = useState<ThemeId>(themeChoice);
  return (
    <>
      <h3>Theme</h3>
      <div className="theme-options" role="radiogroup" aria-label="Theme">
        {THEMES.map((t) => (
          <label key={t.id} className="theme-card">
            {t.id === 'system' ? (
              <span className="theme-preview split">
                <Preview theme="light" />
                <Preview theme="dark" />
              </span>
            ) : (
              <Preview theme={t.id} />
            )}
            <span className="theme-name">
              <input
                type="radio"
                name="theme"
                value={t.id}
                checked={chosen === t.id}
                onChange={() => {
                  setThemeChoice(t.id);
                  setChosen(t.id);
                }}
              />
              {t.name}
            </span>
            <span className="muted">{t.about}</span>
          </label>
        ))}
      </div>
      <p className="muted">Saved for this computer. Printed reports are always light.</p>
    </>
  );
}

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
      <ThemeSection />
      <DeviceSection />
      <div className="buttons">
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
