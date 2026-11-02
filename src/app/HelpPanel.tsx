// Help (CO-9): the user guide's sections for the page you're on, beside the
// page so you can keep working. The guide is built into the app from
// docs/USER-GUIDE.md (vite.config.ts), so help works offline and always
// matches the guide. Its "#…" links move within the panel.

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import guide from 'virtual:user-guide';
import { SITE } from './AboutDialog';

export function HelpPanel({ topics, onClose }: { topics: readonly string[]; onClose: () => void }) {
  // The sections shown, newest last; Back returns to the one before
  const [stack, setStack] = useState<(readonly string[])[]>([topics]);
  const body = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);

  // Focus moves into the panel, and back to the ? (or wherever it was) as it closes
  useLayoutEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => before?.focus();
  }, []);

  const shown = stack[stack.length - 1]!.filter((id) => guide.sections[id]);
  // A block, not an expression: Chrome's scrollTo returns a promise, which React
  // would keep as the effect's cleanup and then fail to call
  useEffect(() => {
    body.current?.scrollTo(0, 0);
  }, [stack]);

  const html = shown
    .map((id) => guide.html.slice(guide.sections[id]!.start, guide.sections[id]!.end))
    .join('');
  const title = shown[0] ? guide.sections[shown[0]]!.title : 'Help';

  const onClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (!a || !href) return;
    if (href.startsWith('#')) {
      e.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      if (guide.sections[id]) setStack((s) => [...s, [id]]);
    } else {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  };

  return (
    <aside
      ref={panel}
      className="help-panel"
      aria-label={`Help: ${title}`}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="help-head">
        {stack.length > 1 && (
          <button className="secondary" onClick={() => setStack((s) => s.slice(0, -1))}>
            Back
          </button>
        )}
        <strong>Help</strong>
        <button className="help-close" aria-label="Close help" title="Close help" onClick={onClose}>
          ×
        </button>
      </div>
      <div ref={body} className="help-body" onClick={onClick}>
        {/* Our own guide, rendered at build time; never anything a user typed */}
        <div dangerouslySetInnerHTML={{ __html: html }} />
        <p className="help-online">
          <a href={`${SITE}guide/#${shown[0] ?? ''}`} target="_blank" rel="noopener noreferrer">
            Open the full guide online
          </a>
        </p>
      </div>
    </aside>
  );
}
