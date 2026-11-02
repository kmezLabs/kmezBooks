// Per-device preferences (not books): this device's name, shown to other
// devices in the lock file (DF-4), the inactivity lock (US-1), the
// register's account filter per company (GL-9), and the theme (CO-10). Browser storage may be
// unavailable or cleared, so every access has a fallback.

const DEVICE_KEY = 'kmezbooks.deviceName';
const INACTIVITY_KEY = 'kmezbooks.lockAfterMinutes';
// index.html reads this key too, to set the theme before the page draws
const THEME_KEY = 'kmezbooks.theme';
// Keys were "easybooks.*" before the rename; read once, then moved
const PREFIX = 'kmezbooks.';
const LEGACY_PREFIX = 'easybooks.';

export const DEFAULT_LOCK_MINUTES = 15;

function read(key: string): string | null {
  try {
    const value = localStorage.getItem(key);
    if (value !== null || !key.startsWith(PREFIX)) return value;
    const legacy = LEGACY_PREFIX + key.slice(PREFIX.length);
    const old = localStorage.getItem(legacy);
    if (old !== null) {
      localStorage.setItem(key, old);
      localStorage.removeItem(legacy);
    }
    return old;
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

/** What Chrome tells a page about the device (User-Agent Client Hints). */
export interface DeviceHints {
  platform?: string;
  platformVersion?: string;
  model?: string;
}

/**
 * A starting name for this device, from what the browser shares: "Windows 11 PC",
 * "Mac", or the phone's model on Android. Browsers never give pages the computer's
 * own name, so two alike computers get the same guess until the owner names them.
 */
export function guessDeviceName(userAgent: string, hints: DeviceHints = {}): string {
  const platform = hints.platform || '';
  if (platform === 'Android' || /Android/i.test(userAgent)) {
    return hints.model?.trim() || 'Android device';
  }
  if (platform === 'Windows' || /Windows/i.test(userAgent)) {
    // Chrome reports Windows 11 as platform version 13 or higher, Windows 10 as 1 to 12
    const major = Number(hints.platformVersion?.split('.')[0]);
    if (major >= 13) return 'Windows 11 PC';
    if (major >= 1) return 'Windows 10 PC';
    return 'Windows PC';
  }
  if (platform === 'macOS' || /Macintosh|Mac OS X/i.test(userAgent)) return 'Mac';
  if (platform === 'Chrome OS' || /CrOS/.test(userAgent)) return 'Chromebook';
  if (platform === 'Linux' || /Linux/i.test(userAgent)) return 'Linux PC';
  return 'This computer';
}

let detected: string | null = null;

/** Ask Chrome for the details behind guessDeviceName; called once at startup. */
export async function detectDevice(): Promise<void> {
  const uaData = (
    navigator as Navigator & {
      userAgentData?: { getHighEntropyValues(hints: string[]): Promise<DeviceHints> };
    }
  ).userAgentData;
  try {
    const hints = await uaData?.getHighEntropyValues(['platformVersion', 'model']);
    detected = guessDeviceName(navigator.userAgent, hints);
  } catch {
    // The plain guess from the user agent applies
  }
}

/** True once the owner has named this device (Settings, This device). */
export function deviceNamed(): boolean {
  return !!read(DEVICE_KEY);
}

export function deviceName(): string {
  return read(DEVICE_KEY) || detected || guessDeviceName(navigator.userAgent);
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

const registerAccountKey = (companyId: string, kind?: string) =>
  kind ? `${PREFIX}registerAccount.${kind}.${companyId}` : `${PREFIX}registerAccount.${companyId}`;

/**
 * The account the Transactions register was last filtered to, for this
 * company (GL-9); with 'single', the account the Accounts register shows (GL-13).
 */
export function registerAccount(companyId: string, kind?: string): string | null {
  return read(registerAccountKey(companyId, kind)) || null;
}

export function setRegisterAccount(companyId: string, accountId: string | null, kind?: string) {
  write(registerAccountKey(companyId, kind), accountId ?? '');
}

/** The themes in Settings (CO-10); System follows the computer's light or dark setting. */
export const THEMES = [
  { id: 'system', name: 'System', about: "Follows this computer's light or dark setting." },
  { id: 'light', name: 'Light', about: 'White pages, dark text.' },
  { id: 'dark', name: 'Dark', about: 'Dark pages, light text, for dim rooms.' },
  { id: 'grey', name: 'Grey', about: 'Softer than Light, with less glare.' },
  { id: 'contrast', name: 'High contrast', about: 'Black on white with stronger lines.' },
  { id: 'warm', name: 'Warm', about: 'Cream paper and brown ink, for long sessions.' },
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

export function themeChoice(): ThemeId {
  const id = read(THEME_KEY);
  return THEMES.find((t) => t.id === id)?.id ?? 'system';
}

/** Saves the theme for this device and shows it at once. */
export function setThemeChoice(id: ThemeId) {
  write(THEME_KEY, id);
  applyTheme(id);
}

export function applyTheme(id: ThemeId) {
  const root = document.documentElement;
  if (id === 'system') delete root.dataset.theme;
  else root.dataset.theme = id;
}
