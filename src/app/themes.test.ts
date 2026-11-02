// CO-10: every theme in app.css has all the colours, and they're readable.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEMES } from './settings';

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

/** The custom properties (and color-scheme) in the first block that `selector` opens. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no block for ${selector}`);
  const body = css.slice(at + selector.length + 2, css.indexOf('}', at));
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+|color-scheme):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]),
  );
}

const COLOURS = [
  '--fg',
  '--muted',
  '--bg',
  '--panel',
  '--line',
  '--accent',
  '--accent-fg',
  '--error',
  '--error-bg',
  '--warn',
  '--warn-bg',
  '--ok',
  '--notice-bg',
  '--overlay',
];

const themes: Record<string, Record<string, string>> = {
  'system (light)': block(':root'),
  'system (dark)': block(':root:not([data-theme])'),
  ...Object.fromEntries(
    THEMES.filter((t) => t.id !== 'system').map((t) => [t.id, block(`[data-theme='${t.id}']`)]),
  ),
};

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// Text colour on background colour, as the app uses them
const PAIRS = [
  ['--fg', '--bg'],
  ['--fg', '--panel'],
  ['--muted', '--bg'],
  ['--muted', '--panel'],
  ['--accent', '--bg'],
  ['--accent', '--panel'],
  ['--accent-fg', '--accent'],
  ['--error', '--bg'],
  ['--error', '--error-bg'],
  ['--warn', '--warn-bg'],
  ['--ok', '--bg'],
  ['--ok', '--panel'],
  ['--fg', '--notice-bg'],
  ['--fg', '--error-bg'],
  ['--fg', '--warn-bg'],
] as const;

describe('themes (CO-10)', () => {
  it.each(Object.entries(themes))('%s has every colour and a color-scheme', (_, t) => {
    expect(COLOURS.filter((c) => !t[c])).toEqual([]);
    expect(['light', 'dark']).toContain(t['color-scheme']);
  });

  it.each(Object.entries(themes))('%s is readable: every pair reaches 4.5:1', (name, t) => {
    const need = name === 'contrast' ? 7 : 4.5;
    const weak = PAIRS.filter(([fg, bg]) => contrast(t[fg]!, t[bg]!) < need).map(
      ([fg, bg]) => `${fg} on ${bg}: ${contrast(t[fg]!, t[bg]!).toFixed(2)}`,
    );
    expect(weak).toEqual([]);
  });

  it('Dark is the same as the dark look System follows', () => {
    expect(themes.dark).toEqual(themes['system (dark)']);
  });

  it('Light is the same as the light look System follows', () => {
    expect(themes.light).toEqual(themes['system (light)']);
  });

  it('printing resets every colour to light, whatever the theme', () => {
    const at = css.indexOf(':root,\n  [data-theme] {');
    expect(at).toBeGreaterThan(css.indexOf('@media print'));
    const t = block(':root,\n  [data-theme]');
    expect(COLOURS.filter((c) => !t[c])).toEqual([]);
    expect(t['color-scheme']).toBe('light');
    expect(t['--bg']).toBe('#ffffff');
  });
});
