// Short messages after an action ("Saved report.xlsx to Downloads"), shown in
// the status bar for a few seconds (CO-6). Information only: errors stay
// where they happen.

import { useSyncExternalStore } from 'react';

/** How long a message stays */
export const MESSAGE_MS = 6_000;

let current: string | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function set(text: string | null) {
  current = text;
  listeners.forEach((l) => l());
}

/** Show a message in the status bar, replacing the one before. */
export function announce(text: string) {
  clearTimeout(timer);
  set(text);
  timer = setTimeout(() => set(null), MESSAGE_MS);
}

/** The message showing now, if any. */
export function currentMessage(): string | null {
  return current;
}

export function useStatusMessage(): string | null {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, currentMessage);
}
