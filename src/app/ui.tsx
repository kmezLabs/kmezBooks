// Small shared UI pieces.

import { useCallback, useState, type ReactNode } from 'react';
import { errorMessage } from '../shared/workerClient';

/** Run an async action, tracking whether it's busy and its error message. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, setError, run };
}

export function Dialog(props: { title: string; children: ReactNode; onClose?: () => void }) {
  return (
    <div className="overlay" onClick={props.onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === 'Escape' && props.onClose?.()}
      >
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? (
    <p className="error" role="alert">
      {children}
    </p>
  ) : null;
}

export function TextField(props: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: 'text' | 'password';
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete?: string;
  hint?: string;
  width?: 'short' | 'long';
}) {
  return (
    <label className={props.width === 'short' ? 'short' : undefined}>
      {props.label}
      <input
        type={props.type ?? 'text'}
        value={props.value}
        placeholder={props.placeholder}
        autoFocus={props.autoFocus}
        autoComplete={props.autoComplete ?? 'off'}
        onChange={(e) => props.onChange(e.target.value)}
      />
      {props.hint && <span className="hint">{props.hint}</span>}
    </label>
  );
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const d = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(d.getTime()) ? String(value) : dateTime.format(d);
}

export function formatTime(value: string | null): string {
  return value ? time.format(new Date(value)) : '—';
}

export function formatBytes(bytes: number): string {
  return bytes >= 1e6
    ? `${(bytes / 1e6).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export const MIN_PASSPHRASE = 10;

export function passphraseProblem(passphrase: string, confirm?: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE) {
    return `Use at least ${MIN_PASSPHRASE} characters. A few unrelated words work well.`;
  }
  if (confirm !== undefined && passphrase !== confirm) return 'The two passphrases differ.';
  return null;
}
