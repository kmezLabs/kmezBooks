// Company details (CO-1), the company's theme (CO-11), what invoices show about
// the company (AR-8), changing posted entries (GL-6) and its modules (CO-4).

import { useEffect, useState } from 'react';
import { normalizeDetails, validateDetails, type CompanyDetails } from '../../shared/company';
import { THEME_GROUPS, THEMES, isThemeId, type ThemeId } from '../../shared/themes';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { CompanyFields } from '../CompanyFields';
import { ThemePreview } from '../ThemePreview';
import { Dialog, ErrorText, TextField, formatDateTime, useAction } from '../ui';
import { ModulesSection } from './ModulesSection';

type Details = CompanyDetails & { id: string; createdAt: string };

export function CompanyPage({
  status,
  onModulesChanged,
}: {
  status: SessionStatus;
  onModulesChanged: () => void;
}) {
  const [saved, setSaved] = useState<Details | null>(null);
  const [draft, setDraft] = useState<CompanyDetails | null>(null);
  const [done, setDone] = useState(false);
  const { busy, error, setError, run } = useAction();

  useEffect(() => {
    void db.details().then((d) => {
      setSaved(d);
      setDraft(d);
    });
  }, [status.companyId]);

  if (!saved || !draft) return null;

  const changes = normalizeDetails(
    Object.fromEntries(
      (Object.keys(draft) as (keyof CompanyDetails)[])
        .filter((k) => (draft[k] ?? '') !== (saved[k] ?? ''))
        .map((k) => [k, draft[k]]),
    ) as Partial<CompanyDetails>,
  );
  const changed = Object.keys(changes).length > 0;

  const save = () => {
    const problems = validateDetails(changes);
    if (problems.length) {
      setError(problems.join(' '));
      return;
    }
    void run(async () => {
      await db.updateDetails(changes);
      const d = await db.details();
      setSaved(d);
      setDraft(d);
      setDone(true);
    });
  };

  return (
    <section>
      <h2>Company</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset disabled={status.readOnly}>
          <CompanyFields
            value={draft}
            onChange={(d) => {
              setDone(false);
              setDraft({ ...draft, ...d });
            }}
          />
          <h3>On invoices and estimates</h3>
          <div className="fields">
            <TextField
              label="Email"
              value={draft.email ?? ''}
              onChange={(email) => {
                setDone(false);
                setDraft({ ...draft, email });
              }}
            />
            <TextField
              label="Phone"
              value={draft.phone ?? ''}
              onChange={(phone) => {
                setDone(false);
                setDraft({ ...draft, phone });
              }}
            />
            <TextField
              label="Website"
              value={draft.website ?? ''}
              onChange={(website) => {
                setDone(false);
                setDraft({ ...draft, website });
              }}
            />
          </div>
          <label>
            Footer
            <textarea
              rows={2}
              value={draft.invoiceFooter ?? ''}
              placeholder="How to pay, a thank-you…"
              onChange={(e) => {
                setDone(false);
                setDraft({ ...draft, invoiceFooter: e.target.value });
              }}
            />
            <span className="hint">Printed at the foot of every invoice and estimate</span>
          </label>
        </fieldset>
        <ErrorText>{error}</ErrorText>
        {!status.readOnly && (
          <div className="buttons">
            <button type="submit" disabled={busy || !changed}>
              Save details
            </button>
            {changed && (
              <button type="button" className="secondary" onClick={() => setDraft(saved)}>
                Undo changes
              </button>
            )}
            {done && !changed && <span className="muted">Details updated.</span>}
          </div>
        )}
      </form>
      <ThemeSection status={status} />
      <InvoiceLogo status={status} />
      <PostedEdits status={status} />
      <ModulesSection status={status} onChange={onModulesChanged} />
      <p className="muted">
        Company created {formatDateTime(saved.createdAt)} · id <code>{saved.id}</code>
      </p>
    </section>
  );
}

/**
 * A picture as a small PNG for invoices: at most 600 × 240 pixels, made
 * smaller still until it's under 280 KB (the database allows 300 KB).
 */
async function toSmallPng(file: File): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(file);
  let scale = Math.min(1, 600 / bitmap.width, 240 / bitmap.height);
  for (;;) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('That picture could not be read.'))),
        'image/png',
      ),
    );
    const png = new Uint8Array(await blob.arrayBuffer());
    if (png.byteLength <= 280_000) return png;
    if (scale < 0.05) throw new Error('That picture is too large; try a smaller one.');
    scale *= 0.7;
  }
}

/** The logo on invoices (AR-8): saved as soon as it's chosen. */
function InvoiceLogo({ status }: { status: SessionStatus }) {
  const [url, setUrl] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const { busy, error, run } = useAction();

  useEffect(() => {
    let current: string | null = null;
    void db.companyLogo().then((png) => {
      if (!png) return setUrl(null);
      current = URL.createObjectURL(
        new Blob([png as Uint8Array<ArrayBuffer>], { type: 'image/png' }),
      );
      setUrl(current);
    });
    return () => {
      if (current) URL.revokeObjectURL(current);
    };
  }, [status.companyId, version]);

  return (
    <>
      <h3>Logo</h3>
      <p className="muted">
        Shown at the top of invoices and estimates. Any picture works; it's made small.
      </p>
      {url && <img className="logo-preview" src={url} alt="The company's logo" />}
      {!status.readOnly && (
        <div className="buttons">
          <label className="file-add">
            {url ? 'Change logo…' : 'Add logo…'}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                void run(async () => {
                  await db.setCompanyLogo(await toSmallPng(file));
                  setVersion((v) => v + 1);
                });
              }}
            />
          </label>
          {url && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await db.setCompanyLogo(null);
                  setVersion((v) => v + 1);
                })
              }
            >
              Remove logo
            </button>
          )}
        </div>
      )}
      <ErrorText>{error}</ErrorText>
    </>
  );
}

/**
 * The company's colours (CO-11), saved with it and shown whenever it is open,
 * on any computer. Choosing applies at once; the status brings it back.
 */
function ThemeSection({ status }: { status: SessionStatus }) {
  const { busy, error, run } = useAction();
  const theme = THEMES.find((t) => t.id === status.theme) ?? THEMES[0];
  const choose = (id: ThemeId) => run(() => db.setTheme(id));

  return (
    <>
      <h3>Theme</h3>
      <div className="theme-picker">
        <label>
          Colours for this company
          <select
            value={status.theme}
            disabled={status.readOnly || busy}
            onChange={(e) => {
              if (isThemeId(e.target.value)) void choose(e.target.value);
            }}
          >
            {THEME_GROUPS.map((group) => (
              <optgroup key={group} label={group}>
                {THEMES.filter((t) => t.group === group).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="hint">
            {status.readOnly
              ? 'Open read-only: the theme can be changed when the company is open to edit.'
              : 'Saved with the company, so it looks the same on every computer. Printed reports are always light.'}
          </span>
        </label>
        <div className="theme-sample">
          <ThemePreview theme={theme.id} />
          <span className="muted">{theme.about}</span>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
    </>
  );
}

/** Whether posted transactions can be changed and deleted (GL-6 off), per company. */
function PostedEdits({ status }: { status: SessionStatus }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const { busy, error, run } = useAction();

  useEffect(() => {
    void db.postedEdits().then(setOn);
  }, [status.companyId]);
  if (on === null) return null;

  const set = (value: boolean, pass?: string) =>
    run(async () => {
      await db.setPostedEdits(value, pass);
      setOn(value);
      setAsking(false);
      setPassphrase('');
    });

  return (
    <>
      <h3>Posted transactions</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          disabled={status.readOnly || busy}
          onChange={(e) => (e.target.checked ? setAsking(true) : void set(false))}
        />
        <span>
          Allow changing and deleting posted transactions
          <span className="hint">
            Off (the accountant’s way): a posted transaction is corrected by voiding it and entering
            the corrected copy, which the Edit buttons do for you. On: Edit changes it in place and
            Delete removes it. Either way the audit log keeps every version, closed periods still
            need your passphrase, and reconciled transactions and QuickBooks history can’t be
            deleted.
          </span>
        </span>
      </label>
      <ErrorText>{asking ? null : error}</ErrorText>
      {asking && (
        <Dialog
          title="Allow changing posted transactions"
          onClose={busy ? undefined : () => setAsking(false)}
        >
          <p>
            Enter your passphrase to allow changing and deleting posted transactions in this
            company.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void set(true, passphrase);
            }}
          >
            <TextField
              label="Passphrase"
              type="password"
              value={passphrase}
              onChange={setPassphrase}
              autoFocus
            />
            <ErrorText>{error}</ErrorText>
            <div className="buttons">
              <button type="submit" disabled={busy || !passphrase}>
                Allow
              </button>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setAsking(false)}
              >
                Cancel
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}
