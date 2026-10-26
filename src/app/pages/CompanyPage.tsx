// Company details (CO-1).

import { useEffect, useState } from 'react';
import { normalizeDetails, validateDetails, type CompanyDetails } from '../../shared/company';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { CompanyFields } from '../CompanyFields';
import { ErrorText, formatDateTime, useAction } from '../ui';

type Details = CompanyDetails & { id: string; createdAt: string };

export function CompanyPage({ status }: { status: SessionStatus }) {
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
      <p className="muted">
        Company created {formatDateTime(saved.createdAt)} · id <code>{saved.id}</code>
      </p>
    </section>
  );
}
