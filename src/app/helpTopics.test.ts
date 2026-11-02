// CO-9: every page's help points at a section the user guide really has.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderGuide } from '../../scripts/guide.mjs';
import { HELP_TOPICS } from './helpTopics';

const guide = renderGuide(
  readFileSync(new URL('../../docs/USER-GUIDE.md', import.meta.url), 'utf8'),
);
const section = (id: string) => guide.headings.find((h) => h.id === id);

describe('help topics (CO-9)', () => {
  it('names only headings the guide has', () => {
    const missing = Object.entries(HELP_TOPICS).flatMap(([page, ids]) =>
      ids.filter((id) => !section(id)).map((id) => `${page}: #${id}`),
    );
    expect(missing).toEqual([]);
  });

  it('the guide has no broken "#…" links', () => {
    expect(guide.brokenLinks).toEqual([]);
  });

  it('a section runs from its heading to the next one of the same level', () => {
    const r = section('reconciling')!;
    const html = guide.html.slice(r.start, r.end);
    expect(html.startsWith('<h3 id="reconciling">')).toBe(true);
    expect(html).not.toContain('<h2');
    expect(guide.html.slice(r.end)).toMatch(/^<h2 id="sales-invoices-and-estimates">/);
  });

  it('a chapter takes its parts with it', () => {
    const b = section('banking')!;
    const html = guide.html.slice(b.start, b.end);
    for (const id of [
      'importing-statements',
      'reviewing-transactions',
      'bank-rules',
      'reconciling',
    ])
      expect(html).toContain(`id="${id}"`);
    expect(html).not.toContain('id="sales-invoices-and-estimates"');
  });
});
