import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deviceName,
  deviceNamed,
  guessDeviceName,
  lockAfterMinutes,
  registerAccount,
  setDeviceName,
  setLockAfterMinutes,
  forgetComputerTheme,
} from './settings';
import { applyTheme, isThemeId, THEMES } from '../shared/themes';

describe('device settings', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps settings saved under the old easybooks.* keys, moving them to kmezbooks.*', () => {
    store.set('easybooks.lockAfterMinutes', '30');
    store.set('easybooks.registerAccount.single.c1', 'acct-9');
    expect(lockAfterMinutes()).toBe(30);
    expect(registerAccount('c1', 'single')).toBe('acct-9');
    expect([...store.keys()].sort()).toEqual([
      'kmezbooks.lockAfterMinutes',
      'kmezbooks.registerAccount.single.c1',
    ]);
  });

  it('writes the new keys, which win over any old one', () => {
    store.set('easybooks.lockAfterMinutes', '30');
    setLockAfterMinutes(5);
    expect(lockAfterMinutes()).toBe(5);
    expect(store.get('kmezbooks.lockAfterMinutes')).toBe('5');
  });

  it('starts from a name guessed from the device, until one is saved', () => {
    vi.stubGlobal('navigator', { userAgent: WINDOWS });
    expect(deviceNamed()).toBe(false);
    expect(deviceName()).toBe('Windows PC');
    setDeviceName('  Office PC ');
    expect(deviceNamed()).toBe(true);
    expect(deviceName()).toBe('Office PC');
  });
});

const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

describe('guessing the device name', () => {
  it('tells Windows 11 from Windows 10 by the platform version Chrome reports', () => {
    expect(guessDeviceName(WINDOWS, { platform: 'Windows', platformVersion: '19.0.0' })).toBe(
      'Windows 11 PC',
    );
    expect(guessDeviceName(WINDOWS, { platform: 'Windows', platformVersion: '13.0.0' })).toBe(
      'Windows 11 PC',
    );
    expect(guessDeviceName(WINDOWS, { platform: 'Windows', platformVersion: '10.0.0' })).toBe(
      'Windows 10 PC',
    );
    // Without the details, the user agent alone can't tell them apart
    expect(guessDeviceName(WINDOWS)).toBe('Windows PC');
  });

  it("uses an Android phone's model", () => {
    expect(guessDeviceName(ANDROID, { platform: 'Android', model: 'Pixel 8' })).toBe('Pixel 8');
    expect(guessDeviceName(ANDROID, { platform: 'Android', model: '' })).toBe('Android device');
  });

  it('names Macs, Chromebooks and Linux, and falls back to "This computer"', () => {
    expect(guessDeviceName(MAC, { platform: 'macOS', platformVersion: '15.1.0' })).toBe('Mac');
    expect(guessDeviceName(MAC)).toBe('Mac');
    expect(guessDeviceName('Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)')).toBe('Chromebook');
    expect(guessDeviceName('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Linux PC');
    expect(guessDeviceName('Something else')).toBe('This computer');
  });
});

describe('the theme (CO-11)', () => {
  let store: Map<string, string>;
  const root = { dataset: {} as Record<string, string> };
  beforeEach(() => {
    store = new Map();
    root.dataset = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    vi.stubGlobal('document', { documentElement: root });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('marks the page with a theme at once, and following the computer clears it', () => {
    for (const { id } of THEMES) {
      applyTheme(id);
      expect(root.dataset.theme).toBe(id === 'system' ? undefined : id);
    }
  });

  it('knows its themes', () => {
    expect(isThemeId('ocean')).toBe(true);
    expect(isThemeId('neon')).toBe(false);
    expect(isThemeId(null)).toBe(false);
  });

  it('forgets the theme this computer kept before themes moved into companies', () => {
    store.set('kmezbooks.theme', 'dark');
    store.set('kmezbooks.deviceName', 'Office PC');
    forgetComputerTheme();
    expect(store.has('kmezbooks.theme')).toBe(false);
    expect(store.get('kmezbooks.deviceName')).toBe('Office PC');
    vi.stubGlobal('localStorage', {
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => forgetComputerTheme()).not.toThrow();
  });
});
