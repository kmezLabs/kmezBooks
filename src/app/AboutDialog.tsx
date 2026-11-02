// About kmezBooks (CO-8): the version and build, what happens to your books
// (they stay on your disk, and nothing is reported back), links to the site,
// and the copyright and GPL notice. Opened from the About link at the top and
// from the version in the status bar.

import { Dialog } from './ui';
import { versionText } from './statusText';

/** The published site (GitHub Pages); its links work from localhost too. */
const SITE = 'https://mawadk.github.io/kmezBooks/';

function Out({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="About kmezBooks" onClose={onClose}>
      <div className="about-head">
        <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" width={48} height={48} />
        <div>
          <strong>kmezBooks</strong>
          <p className="muted">Double-entry bookkeeping for small businesses, on a cash basis.</p>
        </div>
      </div>
      <p>{versionText().title}</p>

      <h3>Your books and your privacy</h3>
      <p>
        Designed and Developed by Khaleel Mawad.
      </p>

      <p>
        Your books never leave your computer. Each company is an encrypted folder on your own disk,
        unlocked with its passphrase.
      </p>
      <p>
        No telemetry: kmezBooks sends no usage data, analytics or crash reports. It goes online only
        to load itself and to check for a new version.
      </p>
      <p>
        This project is maintained by Khaleel Mawad and is open to contributions and feedback.
      </p>

      <h3>Links</h3>
      <ul className="about-links">
        <li>
          <Out href={SITE}>Home page</Out>
        </li>
        <li>
          <Out href={`${SITE}guide/`}>User guide</Out>
        </li>
        <li>
          <Out href="https://github.com/mawadk/kmezBooks">Source code on GitHub</Out>
        </li>
      </ul>
      <p className="muted">Links need an internet connection.</p>

      <h3>License</h3>
      <p>Copyright (C) 2026 Khaleel Mawad</p>
      <p>
        kmezBooks is free software: you can redistribute it and/or modify it under the terms of the
        GNU General Public License, version 3 or later. It comes with ABSOLUTELY NO WARRANTY.
      </p>
      <p>
        <Out href={`${SITE}license.txt`}>License</Out> ·{' '}
        <Out href={`${SITE}app/third-party-licenses.txt`}>Third-party licenses</Out>
      </p>

      <div className="buttons">
        <button onClick={onClose}>Close</button>
      </div>
    </Dialog>
  );
}
