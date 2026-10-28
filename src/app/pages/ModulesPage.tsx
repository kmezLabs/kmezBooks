// Feature modules per company (CO-4).

import { useEffect, useState } from 'react';
import { MODULES, type Module } from '../../shared/company';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { ErrorText, useAction } from '../ui';

const LABELS: Record<Module, { name: string; about: string; note: string | null }> = {
  sales: {
    name: 'Customers and sales',
    about:
      'Invoices, estimates, products & services, and customer payments (Sales in the sidebar). Payments count as income when they arrive (cash basis)',
    note: null,
  },
  bills: {
    name: 'Vendors and bills',
    about: 'Bills and bill payments',
    note: 'not built yet: added when a company needs bills; vendors are on the Payees page',
  },
  expenses: {
    name: 'Expenses',
    about: 'Expenses and checks paid straight from a bank or card, with splits and receipts',
    note: 'Add Transaction on the Transactions page, always available',
  },
  banking: {
    name: 'Banking',
    about: 'Statement import, review, rules, reconciliation (Banking in the sidebar)',
    note: null,
  },
  migration: {
    name: 'QuickBooks migration',
    about: 'Import history from QuickBooks Online (QuickBooks import in the sidebar)',
    note: null,
  },
};

export function ModulesPage({ status }: { status: SessionStatus }) {
  const [modules, setModules] = useState<Record<Module, boolean> | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    void db.modules().then(setModules);
  }, [status.companyId]);

  if (!modules) return null;

  const toggle = (m: Module, on: boolean) =>
    run(async () => {
      await db.setModule(m, on);
      setModules(await db.modules());
    });

  return (
    <section>
      <h2>Modules</h2>
      <p className="muted">
        The ledger, period close and reports are always on. Turning a module off hides its screens
        for this company; its data stays.
      </p>
      <ul className="module-list">
        {MODULES.map((m) => (
          <li key={m}>
            <label className="check">
              <input
                type="checkbox"
                checked={modules[m]}
                disabled={busy || status.readOnly}
                onChange={(e) => toggle(m, e.target.checked)}
              />
              <span>
                <strong>{LABELS[m].name}</strong>
                <span className="muted">
                  {' '}
                  — {LABELS[m].about}
                  {LABELS[m].note && ` (${LABELS[m].note})`}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorText>{error}</ErrorText>
    </section>
  );
}
