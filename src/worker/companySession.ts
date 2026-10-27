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
import { emitLedgerEvent } from '../ledger/events';
import { isIsoDate, postEntry, voidEntry, type EntryInput } from '../ledger/postEntry';
import { runReport } from '../ledger/reports';
import { analyze, type Analysis, type AnalysisSummary } from '../modules/migration/analysis';
import {
  proposeChoices,
  runImport,
  type AccountChoices,
  type ImportResult,
} from '../modules/migration/importer';
import { readExportFolder, readPickedFiles } from '../modules/migration/sources';
import type { Report, ReportRequest } from '../shared/report';
import type { AccountInput, AccountRow } from '../shared/accounts';
import {
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
  defaultBackupDir,
  listBackups,
  pruneBackups,
  readBackup,
  writeBackup,
  type BackupFile,
} from './backups';
import { OpenCompany, type BackupPreview, type Timings } from './company';
import {
  owner,
  readAuditEvents,
  readDetails,
  readModules,
  setModule,
  updateDetails,
  type AuditEvent,
  type CompanyDetails,
  type Module,
  type NewCompany,
} from './companyData';
import { readCompanyFile, writeCompanyFile } from './companyFolder';
import {
  CompanyLockedError,
  LedgerRuleError,
  NoCompanyOpenError,
  OpenInAnotherTabError,
  ReadOnlyError,
  WrongCompanyError,
  WrongPassphraseError,
} from './errors';
import { HEARTBEAT_MS, checkLock, releaseLock, writeLock, type LockInfo } from './lockFile';

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

export type OpenMode = 'edit' | 'readOnly' | 'takeOver';

/** What the dry-run screen shows before the owner imports (MG-4). */
export interface MigrationPlan {
  summary: AnalysisSummary;
  /** The proposed target for each QuickBooks account */
  choices: AccountChoices;
  /** The company already has transactions, so it can't take an import (MG-6) */
  companyHasTransactions: boolean;
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
  private error: SessionStatus['error'] = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private releaseTabLock: (() => void) | undefined;
  private saveQueue: Promise<void> = Promise.resolve();
  /** QuickBooks exports read for the migration, kept between dry run and import */
  private migration: Analysis | null = null;
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
    } catch (e) {
      this.error = errorInfo(e);
      this.emit();
    }
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
      this.error = errorInfo(e);
      throw e;
    } finally {
      this.saving = false;
      this.emit();
    }
  }

  // ---- backups (DF-9, DF-10) ----

  private async backupDir(): Promise<FileSystemDirectoryHandle> {
    return this.customBackupDir ?? defaultBackupDir(this.open_().dir);
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

  entry(id: number): (EntryDetail & { files: AttachmentRow[] }) | null {
    const db = this.open_().db;
    const e = getEntry(db, id);
    return e && { ...e, files: listAttachments(db, 'journal_entry', String(id)) };
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
    entity: 'journal_entry',
    entityId: string,
    file: File,
  ): Promise<AttachmentRow> {
    const c = this.writable();
    const exists = c.db.selectValue(
      `SELECT count(*) FROM journal_entry WHERE id = ? AND status <> 'draft'`,
      [Number(entityId)],
    );
    if (exists !== 1) throw new LedgerRuleError('That entry does not exist.');
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
    this.lockLost = false;
    this.error = null;
    this.emit();
  }
}
