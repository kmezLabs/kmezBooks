// Everything about the one open company beyond the file itself: autosave
// (DF-2), the on-disk lock and its heartbeat (DF-4), backups and restore
// (DF-9, DF-10), read-only opening, and closing. Runs in the worker; the
// browser-only pieces (Web Locks, timers, clock) are passed in so the whole
// flow can be tested in Node.

import {
  createAccount,
  deleteAccount,
  listAccounts,
  seedDefaultChart,
  setAccountActive,
  updateAccount,
} from '../ledger/accounts';
import { trialBalance, type TrialBalance } from '../ledger/balances';
import {
  getEntry,
  listEntries,
  type EntryDetail,
  type EntryQuery,
  type EntrySummary,
} from '../ledger/entries';
import { emitLedgerEvent, type LedgerEventDetail } from '../ledger/events';
import {
  changeEntry,
  correctEntry,
  deleteEntry,
  isIsoDate,
  postEntry,
  voidEntry,
  type EntryChange,
  type EntryInput,
} from '../ledger/postEntry';
import {
  convertEstimate,
  createDoc,
  customerBalances,
  deleteDoc,
  getDoc,
  listDocs,
  markSent,
  nextNumber,
  setEstimateStatus,
  updateDoc,
  voidDoc,
  type CustomerBalance,
  type Doc,
  type DocInput,
  type DocKind,
  type DocQuery,
} from '../modules/sales/documents';
import {
  createItem,
  listItems,
  updateItem,
  type Item,
  type ItemInput,
} from '../modules/sales/items';
import { formatMoney } from '../shared/money';
import { longDate, renderDocPdf } from '../modules/sales/invoicePdf';
import {
  listPayments,
  receivePayment,
  voidPayment,
  type Payment,
  type PaymentInput,
} from '../modules/sales/payments';
import {
  billsDue,
  createBill,
  deleteBill,
  getBill,
  listBills,
  updateBill,
  voidBill,
  type Bill,
  type BillInput,
  type BillQuery,
  type BillsDue,
} from '../modules/bills/bills';
import {
  listBillPayments,
  payBills,
  voidBillPayment,
  type BillPayment,
  type BillPaymentInput,
} from '../modules/bills/billPayments';
import {
  createRecurring,
  deleteRecurring,
  getRecurring,
  listRecurring,
  postDue,
  postNow,
  setRecurringActive,
  skipNext,
  updateRecurring,
  type Recurring,
  type RecurringInput,
  type RecurringResult,
} from '../ledger/recurring';
import {
  createDue,
  createNow,
  createRecurringInvoice,
  deleteRecurringInvoice,
  getRecurringInvoice,
  listRecurringInvoices,
  setRecurringInvoiceActive,
  skipNextInvoice,
  updateRecurringInvoice,
  type RecurringInvoice,
  type RecurringInvoiceInput,
  type RecurringInvoiceResult,
} from '../modules/sales/recurringInvoices';
import {
  createPayee,
  defaultCategoryFor,
  deletePayee,
  getPayee,
  listPayees,
  mergePayee,
  payeeNames,
  updatePayee,
  type Payee,
  type PayeeInput,
  type PayeeKind,
} from '../ledger/payees';
import {
  register,
  simpleToEntry,
  moneyAccounts,
  type MoneyAccount,
  type RegisterKind,
  type RegisterQuery,
  type RegisterResult,
  type SimpleEntry,
} from '../ledger/register';
import { runReport } from '../ledger/reports';
import { analyze, type Analysis, type AnalysisSummary } from '../modules/migration/analysis';
import {
  proposeChoices,
  runImport,
  type AccountChoices,
  type ImportResult,
} from '../modules/migration/importer';
import { readExportFolder, readPickedFiles } from '../modules/migration/sources';
import { bankAccounts, type BankAccount } from '../modules/banking/bankAccounts';
import {
  cancelReconciliation,
  entryReconciliations,
  finishReconciliation,
  reconcileState,
  reconciliationHistory,
  reconciliationReport,
  setAllCleared,
  setCleared,
  startReconciliation,
  updateReconciliation,
  type ReconcileState,
  type ReconciliationReport,
  type ReconciliationSummary,
} from '../modules/banking/reconcile';
import {
  acceptSuggestions,
  BANK_SOURCE,
  categorize,
  exclude,
  listQueue,
  match,
  matchByBankText,
  restore,
  transfer,
  undo,
  type CategorizeInput,
  type QueueItem,
  type QueueView,
} from '../modules/banking/review';
import {
  createRule,
  deleteRule,
  listRules,
  moveRule,
  updateRule,
  type RuleInput,
  type RuleRow,
} from '../modules/banking/rules';
import {
  importStatements,
  listImports,
  previewStatements,
  readStatements,
  undoImport,
  type FileProblem,
  type ImportRow,
  type PendingStatement,
  type StatementImportResult,
  type StatementPreview,
} from '../modules/banking/statements';
import type { Cents } from '../shared/money';
import type { Report, ReportRequest } from '../shared/report';
import type { AccountInput, AccountRow } from '../shared/accounts';
import {
  ATTACHMENT_DIR,
  addAttachment,
  listAttachments,
  openAttachment,
  removeAttachment,
  type AttachmentRow,
} from './attachments';
import { recordEvent } from './audit';
import {
  backupDue,
  backupOverdue,
  companyBackupDir,
  defaultBackupDir,
  listBackups,
  pruneBackups,
  readBackup,
  writeBackup,
  type BackupFile,
} from './backups';
import type { BackupCheck } from './backupDrill';
import { OpenCompany, type BackupPreview, type Timings } from './company';
import {
  owner,
  readAuditEvents,
  readDetails,
  writeLogo,
  readLogo,
  readModules,
  setModule,
  updateDetails,
  type AuditEvent,
  type CompanyDetails,
  type Module,
  type NewCompany,
} from './companyData';
import { readCompanyFile, writeCompanyFile } from './companyFolder';
import { exportArchive, safeName, type ExportFile } from './exportCompany';
import { serializeDatabase } from './sqlite';
import {
  CompanyLockedError,
  fromFolderAccess,
  LedgerRuleError,
  NoCompanyOpenError,
  OpenInAnotherTabError,
  ReadOnlyError,
  WrongCompanyError,
  WrongPassphraseError,
} from './errors';
import { HEARTBEAT_MS, checkLock, releaseLock, writeLock, type LockInfo } from './lockFile';

/** The local calendar date, as YYYY-MM-DD. */
function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface SessionStatus {
  open: boolean;
  companyId: string | null;
  legalName: string | null;
  readOnly: boolean;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: string | null;
  latestBackupAt: string | null;
  backupOverdue: boolean;
  /** Recurring entries posted or waiting when the company was opened (GL-5), until dismissed */
  recurring: RecurringResult | null;
  /** Recurring invoices made or waiting when the company was opened (AR-9), until dismissed */
  recurringInvoices: RecurringInvoiceResult | null;
  error: { name: string; message: string } | null;
}

export interface SessionDeps {
  now?: () => Date;
  /** Web Locks, to stop the same company opening in two tabs; absent in tests. */
  locks?: LockManager | null;
  saveDelayMs?: number;
  /** 0 turns the heartbeat off (tests). */
  heartbeatMs?: number;
  /** PBKDF2 iterations for new keys; tests pass a low number. */
  iterations?: number;
  onStatus?: (status: SessionStatus) => void;
}

/** source_type of entries added from the transactions register (GL-9) */
export const REGISTER_SOURCE = 'register';

export type OpenMode = 'edit' | 'readOnly' | 'takeOver';

/** What the dry-run screen shows before the owner imports (MG-4). */
export interface MigrationPlan {
  summary: AnalysisSummary;
  /** The proposed target for each QuickBooks account */
  choices: AccountChoices;
  /** The company already has transactions, so it can't take an import (MG-6) */
  companyHasTransactions: boolean;
}

/** An entry as the journal shows it: attachments, and where it was reconciled (BK-8). */
export interface EntryView extends EntryDetail {
  files: AttachmentRow[];
  reconciled: { account: string; statementDate: string }[];
}

export type OpenOutcome =
  | { kind: 'opened'; status: SessionStatus; upgradedFrom: number | null; timings: Timings }
  | { kind: 'locked'; lock: LockInfo; stale: boolean };

const errorInfo = (e: unknown) =>
  e instanceof Error ? { name: e.name, message: e.message } : { name: 'Error', message: String(e) };

async function acquireTabLock(locks: LockManager, name: string): Promise<(() => void) | null> {
  return new Promise((resolve) => {
    void locks.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      // Hold the lock until the returned release function is called
      return new Promise<void>((release) => resolve(release));
    });
  });
}

export class CompanySession {
  private company: OpenCompany | undefined;
  private sessionId = '';
  private device = '';
  private openedAt = '';
  private customBackupDir: FileSystemDirectoryHandle | null = null;
  private latestBackup: Date | null = null;
  private lastSavedAt: Date | null = null;
  private saving = false;
  private lockLost = false;
  private recurringNotice: RecurringResult | null = null;
  private invoiceNotice: RecurringInvoiceResult | null = null;
  private error: SessionStatus['error'] = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private releaseTabLock: (() => void) | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  /** QuickBooks exports read for the migration, kept between dry run and import */
  private migration: Analysis | null = null;
  /** Statements read for import, kept until the owner confirms their accounts (BK-1) */
  private bankPending: PendingStatement[] | null = null;
  private readonly now: () => Date;
  private readonly saveDelayMs: number;
  private readonly heartbeatMs: number;

  constructor(private readonly deps: SessionDeps = {}) {
    this.now = deps.now ?? (() => new Date());
    this.saveDelayMs = deps.saveDelayMs ?? 2_000;
    this.heartbeatMs = deps.heartbeatMs ?? HEARTBEAT_MS;
  }

  // ---- status ----

  status(): SessionStatus {
    const c = this.company;
    return {
      open: !!c,
      companyId: c ? c.id : null,
      legalName: c ? readDetails(c.db).legalName : null,
      readOnly: c ? c.readOnly || this.lockLost : false,
      dirty: c ? c.dirty : false,
      saving: this.saving,
      lastSavedAt: this.lastSavedAt?.toISOString() ?? null,
      latestBackupAt: this.latestBackup?.toISOString() ?? null,
      backupOverdue: c && !c.readOnly ? backupOverdue(this.latestBackup, this.now()) : false,
      recurring: c ? this.recurringNotice : null,
      recurringInvoices: c ? this.invoiceNotice : null,
      error: this.error,
    };
  }

  private quiet = 0;

  private emit() {
    if (this.quiet === 0) this.deps.onStatus?.(this.status());
  }

  /**
   * Run a close-and-reopen without reporting the moment in between, so the UI
   * doesn't flash back to the start screen. One status report at the end.
   */
  private async withoutFlicker<T>(fn: () => Promise<T>): Promise<T> {
    this.quiet++;
    try {
      return await fn();
    } finally {
      this.quiet--;
      this.emit();
    }
  }

  private open_(): OpenCompany {
    if (!this.company) throw new NoCompanyOpenError('No company is open.');
    return this.company;
  }

  private writable(): OpenCompany {
    const c = this.open_();
    if (c.readOnly || this.lockLost) throw new ReadOnlyError('This company is open read-only.');
    return c;
  }

  // ---- opening and creating ----

  async create(
    dir: FileSystemDirectoryHandle,
    details: NewCompany,
    passphrase: string,
    device: string,
  ): Promise<{ status: SessionStatus; timings: Timings }> {
    await this.close();
    const { company, timings } = await OpenCompany.create(
      dir,
      details,
      passphrase,
      this.deps.iterations,
    );
    await this.attach(company, device);
    // The first save just happened inside create; give the new company its first backup now
    await this.backupCurrentFile();
    this.emit();
    return { status: this.status(), timings };
  }

  async open(
    dir: FileSystemDirectoryHandle,
    passphrase: string,
    opts: { device: string; mode?: OpenMode },
  ): Promise<OpenOutcome> {
    const mode = opts.mode ?? 'edit';
    await this.close();
    const sessionId = crypto.randomUUID();
    if (mode !== 'readOnly') {
      const state = await checkLock(dir, sessionId, this.now().getTime());
      // A fresh lock means someone is working right now: never take that over
      if (state.kind === 'held' && (!state.stale || mode !== 'takeOver')) {
        return { kind: 'locked', lock: state.lock, stale: state.stale };
      }
    }
    const backupDir = this.customBackupDir ?? (await defaultBackupDir(dir));
    const { company, timings, upgradedFrom } = await OpenCompany.open(dir, passphrase, {
      readOnly: mode === 'readOnly',
      device: opts.device,
      beforeUpgrade: async (file, from) => {
        await writeBackup(backupDir, file, this.now(), `before-upgrade-v${from}`);
      },
    });
    await this.attach(company, opts.device, sessionId);
    // Nothing runs while the app is closed: what came due since posts now (GL-5)
    if (!company.readOnly) {
      this.postDueRecurring();
      this.createDueInvoices();
    }
    return { kind: 'opened', status: this.status(), upgradedFrom, timings };
  }

  private async attach(company: OpenCompany, device: string, sessionId = crypto.randomUUID()) {
    if (!company.readOnly && this.deps.locks) {
      const release = await acquireTabLock(this.deps.locks, `easybooks-company-${company.id}`);
      if (!release) {
        company.close();
        throw new OpenInAnotherTabError(
          'This company is already open in another EasyBooks tab or window. Switch to it, or close it there first.',
        );
      }
      this.releaseTabLock = release;
    }
    this.company = company;
    this.sessionId = sessionId;
    this.device = device;
    this.openedAt = this.now().toISOString();
    this.lockLost = false;
    this.error = null;
    this.lastSavedAt = null;
    this.latestBackup =
      (await listBackups(await this.backupDir())).find((b) => !b.label)?.at ?? null;
    if (!company.readOnly) {
      await this.writeOurLock();
      if (this.heartbeatMs > 0) {
        this.heartbeat = setInterval(() => void this.beat(), this.heartbeatMs);
      }
      if (company.dirty) this.scheduleSave();
    }
    this.emit();
  }

  private async writeOurLock() {
    const c = this.open_();
    await writeLock(c.dir, {
      sessionId: this.sessionId,
      device: this.device,
      user: owner(c.db)?.name ?? 'Owner',
      openedAt: this.openedAt,
      heartbeatAt: this.now().toISOString(),
    });
  }

  /** Refresh our lock; if another device has taken the company over, stop writing (DF-4). */
  private async beat() {
    const c = this.company;
    if (!c || c.readOnly || this.lockLost) return;
    try {
      const state = await checkLock(c.dir, this.sessionId, this.now().getTime());
      if (state.kind === 'held') {
        this.lockLost = true;
        clearTimeout(this.saveTimer);
        this.error = errorInfo(
          new CompanyLockedError(
            `${state.lock.device} has taken over this company, so your changes can't be saved here. Save them as a copy.`,
          ),
        );
        this.emit();
        return;
      }
      await this.writeOurLock();
      if (this.error?.name === 'FolderAccessError') {
        this.error = null;
        this.emit();
      }
    } catch (e) {
      this.error = errorInfo(fromFolderAccess(e, c.dir.name));
      this.emit();
    }
  }

  /** The company folder, so the page can ask Chrome for access to it again. */
  folder(): FileSystemDirectoryHandle {
    return this.open_().dir;
  }

  /**
   * Call once the page has regained write access to the folder: refresh the
   * lock and save what is waiting. A failure shows as the session's error again.
   */
  async folderAccessRegained(): Promise<void> {
    await this.beat();
    if (this.error?.name !== 'FolderAccessError') await this.save();
  }

  // ---- saving ----

  /** Call after every change the UI makes, so the autosave picks it up (DF-2). */
  touch(): void {
    this.emit();
    this.scheduleSave();
  }

  private scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save().catch(() => {}), this.saveDelayMs);
  }

  /** Save now if there is anything to save. Saves never overlap. */
  save(): Promise<void> {
    const run = this.saveQueue.then(() => this.saveOnce());
    this.saveQueue = run.catch(() => {});
    return run;
  }

  private async saveOnce() {
    clearTimeout(this.saveTimer);
    const c = this.company;
    if (!c || c.readOnly || !c.dirty) return;
    if (this.lockLost) {
      throw new CompanyLockedError(
        'Another device has taken over this company. Save your changes as a copy.',
      );
    }
    this.saving = true;
    this.emit();
    try {
      const result = await c.save();
      this.lastSavedAt = this.now();
      this.error = null;
      if (backupDue(this.latestBackup, this.now())) {
        try {
          await this.writeBackupBytes(result.file);
        } catch (e) {
          this.error = {
            name: 'BackupFailedError',
            message: `Saved, but the backup failed: ${errorInfo(e).message}`,
          };
        }
      }
    } catch (e) {
      const err = fromFolderAccess(e, c.dir.name);
      this.error = errorInfo(err);
      throw err;
    } finally {
      this.saving = false;
      this.emit();
    }
  }

  // ---- backups (DF-9, DF-10) ----

  /**
   * Where this company's backups go: its own folder inside the folder the
   * owner chose, or backups/ in the company folder.
   */
  private async backupDir(): Promise<FileSystemDirectoryHandle> {
    const c = this.open_();
    return this.customBackupDir
      ? companyBackupDir(this.customBackupDir, c.id, readDetails(c.db).legalName)
      : defaultBackupDir(c.dir);
  }

  private async writeBackupBytes(bytes: Uint8Array<ArrayBuffer>, label?: string) {
    const dir = await this.backupDir();
    await writeBackup(dir, bytes, this.now(), label);
    if (!label) this.latestBackup = this.now();
    await pruneBackups(dir);
  }

  /** Back up the company file as it is on disk now. */
  private async backupCurrentFile(label?: string) {
    const { bytes } = await readCompanyFile(this.open_().dir);
    await this.writeBackupBytes(bytes, label);
  }

  // ---- export (Portability, M8) ----

  /** Everything in the company, unencrypted, as a .zip; recorded in the audit log. */
  async exportData(): Promise<{ fileName: string; bytes: Uint8Array }> {
    const c = this.open_();
    const files: ExportFile[] = [];
    const missing: string[] = [];
    const used = new Set<string>();
    const rows = c.db.selectObjects(
      `SELECT id, entity, entity_id, file_name FROM attachment ORDER BY added_at, id`,
    );
    for (const r of rows) {
      try {
        const a = await openAttachment(c, String(r.id));
        const folder = `attachments/${safeName(`${String(r.entity)} ${String(r.entity_id)}`)}`;
        let path = `${folder}/${safeName(a.fileName)}`;
        for (let n = 2; used.has(path.toLowerCase()); n++) {
          path = `${folder}/${n} ${safeName(a.fileName)}`;
        }
        used.add(path.toLowerCase());
        files.push({ path, bytes: a.bytes });
      } catch (e) {
        missing.push(
          `${String(r.file_name)} (${String(r.entity)} ${String(r.entity_id)}): ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    const company = readDetails(c.db).legalName;
    const exportedAt = new Date().toISOString();
    if (!c.readOnly && !this.lockLost) {
      recordEvent(c.db, 'export', `all data, ${files.length} attachments`);
      this.touch();
    }
    const bytes = exportArchive(c.db, files, missing, {
      company,
      exportedAt,
      schema: Number(c.db.selectValue('PRAGMA user_version')),
    });
    return { fileName: `${safeName(company)} export ${localDate(this.now())}.zip`, bytes };
  }

  /** The company database, decrypted, as a SQLite file; recorded in the audit log. */
  sqliteCopy(): { fileName: string; bytes: Uint8Array } {
    const c = this.open_();
    if (!c.readOnly && !this.lockLost) {
      recordEvent(c.db, 'export', 'decrypted database copy');
      this.touch();
    }
    const company = readDetails(c.db).legalName;
    return {
      fileName: `${safeName(company)} ${localDate(this.now())}.sqlite`,
      bytes: serializeDatabase(c.sqlite3, c.db),
    };
  }

  async backupNow(): Promise<void> {
    this.writable();
    await this.save();
    await this.backupCurrentFile();
    this.emit();
  }

  /** Back up to a folder of the owner's choice instead of `backups` in the company folder. */
  async setBackupDir(dir: FileSystemDirectoryHandle | null): Promise<void> {
    this.customBackupDir = dir;
    if (this.company) {
      this.latestBackup =
        (await listBackups(await this.backupDir())).find((b) => !b.label)?.at ?? null;
      this.emit();
    }
  }

  async listBackups(): Promise<BackupFile[]> {
    return listBackups(await this.backupDir());
  }

  /** The restore drill (M8): check a backup in memory against the open company. */
  async testBackup(name: string, passphrase: string): Promise<BackupCheck> {
    const c = this.open_();
    const backupDir = await this.backupDir();
    const exists = async (dir: FileSystemDirectoryHandle, id: string) => {
      try {
        const folder = await dir.getDirectoryHandle(ATTACHMENT_DIR);
        await folder.getFileHandle(`${id}.eba`);
        return true;
      } catch {
        return false;
      }
    };
    return c.drill(
      await readBackup(backupDir, name),
      passphrase,
      async (id) => (await exists(c.dir, id)) || (await exists(backupDir, id)),
    );
  }

  async previewBackup(name: string, passphrase: string): Promise<BackupPreview> {
    return OpenCompany.inspect(await readBackup(await this.backupDir(), name), passphrase);
  }

  /**
   * Replace the open company with one of its backups (DF-10). The current file
   * is backed up first, and a backup of a different company is refused.
   */
  async restoreBackup(name: string, passphrase: string): Promise<SessionStatus> {
    const c = this.writable();
    const backupDir = await this.backupDir();
    const bytes = await readBackup(backupDir, name);
    const preview = await OpenCompany.inspect(bytes, passphrase);
    if (preview.companyId !== c.id) {
      throw new WrongCompanyError(`That backup is of ${preview.legalName}, not this company.`);
    }
    // Save first: this runs the on-disk check (DF-3), so a file another device
    // changed is never overwritten, and the before-restore backup holds the latest work
    await this.save();
    const current = await readCompanyFile(c.dir);
    await writeBackup(backupDir, current.bytes, this.now(), 'before-restore');
    await writeCompanyFile(c.dir, bytes, current.stamp);
    const { dir } = c;
    const device = this.device;
    return this.withoutFlicker(async () => {
      await this.discard();
      const outcome = await this.open(dir, passphrase, { device, mode: 'edit' });
      if (outcome.kind !== 'opened') {
        throw new CompanyLockedError('The company could not be reopened after the restore.');
      }
      recordEvent(this.open_().db, 'restore', `from ${name}`);
      this.touch();
      await this.save();
      return this.status();
    });
  }

  /**
   * Restore a backup file into an empty folder, for when the company folder
   * itself is lost (DF-10). The new folder becomes the company folder.
   */
  async restoreInto(
    source: FileSystemFileHandle,
    passphrase: string,
    target: FileSystemDirectoryHandle,
    device: string,
  ): Promise<SessionStatus> {
    const bytes = new Uint8Array(await (await source.getFile()).arrayBuffer());
    await OpenCompany.inspect(bytes, passphrase);
    await this.close();
    await writeCompanyFile(target, bytes, null);
    const outcome = await this.open(target, passphrase, { device, mode: 'edit' });
    if (outcome.kind !== 'opened')
      throw new CompanyLockedError('The restored company could not be opened.');
    recordEvent(this.open_().db, 'restore', `from ${source.name}`);
    this.touch();
    await this.save();
    return this.status();
  }

  async previewBackupFile(
    source: FileSystemFileHandle,
    passphrase: string,
  ): Promise<BackupPreview> {
    return OpenCompany.inspect(
      new Uint8Array(await (await source.getFile()).arrayBuffer()),
      passphrase,
    );
  }

  // ---- other actions ----

  /** Keep working in a copy in another folder, e.g. after DF-3 refused a save. */
  async saveAs(dir: FileSystemDirectoryHandle): Promise<SessionStatus> {
    const c = this.open_();
    if (c.readOnly) throw new ReadOnlyError('This company is open read-only.');
    const oldDir = c.dir;
    await c.saveAs(dir);
    await releaseLock(oldDir, this.sessionId).catch(() => {});
    this.lockLost = false;
    this.error = null;
    this.lastSavedAt = this.now();
    await this.writeOurLock();
    if (!this.customBackupDir) {
      this.latestBackup = null;
      await this.backupCurrentFile();
    }
    this.emit();
    return this.status();
  }

  async changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<void> {
    await this.writable().changePassphrase(oldPassphrase, newPassphrase);
    this.touch();
    await this.save();
  }

  /** The company's logo for invoices (AR-8), a PNG; null without one. */
  companyLogo(): Uint8Array | null {
    return readLogo(this.open_().db);
  }

  setCompanyLogo(png: Uint8Array | null): void {
    writeLogo(this.writable().db, png);
    this.touch();
  }

  details(): CompanyDetails & { id: string; createdAt: string } {
    return readDetails(this.open_().db);
  }

  updateDetails(changes: Partial<CompanyDetails>): void {
    updateDetails(this.writable().db, changes);
    this.touch();
  }

  modules(): Record<Module, boolean> {
    return readModules(this.open_().db);
  }

  setModule(module: Module, enabled: boolean): void {
    setModule(this.writable().db, module, enabled);
    this.touch();
  }

  audit(opts?: { limit?: number; beforeId?: number; entity?: string }): AuditEvent[] {
    return readAuditEvents(this.open_().db, opts);
  }

  // ---- ledger (M3) ----

  accounts(): AccountRow[] {
    return listAccounts(this.open_().db);
  }

  createAccount(input: AccountInput): string {
    const id = createAccount(this.writable().db, input);
    this.touch();
    return id;
  }

  updateAccount(id: string, input: AccountInput): void {
    updateAccount(this.writable().db, id, input);
    this.touch();
  }

  setAccountActive(id: string, active: boolean): void {
    setAccountActive(this.writable().db, id, active);
    this.touch();
  }

  deleteAccount(id: string): void {
    deleteAccount(this.writable().db, id);
    this.touch();
  }

  seedChart(): number {
    const n = seedDefaultChart(this.writable().db);
    this.touch();
    return n;
  }

  entries(query?: EntryQuery): EntrySummary[] {
    return listEntries(this.open_().db, query);
  }

  /** An entry with its attachments, and the reconciliations it was cleared in (BK-8). */
  entry(id: number): EntryView | null {
    const db = this.open_().db;
    const e = getEntry(db, id);
    return (
      e && {
        ...e,
        files: listAttachments(db, 'journal_entry', String(id)),
        reconciled: entryReconciliations(db, id),
      }
    );
  }

  /** A closed-period override needs the passphrase again (PC-2). */
  private async override(passphrase: string | undefined): Promise<boolean> {
    if (!passphrase) return false;
    if (!(await this.writable().verifyPassphrase(passphrase))) {
      throw new WrongPassphraseError('Wrong passphrase.');
    }
    return true;
  }

  /** Post a manual journal entry (GL-4) through the one posting path. */
  async postJournalEntry(
    input: Omit<EntryInput, 'sourceType' | 'sourceId'>,
    overridePassphrase?: string,
  ): Promise<number> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const id = postEntry(db, { ...input, sourceType: 'journal' }, { closingOverride });
    this.touch();
    emitLedgerEvent('posted', { entryId: id, sourceType: 'journal', sourceId: null });
    return id;
  }

  async voidEntry(id: number, reason: string | null, overridePassphrase?: string): Promise<void> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    voidEntry(db, id, reason, { closingOverride });
    this.touch();
    const source = db.selectObjects(
      'SELECT source_type, source_id FROM journal_entry WHERE id = ?',
      [id],
    )[0];
    emitLedgerEvent('voided', {
      entryId: id,
      sourceType: String(source?.source_type),
      sourceId: source?.source_id === null ? null : String(source?.source_id),
    });
  }

  closingDate(): string | null {
    const v = this.open_().db.selectValue('SELECT closing_date FROM company');
    return v === null || v === undefined ? null : String(v);
  }

  /** Set or clear the closing date (PC-1). Owner only, like everything in the MVP (US-3). */
  setClosingDate(date: string | null): void {
    if (date !== null && !isIsoDate(date)) throw new LedgerRuleError('Enter a valid date.');
    this.writable().db.exec({ sql: 'UPDATE company SET closing_date = ?', bind: [date] });
    this.touch();
  }

  /** Run a report (RP-1, RP-2, RP-4). */
  report(req: ReportRequest): Report {
    return runReport(this.open_().db, req);
  }

  trialBalance(asOf: string): TrialBalance {
    if (!isIsoDate(asOf)) throw new LedgerRuleError('Enter a valid date.');
    return trialBalance(this.open_().db, asOf);
  }

  // ---- attachments (GL-4) ----

  async addAttachment(
    entity: 'journal_entry' | 'bill',
    entityId: string,
    file: File,
  ): Promise<AttachmentRow> {
    const c = this.writable();
    const exists =
      entity === 'bill'
        ? c.db.selectValue(`SELECT count(*) FROM bill WHERE id = ?`, [entityId])
        : c.db.selectValue(
            `SELECT count(*) FROM journal_entry WHERE id = ? AND status <> 'draft'`,
            [Number(entityId)],
          );
    if (exists !== 1)
      throw new LedgerRuleError(`That ${entity === 'bill' ? 'bill' : 'entry'} does not exist.`);
    const backupDir = await this.backupDir().catch(() => null);
    const row = await addAttachment(c, backupDir, entity, entityId, file);
    this.touch();
    return row;
  }

  openAttachment(id: string) {
    return openAttachment(this.open_(), id);
  }

  removeAttachment(id: string): void {
    removeAttachment(this.writable().db, id);
    this.touch();
  }

  // ---- QuickBooks migration (M5) ----

  /** Read a folder (or picked files) of QuickBooks exports and plan the import (MG-2, MG-4). */
  async migrationAnalyze(source: FileSystemDirectoryHandle | File[]): Promise<MigrationPlan> {
    const db = this.open_().db;
    const files = Array.isArray(source)
      ? await readPickedFiles(source)
      : await readExportFolder(source);
    const analysis = analyze(files);
    this.migration = analysis;
    return {
      summary: analysis.summary,
      choices: proposeChoices(db, analysis.summary.accounts),
      companyHasTransactions:
        Number(db.selectValue(`SELECT count(*) FROM journal_entry WHERE status <> 'draft'`)) > 0,
    };
  }

  /**
   * Dry run (commit false) or import the analysed exports (MG-4, MG-5, MG-6).
   * Migrated history doesn't announce each posting as a ledger event: it is
   * history, not new activity for other modules to act on.
   */
  migrationRun(
    choices: AccountChoices,
    opts: { commit: boolean; acceptDifferences?: boolean },
    onProgress?: (done: number, total: number) => void,
  ): ImportResult {
    const c = this.writable();
    if (!this.migration) throw new LedgerRuleError('Choose the QuickBooks exports first.');
    const analysis = this.migration;
    const run = () => runImport(c.db, analysis, choices, { ...opts, onProgress });
    // A dry run always rolls back, and so does an import that didn't commit
    const result = c.unchanged(run, (r) => !r.committed);
    if (result.committed) {
      this.migration = null;
      this.touch();
    }
    return result;
  }

  migrationDiscard(): void {
    this.migration = null;
  }

  // ---- payees: customers, vendors and other names (GL-11, AR-1, AP-1) ----

  payees(opts?: { kind?: PayeeKind; search?: string; includeInactive?: boolean }): Payee[] {
    return listPayees(this.open_().db, opts);
  }

  payee(id: string): Payee {
    return getPayee(this.open_().db, id);
  }

  payeeNames(): string[] {
    return payeeNames(this.open_().db);
  }

  payeeDefaultCategory(name: string): string | null {
    return defaultCategoryFor(this.open_().db, name);
  }

  createPayee(input: PayeeInput): string {
    const id = createPayee(this.writable().db, input);
    this.touch();
    return id;
  }

  updatePayee(id: string, input: PayeeInput): void {
    updatePayee(this.writable().db, id, input);
    this.touch();
  }

  mergePayee(fromId: string, intoId: string): void {
    mergePayee(this.writable().db, fromId, intoId);
    this.touch();
  }

  deletePayee(id: string): void {
    deletePayee(this.writable().db, id);
    this.touch();
  }

  // ---- transactions register (GL-9) and changing posted entries (GL-6) ----

  register(query?: RegisterQuery): RegisterResult {
    return register(this.open_().db, query);
  }

  /** Whether this company allows changing and deleting posted entries (GL-6 off). */
  postedEdits(): boolean {
    return this.open_().db.selectValue('SELECT posted_edits FROM company') === 1;
  }

  /** Allow or stop changing posted entries; allowing it needs the passphrase again. */
  async setPostedEdits(on: boolean, passphrase?: string): Promise<void> {
    const c = this.writable();
    if (on && !(await this.override(passphrase))) {
      throw new WrongPassphraseError(
        'Enter your passphrase to allow changing posted transactions.',
      );
    }
    c.db.exec({ sql: 'UPDATE company SET posted_edits = ?', bind: [on ? 1 : 0] });
    this.touch();
  }

  private source(id: number): LedgerEventDetail {
    const r = this.open_().db.selectObjects(
      'SELECT source_type, source_id FROM journal_entry WHERE id = ?',
      [id],
    )[0];
    return {
      entryId: id,
      sourceType: String(r?.source_type ?? 'journal'),
      sourceId: r?.source_id === null || r?.source_id === undefined ? null : String(r.source_id),
    };
  }

  // ---- sales: products & services, estimates, invoices, payments (AR-2 to AR-7) ----

  items(includeInactive = false): Item[] {
    return listItems(this.open_().db, includeInactive);
  }

  createItem(input: ItemInput): string {
    const id = createItem(this.writable().db, input);
    this.touch();
    return id;
  }

  updateItem(id: string, input: ItemInput): void {
    updateItem(this.writable().db, id, input);
    this.touch();
  }

  salesDocs(query: DocQuery): Doc[] {
    return listDocs(this.open_().db, query, localDate(this.now()));
  }

  salesDoc(id: string): Doc {
    return getDoc(this.open_().db, id, localDate(this.now()));
  }

  nextDocNumber(kind: DocKind): string {
    return nextNumber(this.open_().db, kind);
  }

  createSalesDoc(input: DocInput): string {
    const id = createDoc(this.writable().db, input);
    this.touch();
    return id;
  }

  updateSalesDoc(id: string, input: DocInput): void {
    updateDoc(this.writable().db, id, input, localDate(this.now()));
    this.touch();
  }

  voidSalesDoc(id: string): void {
    voidDoc(this.writable().db, id);
    this.touch();
  }

  deleteSalesDoc(id: string): void {
    deleteDoc(this.writable().db, id);
    this.touch();
  }

  markDocSent(id: string): void {
    markSent(this.writable().db, id);
    this.touch();
  }

  setEstimateStatus(id: string, status: 'accepted' | 'declined' | 'sent'): void {
    setEstimateStatus(this.writable().db, id, status);
    this.touch();
  }

  convertEstimate(id: string, date: string): string {
    const invoice = convertEstimate(this.writable().db, id, date, localDate(this.now()));
    this.touch();
    return invoice;
  }

  /**
   * An estimate or invoice as a PDF (AR-4), with what an email to the
   * customer would say: their address, a subject and a short message.
   */
  async docPdf(id: string): Promise<{
    fileName: string;
    bytes: Uint8Array;
    email: string | null;
    subject: string;
    body: string;
  }> {
    const db = this.open_().db;
    const d = getDoc(db, id, localDate(this.now()));
    const company = readDetails(db);
    const customer = getPayee(db, d.customerId);
    const itemNames = new Map(listItems(db, true).map((i) => [i.id, i.name]));
    const bytes = await renderDocPdf(
      {
        kind: d.kind,
        number: d.number,
        date: d.date,
        dueDate: d.dueDate,
        termsDays: d.termsDays,
        memo: d.memo,
        customer: d.customer,
        customerAddress: customer.address,
        lines: d.lines.map((l) => ({ ...l, itemName: l.itemId ? itemNames.get(l.itemId) : null })),
        total: d.total,
        paid: d.paid,
      },
      company,
      readLogo(db),
    );
    const title = d.kind === 'invoice' ? 'Invoice' : 'Estimate';
    const amount = formatMoney(d.kind === 'invoice' ? d.owed : d.total);
    const due = d.kind === 'invoice' && d.dueDate ? `, due ${longDate(d.dueDate)}` : '';
    return {
      fileName: `${title} ${d.number} - ${safeName(d.customer)}.pdf`,
      bytes,
      email: customer.email,
      subject: `${title} ${d.number} from ${company.legalName}`,
      body: `Hello,\n\nPlease find attached ${title.toLowerCase()} ${d.number} for ${amount}${due}.\n\nThank you,\n${company.legalName}`,
    };
  }

  customerBalances(): CustomerBalance[] {
    return customerBalances(this.open_().db, localDate(this.now()));
  }

  payments(query: { customerId?: string | null; docId?: string | null } = {}): Payment[] {
    return listPayments(this.open_().db, query);
  }

  /** Receive a payment on invoices; a date in a closed period needs the passphrase (PC-2). */
  async receivePayment(
    input: PaymentInput,
    overridePassphrase?: string,
  ): Promise<{ paymentId: string; entryId: number }> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const result = receivePayment(db, input, { closingOverride });
    this.touch();
    emitLedgerEvent('posted', this.source(result.entryId));
    return result;
  }

  async voidPayment(id: string, reason: string | null, overridePassphrase?: string): Promise<void> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const entryId = voidPayment(db, id, reason, { closingOverride });
    this.touch();
    emitLedgerEvent('voided', this.source(entryId));
  }

  // ---- bills and bill payments (AP-2 to AP-5) ----

  bills(query: BillQuery = {}): Bill[] {
    return listBills(this.open_().db, query, localDate(this.now()));
  }

  bill(id: string): Bill {
    return getBill(this.open_().db, id, localDate(this.now()));
  }

  /** A bill's attached files (AP-2), as an entry's. */
  billFiles(id: string): AttachmentRow[] {
    return listAttachments(this.open_().db, 'bill', id);
  }

  billsDue(): BillsDue {
    return billsDue(this.open_().db, localDate(this.now()));
  }

  createBill(input: BillInput): string {
    const id = createBill(this.writable().db, input);
    this.touch();
    return id;
  }

  updateBill(id: string, input: BillInput): void {
    updateBill(this.writable().db, id, input, localDate(this.now()));
    this.touch();
  }

  voidBill(id: string): void {
    voidBill(this.writable().db, id);
    this.touch();
  }

  deleteBill(id: string): void {
    deleteBill(this.writable().db, id);
    this.touch();
  }

  billPayments(query: { vendorId?: string | null; billId?: string | null } = {}): BillPayment[] {
    return listBillPayments(this.open_().db, query);
  }

  /** Pay bills; a date in a closed period needs the passphrase (PC-2). */
  async payBills(
    input: BillPaymentInput,
    overridePassphrase?: string,
  ): Promise<{ paymentId: string; entryId: number }> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const result = payBills(db, input, { closingOverride });
    this.touch();
    emitLedgerEvent('posted', this.source(result.entryId));
    return result;
  }

  async voidBillPayment(
    id: string,
    reason: string | null,
    overridePassphrase?: string,
  ): Promise<void> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const entryId = voidBillPayment(db, id, reason, { closingOverride });
    this.touch();
    emitLedgerEvent('voided', this.source(entryId));
  }

  // ---- recurring entries (GL-5) ----

  recurringList(): Recurring[] {
    return listRecurring(this.open_().db);
  }

  recurring(id: string): Recurring {
    return getRecurring(this.open_().db, id);
  }

  createRecurring(input: RecurringInput): string {
    const id = createRecurring(this.writable().db, input);
    this.touch();
    return id;
  }

  updateRecurring(id: string, input: RecurringInput): void {
    updateRecurring(this.writable().db, id, input);
    this.touch();
  }

  setRecurringActive(id: string, active: boolean): void {
    setRecurringActive(this.writable().db, id, active);
    this.touch();
  }

  deleteRecurring(id: string): void {
    deleteRecurring(this.writable().db, id);
    this.touch();
  }

  skipRecurring(id: string): void {
    skipNext(this.writable().db, id);
    this.touch();
  }

  /** Post a template's next date now; one in a closed period needs the passphrase (PC-2). */
  async postRecurringNow(id: string, overridePassphrase?: string): Promise<number> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const entryId = postNow(db, id, { closingOverride });
    this.touch();
    emitLedgerEvent('posted', this.source(entryId));
    return entryId;
  }

  /**
   * Post every recurring date that has come, as when the company opens; for an
   * app left open across the 1st. What happened shows until dismissed.
   */
  postDueRecurring(): RecurringResult {
    const db = this.writable().db;
    const today = localDate(this.now());
    const result = postDue(db, today);
    if (result.posted.length || result.waiting.length) {
      this.recurringNotice = result;
      for (const p of result.posted) emitLedgerEvent('posted', this.source(p.entryId));
      this.touch();
    }
    return result;
  }

  dismissRecurring(): void {
    this.recurringNotice = null;
    this.invoiceNotice = null;
    this.emit();
  }

  // ---- recurring invoices (AR-9) ----

  recurringInvoices(): RecurringInvoice[] {
    return listRecurringInvoices(this.open_().db);
  }

  recurringInvoice(id: string): RecurringInvoice {
    return getRecurringInvoice(this.open_().db, id);
  }

  createRecurringInvoice(input: RecurringInvoiceInput): string {
    const id = createRecurringInvoice(this.writable().db, input);
    this.touch();
    return id;
  }

  updateRecurringInvoice(id: string, input: RecurringInvoiceInput): void {
    updateRecurringInvoice(this.writable().db, id, input);
    this.touch();
  }

  setRecurringInvoiceActive(id: string, active: boolean): void {
    setRecurringInvoiceActive(this.writable().db, id, active);
    this.touch();
  }

  deleteRecurringInvoice(id: string): void {
    deleteRecurringInvoice(this.writable().db, id);
    this.touch();
  }

  skipRecurringInvoice(id: string): void {
    skipNextInvoice(this.writable().db, id);
    this.touch();
  }

  /** Make a template's next invoice now, before its date. Returns the invoice. */
  createRecurringInvoiceNow(id: string): string {
    const docId = createNow(this.writable().db, id);
    this.touch();
    return docId;
  }

  /**
   * Make every recurring invoice that has come due, as when the company opens.
   * Only while the sales module is on: a company that turned it off sees none.
   */
  createDueInvoices(): RecurringInvoiceResult {
    const db = this.writable().db;
    if (!readModules(db).sales) return { created: [], waiting: [] };
    const result = createDue(db, localDate(this.now()));
    if (result.created.length || result.waiting.length) {
      this.invoiceNotice = result;
      this.touch();
    }
    return result;
  }

  /** The bank or card accounts a register switches between, with balances (GL-12). */
  moneyAccounts(kind: RegisterKind): MoneyAccount[] {
    return moneyAccounts(this.open_().db, kind);
  }

  /** Add an income, expense or transfer from the register's quick form (GL-9, GL-13). */
  async addRegisterEntry(
    simple: SimpleEntry,
    head: Omit<EntryChange, 'lines'>,
    overridePassphrase?: string,
  ): Promise<number> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const id = postEntry(
      db,
      { ...simpleToEntry(simple, head), sourceType: REGISTER_SOURCE },
      { closingOverride },
    );
    this.touch();
    emitLedgerEvent('posted', this.source(id));
    return id;
  }

  /**
   * Save a change to a posted entry. Where the company allows it (GL-6 off) the
   * entry changes in place; otherwise it is voided and the corrected copy
   * posted. Returns the id of the entry as it now stands.
   */
  async saveEntryChange(
    id: number,
    change: EntryChange,
    overridePassphrase?: string,
  ): Promise<number> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    if (this.postedEdits()) {
      changeEntry(db, id, change, { closingOverride });
      this.touch();
      emitLedgerEvent('changed', this.source(id));
      return id;
    }
    const newId = correctEntry(db, id, change, { closingOverride });
    this.touch();
    emitLedgerEvent('voided', this.source(id));
    emitLedgerEvent('posted', this.source(newId));
    return newId;
  }

  /** The register's quick edit: the plain income or expense shape. */
  saveSimpleEntry(
    id: number,
    simple: SimpleEntry,
    head: Omit<EntryChange, 'lines'>,
    overridePassphrase?: string,
  ): Promise<number> {
    return this.saveEntryChange(id, simpleToEntry(simple, head), overridePassphrase);
  }

  /** Delete a posted entry, where the company allows it (GL-6 off). */
  async deleteEntry(id: number, overridePassphrase?: string): Promise<void> {
    const db = this.writable().db;
    if (!this.postedEdits()) {
      throw new LedgerRuleError(
        'Posted transactions can’t be deleted in this company; void it instead.',
      );
    }
    const closingOverride = await this.override(overridePassphrase);
    const detail = this.source(id);
    deleteEntry(db, id, { closingOverride });
    this.touch();
    emitLedgerEvent('deleted', detail);
  }

  // ---- banking (M6) ----

  /** Announce entries the review posted, like any other posting (CLAUDE.md rule 8). */
  private announcePosted(entryIds: number[]) {
    const db = this.open_().db;
    for (const entryId of entryIds) {
      const sourceId = db.selectValue('SELECT source_id FROM journal_entry WHERE id = ?', [
        entryId,
      ]);
      emitLedgerEvent('posted', {
        entryId,
        sourceType: BANK_SOURCE,
        sourceId: sourceId === null || sourceId === undefined ? null : String(sourceId),
      });
    }
  }

  bankAccounts(): BankAccount[] {
    return bankAccounts(this.open_().db);
  }

  /** Read statement files and show what's in them (BK-1). */
  async bankReadStatements(
    files: File[],
  ): Promise<{ statements: StatementPreview[]; problems: FileProblem[] }> {
    const db = this.open_().db;
    const read = readStatements(
      await Promise.all(
        files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
      ),
    );
    this.bankPending = read.pending;
    return { statements: previewStatements(db, read.pending), problems: read.problems };
  }

  /** Import the statements read last, each into the account chosen for it (key to account). */
  bankImport(accounts: Record<string, string>): StatementImportResult {
    const c = this.writable();
    if (!this.bankPending) throw new LedgerRuleError('Choose the statement files first.');
    const result = importStatements(c.db, this.bankPending, accounts);
    this.bankPending = null;
    this.touch();
    this.announcePosted(result.postedEntryIds);
    return result;
  }

  bankDiscardStatements(): void {
    this.bankPending = null;
  }

  bankImports(accountId: string): ImportRow[] {
    return listImports(this.open_().db, accountId);
  }

  bankUndoImport(importId: string): number {
    const removed = undoImport(this.writable().db, importId);
    this.touch();
    return removed;
  }

  bankQueue(accountId: string, view?: QueueView): QueueItem[] {
    return listQueue(this.open_().db, accountId, view);
  }

  async bankCategorize(
    id: number,
    input: CategorizeInput,
    overridePassphrase?: string,
  ): Promise<number> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const entryId = categorize(db, id, input, { closingOverride });
    this.touch();
    this.announcePosted([entryId]);
    return entryId;
  }

  async bankTransfer(id: number, otherTxnId: number, overridePassphrase?: string): Promise<number> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const entryId = transfer(db, id, otherTxnId, { closingOverride });
    this.touch();
    this.announcePosted([entryId]);
    return entryId;
  }

  async bankAcceptSuggestions(ids: number[], overridePassphrase?: string): Promise<number> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const entryIds = acceptSuggestions(db, ids, { closingOverride });
    this.touch();
    this.announcePosted(entryIds);
    return entryIds.length;
  }

  bankMatch(id: number, entryId: number): void {
    match(this.writable().db, id, entryId);
    this.touch();
  }

  bankMatchByBankText(ids: number[]): number {
    const n = matchByBankText(this.writable().db, ids);
    this.touch();
    return n;
  }

  bankExclude(id: number): void {
    exclude(this.writable().db, id);
    this.touch();
  }

  bankRestore(id: number): void {
    restore(this.writable().db, id);
    this.touch();
  }

  /** Send a reviewed transaction back to the queue, voiding the entry the review posted. */
  async bankUndo(id: number, overridePassphrase?: string): Promise<void> {
    const db = this.writable().db;
    const closingOverride = await this.override(overridePassphrase);
    const voided = undo(db, id, { closingOverride });
    this.touch();
    if (voided !== null) {
      emitLedgerEvent('voided', { entryId: voided, sourceType: BANK_SOURCE, sourceId: String(id) });
    }
  }

  bankRules(): RuleRow[] {
    return listRules(this.open_().db);
  }

  bankCreateRule(input: RuleInput): string {
    const id = createRule(this.writable().db, input);
    this.touch();
    return id;
  }

  bankUpdateRule(id: string, input: RuleInput): void {
    updateRule(this.writable().db, id, input);
    this.touch();
  }

  bankDeleteRule(id: string): void {
    deleteRule(this.writable().db, id);
    this.touch();
  }

  bankMoveRule(id: string, direction: 'up' | 'down'): void {
    moveRule(this.writable().db, id, direction);
    this.touch();
  }

  // ---- reconciliation (BK-7, BK-8) ----

  reconcileState(accountId: string): ReconcileState {
    return reconcileState(this.open_().db, accountId);
  }

  reconcileStart(
    accountId: string,
    statementDate: string,
    endingBalance: Cents,
    includeSubaccounts = false,
  ): string {
    const id = startReconciliation(
      this.writable().db,
      accountId,
      statementDate,
      endingBalance,
      includeSubaccounts,
    );
    this.touch();
    return id;
  }

  reconcileUpdate(id: string, statementDate: string, endingBalance: Cents): void {
    updateReconciliation(this.writable().db, id, statementDate, endingBalance);
    this.touch();
  }

  reconcileSetCleared(id: string, lineIds: number[], cleared: boolean): void {
    setCleared(this.writable().db, id, lineIds, cleared);
    this.touch();
  }

  reconcileSetAllCleared(id: string, cleared: boolean): void {
    setAllCleared(this.writable().db, id, cleared);
    this.touch();
  }

  reconcileFinish(id: string): void {
    finishReconciliation(this.writable().db, id);
    this.touch();
  }

  reconcileCancel(id: string): void {
    cancelReconciliation(this.writable().db, id);
    this.touch();
  }

  reconcileHistory(accountId: string): ReconciliationSummary[] {
    return reconciliationHistory(this.open_().db, accountId);
  }

  reconcileReport(id: string): ReconciliationReport {
    return reconciliationReport(this.open_().db, id);
  }

  /** The open company, for the M1 test screen only. */
  current(): OpenCompany {
    return this.open_();
  }

  // ---- closing ----

  /**
   * Record the lock, save and close (US-1). If the save fails the company
   * stays open, so the owner can save a copy instead.
   */
  async close(): Promise<void> {
    const c = this.company;
    if (!c) return;
    if (!c.readOnly && !this.lockLost) {
      recordEvent(c.db, 'lock', this.device);
      await this.save();
    }
    await this.discard();
  }

  /** Close without saving; unsaved changes are lost. */
  async discard(): Promise<void> {
    const c = this.company;
    if (!c) return;
    clearTimeout(this.saveTimer);
    clearInterval(this.heartbeat);
    if (!c.readOnly) await releaseLock(c.dir, this.sessionId).catch(() => {});
    this.releaseTabLock?.();
    this.releaseTabLock = undefined;
    c.close();
    this.company = undefined;
    this.migration = null;
    this.bankPending = null;
    this.lockLost = false;
    this.error = null;
    this.recurringNotice = null;
    this.invoiceNotice = null;
    // The backup folder belongs to this company; the next one sets its own
    this.customBackupDir = null;
    this.emit();
  }
}
