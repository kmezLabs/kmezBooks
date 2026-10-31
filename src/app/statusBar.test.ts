import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_MS, announce, currentMessage } from './statusMessages';
import { formatAgo, versionText, windowTitle } from './statusText';

describe('status bar (CO-6)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says how long ago, in whole minutes, hours or days', () => {
    const now = new Date('2026-10-31T12:00:00Z');
    const ago = (ms: number) => formatAgo(new Date(now.getTime() - ms), now);
    expect(ago(30_000)).toBe('just now');
    expect(ago(60_000)).toBe('1 minute ago');
    expect(ago(59 * 60_000)).toBe('59 minutes ago');
    expect(ago(60 * 60_000)).toBe('1 hour ago');
    expect(ago(23 * 3_600_000)).toBe('23 hours ago');
    expect(ago(24 * 3_600_000)).toBe('1 day ago');
    expect(ago(9 * 86_400_000)).toBe('9 days ago');
    expect(formatAgo('2026-10-31T11:55:00Z', now)).toBe('5 minutes ago');
  });

  it('shows the latest message, then clears it', () => {
    vi.useFakeTimers();
    announce('Saved report.xlsx to Downloads');
    vi.advanceTimersByTime(MESSAGE_MS - 1_000);
    announce('Backup saved');
    expect(currentMessage()).toBe('Backup saved');
    // A new message starts its own time
    vi.advanceTimersByTime(MESSAGE_MS - 1);
    expect(currentMessage()).toBe('Backup saved');
    vi.advanceTimersByTime(1);
    expect(currentMessage()).toBeNull();
  });

  it('shows the version from package.json and the build it came from', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(__APP_VERSION__).toBe(pkg.version);
    expect(__APP_BUILD__).toMatch(/^([0-9a-f]{7,} \d{4}-\d{2}-\d{2}|dev)$/);
    expect(versionText('0.1.0', '6035081 2026-10-30')).toEqual({
      short: 'v0.1.0 · build 6035081, Oct 30',
      title: 'EasyBooks 0.1.0, built from commit 6035081 on 2026-10-30',
    });
    expect(versionText('0.1.0', 'dev').short).toBe('v0.1.0 · build dev');
  });

  it('puts the open company first in the window title (CO-2)', () => {
    expect(windowTitle('Acme Holdings LLC')).toBe('Acme Holdings LLC – EasyBooks');
    expect(windowTitle('  Acme LLC ')).toBe('Acme LLC – EasyBooks');
    expect(windowTitle(null)).toBe('EasyBooks');
    expect(windowTitle('')).toBe('EasyBooks');
  });
});
