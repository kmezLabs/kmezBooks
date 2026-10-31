import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { lockAfterMinutes, registerAccount, setLockAfterMinutes } from './settings';

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
});
