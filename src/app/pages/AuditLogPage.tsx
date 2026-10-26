// Audit log (US-5): every change, unlock, lock and restore, newest first.

import { Fragment, useEffect, useState } from 'react';
import type { AuditEvent } from '../../worker/companyData';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { formatDateTime } from '../ui';

const PAGE = 100;

const ACTIONS: Record<string, string> = {
  insert: 'Added',
  update: 'Changed',
  delete: 'Removed',
  create_company: 'Created the company',
  unlock: 'Unlocked',
  lock: 'Locked',
  restore: 'Restored a backup',
  schema_upgrade: 'Upgraded the company file',
  passphrase_change: 'Changed the passphrase',
};

/** For an update, just the fields that changed. */
function changes(e: AuditEvent): [string, unknown, unknown][] {
  const before = e.before ? (JSON.parse(e.before) as Record<string, unknown>) : {};
  const after = e.after ? (JSON.parse(e.after) as Record<string, unknown>) : {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys
    .filter((k) => e.action !== 'update' || JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => [k, before[k], after[k]]);
}

const show = (v: unknown) => (v === undefined ? '' : v === null ? '—' : String(v));

export function AuditLogPage({ status }: { status: SessionStatus }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    void db.audit({ limit: PAGE }).then((page) => {
      setEvents(page);
      setMore(page.length === PAGE);
    });
  }, [status.companyId, status.lastSavedAt]);

  const loadMore = async () => {
    const page = await db.audit({ limit: PAGE, beforeId: events.at(-1)?.id });
    setEvents([...events, ...page]);
    setMore(page.length === PAGE);
  };

  return (
    <section>
      <h2>Audit log</h2>
      <p className="muted">Every change to this company, newest first. The log can't be edited.</p>
      <table className="list">
        <thead>
          <tr>
            <th>When</th>
            <th>Who</th>
            <th>What</th>
            <th>Record</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <Fragment key={e.id}>
              <tr
                className={e.entity ? 'clickable' : undefined}
                onClick={() => e.entity && setOpen(open === e.id ? null : e.id)}
              >
                <td>{formatDateTime(e.at)}</td>
                <td>{e.user ?? '—'}</td>
                <td>
                  {ACTIONS[e.action] ?? e.action}
                  {e.note && <span className="muted"> · {e.note}</span>}
                </td>
                <td>{e.entity && <code>{e.entity}</code>}</td>
              </tr>
              {open === e.id && (
                <tr className="detail">
                  <td colSpan={4}>
                    <table>
                      <thead>
                        <tr>
                          <th>Field</th>
                          <th>Before</th>
                          <th>After</th>
                        </tr>
                      </thead>
                      <tbody>
                        {changes(e).map(([k, b, a]) => (
                          <tr key={k}>
                            <td>
                              <code>{k}</code>
                            </td>
                            <td>{show(b)}</td>
                            <td>{show(a)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {more && (
        <div className="buttons">
          <button className="secondary" onClick={loadMore}>
            Show older
          </button>
        </div>
      )}
    </section>
  );
}
