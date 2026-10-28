// Company details, modules, owner, session and audit-log reads (CO-1, CO-4,
// US-1, US-3, US-5). Plain functions over the open database.

import {
  MODULES,
  normalizeDetails,
  validateDetails,
  type CompanyDetails,
  type Module,
  type NewCompany,
} from '../shared/company';
import { seedDefaultChart } from '../ledger/accounts';
import { recordEvent } from './audit';
import type { Database } from './sqlite';

export { MODULES, type CompanyDetails, type Module, type NewCompany };

const COLUMNS: Record<keyof CompanyDetails, string> = {
  legalName: 'legal_name',
  ein: 'ein',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  state: 'state',
  postalCode: 'postal_code',
  fiscalYearStartMonth: 'fiscal_year_start_month',
  email: 'email',
  phone: 'phone',
  website: 'website',
  invoiceFooter: 'invoice_footer',
};

export function readDetails(db: Database): CompanyDetails & { id: string; createdAt: string } {
  const row = db.selectObjects('SELECT * FROM company')[0];
  if (!row) throw new Error('The company row is missing.');
  const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    legalName: String(row.legal_name),
    ein: text(row.ein),
    addressLine1: text(row.address_line1),
    addressLine2: text(row.address_line2),
    city: text(row.city),
    state: text(row.state),
    postalCode: text(row.postal_code),
    fiscalYearStartMonth: Number(row.fiscal_year_start_month),
    email: text(row.email),
    phone: text(row.phone),
    website: text(row.website),
    invoiceFooter: text(row.invoice_footer),
  };
}

/** The company's logo, a PNG, for invoices (AR-8); null without one. */
export function readLogo(db: Database): Uint8Array | null {
  const png = db.selectValue('SELECT png FROM company_logo');
  return png instanceof Uint8Array ? png : null;
}

/** Store the logo (a PNG made small in the browser), or remove it with null. */
export function writeLogo(db: Database, png: Uint8Array | null): void {
  if (!png) {
    db.exec('DELETE FROM company_logo');
    return;
  }
  db.exec({
    sql: `INSERT INTO company_logo (company_id, png) VALUES ((SELECT id FROM company), ?)
          ON CONFLICT (company_id) DO UPDATE SET png = excluded.png,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    bind: [png],
  });
}

export function updateDetails(db: Database, changes: Partial<CompanyDetails>): void {
  const d = normalizeDetails(changes);
  const problems = validateDetails(d);
  if (problems.length) throw new Error(problems.join(' '));
  const keys = (Object.keys(d) as (keyof CompanyDetails)[]).filter((k) => k in COLUMNS);
  if (keys.length === 0) return;
  db.exec({
    sql: `UPDATE company SET ${keys.map((k) => `${COLUMNS[k]} = ?`).join(', ')}`,
    bind: keys.map((k) => d[k] ?? null),
  });
}

export function readModules(db: Database): Record<Module, boolean> {
  const rows = db.selectArrays('SELECT module, enabled FROM company_module');
  const out = Object.fromEntries(MODULES.map((m) => [m, false])) as Record<Module, boolean>;
  for (const [module, enabled] of rows) out[module as Module] = enabled === 1;
  return out;
}

export function setModule(db: Database, module: Module, enabled: boolean): void {
  db.exec({
    sql: `INSERT INTO company_module (company_id, module, enabled) VALUES ((SELECT id FROM company), ?, ?)
          ON CONFLICT (company_id, module) DO UPDATE SET enabled = excluded.enabled`,
    bind: [module, enabled ? 1 : 0],
  });
}

export function owner(db: Database): { id: string; name: string } | null {
  const row = db.selectObjects(`SELECT id, name FROM app_user WHERE role = 'owner'`)[0];
  return row ? { id: String(row.id), name: String(row.name) } : null;
}

/** A brand-new company: session, company, owner and modules in one transaction (CO-1). */
export function initCompany(
  db: Database,
  ids: { companyId: string; ownerId: string },
  details: NewCompany,
  now: Date,
): void {
  const d = normalizeDetails(details);
  const problems = validateDetails(d);
  if (!details.ownerName?.trim()) problems.push("Enter the owner's name.");
  if (problems.length) throw new Error(problems.join(' '));
  db.exec('BEGIN');
  try {
    // The session row comes first so every audit row, even the company's own, names the owner
    db.exec({
      sql: 'INSERT INTO session (id, company_id, user_id, unlocked_at) VALUES (1, ?, ?, ?)',
      bind: [ids.companyId, ids.ownerId, now.toISOString()],
    });
    db.exec({
      sql: `INSERT INTO company (id, legal_name, ein, address_line1, address_line2, city, state, postal_code, fiscal_year_start_month)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bind: [
        ids.companyId,
        d.legalName,
        d.ein,
        d.addressLine1,
        d.addressLine2,
        d.city,
        d.state,
        d.postalCode,
        d.fiscalYearStartMonth,
      ],
    });
    db.exec({
      sql: `INSERT INTO app_user (id, company_id, name, role) VALUES (?, ?, ?, 'owner')`,
      bind: [ids.ownerId, ids.companyId, details.ownerName.trim()],
    });
    // Invoices and bills are opted into per company (CO-4); the rest start on
    for (const m of MODULES) setModule(db, m, m !== 'sales' && m !== 'bills');
    // GL-2: the standard chart, unless the company will be filled by the QuickBooks import
    if (details.standardChart ?? true) seedDefaultChart(db);
    recordEvent(db, 'create_company');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Point the session row at the owner (the only user in the MVP). Companies
 * created by the M1 test screen have no owner yet; they get one here.
 */
export function startSession(db: Database, now: Date): { id: string; name: string } {
  db.exec('BEGIN');
  try {
    let user = owner(db);
    // Older files: fill in the owner before the session row points at them
    const ownerId = user?.id ?? crypto.randomUUID();
    db.exec({
      sql: `INSERT INTO session (id, company_id, user_id, unlocked_at) VALUES (1, (SELECT id FROM company), ?, ?)
            ON CONFLICT (id) DO UPDATE SET company_id = excluded.company_id, user_id = excluded.user_id, unlocked_at = excluded.unlocked_at, closing_override = 0`,
      bind: [ownerId, now.toISOString()],
    });
    if (!user) {
      db.exec({
        sql: `INSERT INTO app_user (id, company_id, name, role) VALUES (?, (SELECT id FROM company), 'Owner', 'owner')`,
        bind: [ownerId],
      });
      user = { id: ownerId, name: 'Owner' };
    }
    db.exec('COMMIT');
    return user;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export interface AuditEvent {
  id: number;
  at: string;
  user: string | null;
  action: string;
  entity: string | null;
  entityId: string | null;
  before: string | null;
  after: string | null;
  note: string | null;
}

/** Newest first, a page at a time (US-5). */
export function readAuditEvents(
  db: Database,
  opts: { limit?: number; beforeId?: number; entity?: string } = {},
): AuditEvent[] {
  const where: string[] = [];
  const bind: (string | number)[] = [];
  if (opts.beforeId) {
    where.push('e.id < ?');
    bind.push(opts.beforeId);
  }
  if (opts.entity) {
    where.push('e.entity = ?');
    bind.push(opts.entity);
  }
  bind.push(Math.min(opts.limit ?? 100, 500));
  return db
    .selectObjects(
      `SELECT e.id, e.at, u.name AS user, e.action, e.entity, e.entity_id, e.before, e.after, e.note
       FROM audit_event e LEFT JOIN app_user u ON u.id = e.user_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY e.id DESC LIMIT ?`,
      bind,
    )
    .map((r) => ({
      id: Number(r.id),
      at: String(r.at),
      user: r.user === null ? null : String(r.user),
      action: String(r.action),
      entity: r.entity === null ? null : String(r.entity),
      entityId: r.entity_id === null ? null : String(r.entity_id),
      before: r.before === null ? null : String(r.before),
      after: r.after === null ? null : String(r.after),
      note: r.note === null ? null : String(r.note),
    }));
}

/** Time of the latest recorded activity; shown when previewing a backup (DF-10). */
export function latestActivity(db: Database): string | null {
  const v = db.selectValue('SELECT max(at) FROM audit_event');
  return v === null || v === undefined ? null : String(v);
}
