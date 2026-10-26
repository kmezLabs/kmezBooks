// Per-device preferences (not books): this device's name, shown to other
// devices in the lock file (DF-4), and the inactivity lock (US-1). Browser
// storage may be unavailable or cleared, so every access has a fallback.

const DEVICE_KEY = 'easybooks.deviceName';
const INACTIVITY_KEY = 'easybooks.lockAfterMinutes';

export const DEFAULT_LOCK_MINUTES = 15;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not fatal: the default applies next time
  }
}

export function deviceName(): string {
  return (
    read(DEVICE_KEY) || (/Android/i.test(navigator.userAgent) ? 'Android device' : 'This computer')
  );
}

export function setDeviceName(name: string) {
  write(DEVICE_KEY, name.trim());
}

export function lockAfterMinutes(): number {
  const n = Number(read(INACTIVITY_KEY));
  return Number.isInteger(n) && n >= 1 && n <= 240 ? n : DEFAULT_LOCK_MINUTES;
}

export function setLockAfterMinutes(minutes: number) {
  write(INACTIVITY_KEY, String(minutes));
}
