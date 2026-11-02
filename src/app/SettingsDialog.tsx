// Settings (CO-10), opened from the gear in the top bar and on the start
// screen. Settings here belong to this computer, not to a company's books.
// A choice applies at once; there's nothing to save.

import { useState } from 'react';
import { THEMES, setThemeChoice, themeChoice, type ThemeId } from './settings';
import { Dialog } from './ui';

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

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Settings" onClose={onClose}>
      <ThemeSection />
      <div className="buttons">
        <button className="secondary" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  );
}
