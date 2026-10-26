// Small pieces shared by the ledger pages: account picker, money input,
// closed-period override prompt, dates.

import { useState } from 'react';
import { TYPE_LABELS, ACCOUNT_TYPES, isDebitNormal, type AccountRow } from '../shared/accounts';
import { formatMoney, parseMoney, type Cents } from '../shared/money';
import { errorName } from '../shared/workerClient';
import { Dialog, ErrorText, TextField, useAction } from './ui';

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' });
/** "2026-03-01" → "Mar 1, 2026", without shifting the day across time zones. */
export function formatDate(iso: string | null): string {
  return iso ? dateFormat.format(new Date(`${iso}T00:00:00Z`)) : '—';
}

/** A balance shown the way an accountant reads it: positive on the account's normal side. */
export function displayBalance(a: Pick<AccountRow, 'type' | 'balance'>): string {
  return formatMoney(isDebitNormal(a.type) ? a.balance : -a.balance);
}

export function AccountSelect(props: {
  accounts: AccountRow[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  /** Accounts that can't be chosen, e.g. an account and its sub-accounts as its own parent. */
  exclude?: Set<string>;
  onlyType?: AccountRow['type'];
  emptyLabel?: string;
}) {
  const types = props.onlyType ? [props.onlyType] : ACCOUNT_TYPES;
  const select = (
    <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
      <option value="">{props.emptyLabel ?? 'Choose an account…'}</option>
      {types.map((type) => (
        <optgroup key={type} label={TYPE_LABELS[type]}>
          {props.accounts
            .filter(
              (a) =>
                a.type === type && (a.active || a.id === props.value) && !props.exclude?.has(a.id),
            )
            .map((a) => (
              <option key={a.id} value={a.id}>
                {' '.repeat(a.depth)}
                {a.number ? `${a.number} ` : ''}
                {a.name}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
  return props.label ? (
    <label>
      {props.label}
      {select}
    </label>
  ) : (
    select
  );
}

/** A money field: free typing, tidied to 1,234.56 when it loses focus. */
export function MoneyInput(props: {
  value: string;
  onChange: (text: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const invalid = props.value.trim() !== '' && parseMoney(props.value) === null;
  return (
    <input
      className={invalid ? 'money invalid' : 'money'}
      inputMode="decimal"
      aria-label={props.ariaLabel}
      aria-invalid={invalid}
      value={props.value}
      placeholder={props.placeholder}
      onChange={(e) => props.onChange(e.target.value)}
      onBlur={() => {
        const cents = parseMoney(props.value);
        if (cents !== null && props.value.trim() !== '')
          props.onChange(cents === 0 ? '' : formatMoney(cents));
      }}
    />
  );
}

export const cents = (text: string): Cents => parseMoney(text) ?? 0;

/**
 * Run a ledger change; if it lands in a closed period, ask for the passphrase
 * and run it again with the override (PC-2).
 */
export function useClosedPeriodOverride() {
  const [pending, setPending] = useState<((passphrase: string) => Promise<unknown>) | null>(null);
  const { busy, error, setError, run } = useAction();

  const attempt = (fn: (passphrase?: string) => Promise<unknown>) =>
    run(async () => {
      try {
        await fn();
      } catch (e) {
        if (errorName(e) === 'ClosedPeriodError') {
          setPending(() => (passphrase: string) => fn(passphrase));
          return;
        }
        throw e;
      }
    });

  const dialog = pending && (
    <OverrideDialog
      onCancel={() => setPending(null)}
      onConfirm={async (passphrase) => {
        await pending(passphrase);
        setPending(null);
      }}
    />
  );
  return { attempt, busy, error, setError, dialog };
}

function OverrideDialog(props: {
  onCancel: () => void;
  onConfirm: (passphrase: string) => Promise<void>;
}) {
  const [passphrase, setPassphrase] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Dialog title="This date is in a closed period" onClose={busy ? undefined : props.onCancel}>
      <p>
        The books are closed up to the closing date, so changes on or before it are blocked. Enter
        your passphrase to make this one change anyway. It will be recorded in the audit log.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => props.onConfirm(passphrase));
        }}
      >
        <TextField
          label="Passphrase"
          type="password"
          value={passphrase}
          onChange={setPassphrase}
          autoFocus
          autoComplete="current-password"
        />
        <ErrorText>{error}</ErrorText>
        <div className="buttons">
          <button type="submit" disabled={busy || !passphrase}>
            Make the change
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  );
}
