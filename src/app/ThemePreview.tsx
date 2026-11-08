// A small page in a theme's own colours (CO-11): its data-theme sets them, so
// the sample shows the real theme whatever the page around it uses.

import type { ThemeId } from '../shared/themes';

function Sample({ theme }: { theme: Exclude<ThemeId, 'system'> }) {
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

/** Following the computer shows its light and dark looks side by side. */
export function ThemePreview({ theme }: { theme: ThemeId }) {
  return theme === 'system' ? (
    <span className="theme-preview split" aria-hidden="true">
      <Sample theme="light" />
      <Sample theme="dark" />
    </span>
  ) : (
    <span aria-hidden="true">
      <Sample theme={theme} />
    </span>
  );
}
