// The SQLite worker: the only code that touches the database or company files
// (CLAUDE.md rule 6). The UI calls it through Comlink; see src/shared/workerClient.ts.

import * as Comlink from 'comlink';
import type { EntryQuery } from '../ledger/entries';
import type { EntryChange, EntryInput } from '../ledger/postEntry';
import type { RegisterQuery, SimpleEntry } from '../ledger/register';
import type { CategorizeInput, QueueView } from '../modules/banking/review';
import type { RuleInput } from '../modules/banking/rules';
import type { AccountChoices } from '../modules/migration/importer';
import type { AccountInput } from '../shared/accounts';
import type { ReportRequest } from '../shared/report';
import type { NewCompany, CompanyDetails, Module } from './companyData';
import { COMPANY_FILE } from './companyFolder';
import { CompanySession, type OpenMode, type SessionStatus } from './companySession';
import { createCompanyKey, encryptDatabase } from './ebkFormat';
import {
  createIndexes,
  dropIndexes,
  generateHistory,
  measureQueries,
  wasmHeapBytes,
} from './spike';
import { serializeDatabase } from './sqlite';

let listener: ((status: SessionStatus) => void) | undefined;

const session = new CompanySession({
  locks: navigator.locks,
  onStatus: (status) => listener?.(status),
});

const ms = (start: number) => Math.round(performance.now() - start);

const api = {
  /** Receive every status change (save state, errors, read-only…); returns the current status. */
  subscribe(callback: (status: SessionStatus) => void): SessionStatus {
    listener = callback;
    return session.status();
  },
  status: () => session.status(),

  create: (
    dir: FileSystemDirectoryHandle,
    details: NewCompany,
    passphrase: string,
    device: string,
  ) => session.create(dir, details, passphrase, device),
  open: (
    dir: FileSystemDirectoryHandle,
    passphrase: string,
    opts: { device: string; mode?: OpenMode },
  ) => session.open(dir, passphrase, opts),
  save: () => session.save(),
  folder: () => session.folder(),
  folderAccessRegained: () => session.folderAccessRegained(),
  close: () => session.close(),
  discard: () => session.discard(),
  saveAs: (dir: FileSystemDirectoryHandle) => session.saveAs(dir),

  details: () => session.details(),
  updateDetails: (changes: Partial<CompanyDetails>) => session.updateDetails(changes),
  modules: () => session.modules(),
  setModule: (module: Module, enabled: boolean) => session.setModule(module, enabled),
  changePassphrase: (oldPassphrase: string, newPassphrase: string) =>
    session.changePassphrase(oldPassphrase, newPassphrase),
  audit: (opts?: { limit?: number; beforeId?: number; entity?: string }) => session.audit(opts),

  // Ledger (M3)
  accounts: () => session.accounts(),
  createAccount: (input: AccountInput) => session.createAccount(input),
  updateAccount: (id: string, input: AccountInput) => session.updateAccount(id, input),
  setAccountActive: (id: string, active: boolean) => session.setAccountActive(id, active),
  deleteAccount: (id: string) => session.deleteAccount(id),
  seedChart: () => session.seedChart(),
  entries: (query?: EntryQuery) => session.entries(query),
  entry: (id: number) => session.entry(id),
  postJournalEntry: (
    input: Omit<EntryInput, 'sourceType' | 'sourceId'>,
    overridePassphrase?: string,
  ) => session.postJournalEntry(input, overridePassphrase),
  voidEntry: (id: number, reason: string | null, overridePassphrase?: string) =>
    session.voidEntry(id, reason, overridePassphrase),
  register: (query?: RegisterQuery) => session.register(query),
  postedEdits: () => session.postedEdits(),
  setPostedEdits: (on: boolean, passphrase?: string) => session.setPostedEdits(on, passphrase),
  addRegisterEntry: (
    simple: SimpleEntry,
    head: Omit<EntryChange, 'lines'>,
    overridePassphrase?: string,
  ) => session.addRegisterEntry(simple, head, overridePassphrase),
  saveEntryChange: (id: number, change: EntryChange, overridePassphrase?: string) =>
    session.saveEntryChange(id, change, overridePassphrase),
  saveSimpleEntry: (
    id: number,
    simple: SimpleEntry,
    head: Omit<EntryChange, 'lines'>,
    overridePassphrase?: string,
  ) => session.saveSimpleEntry(id, simple, head, overridePassphrase),
  deleteEntry: (id: number, overridePassphrase?: string) =>
    session.deleteEntry(id, overridePassphrase),
  closingDate: () => session.closingDate(),
  setClosingDate: (date: string | null) => session.setClosingDate(date),
  trialBalance: (asOf: string) => session.trialBalance(asOf),
  report: (req: ReportRequest) => session.report(req),
  addAttachment: (entity: 'journal_entry', entityId: string, file: File) =>
    session.addAttachment(entity, entityId, file),
  openAttachment: (id: string) => session.openAttachment(id),
  removeAttachment: (id: string) => session.removeAttachment(id),

  // QuickBooks migration (M5)
  migrationAnalyze: (source: FileSystemDirectoryHandle | File[]) =>
    session.migrationAnalyze(source),
  migrationRun: (
    choices: AccountChoices,
    opts: { commit: boolean; acceptDifferences?: boolean },
    onProgress?: (done: number, total: number) => void,
  ) => session.migrationRun(choices, opts, onProgress),
  migrationDiscard: () => session.migrationDiscard(),

  // Banking (M6)
  bankAccounts: () => session.bankAccounts(),
  bankReadStatements: (files: File[]) => session.bankReadStatements(files),
  bankImport: (accounts: Record<string, string>) => session.bankImport(accounts),
  bankDiscardStatements: () => session.bankDiscardStatements(),
  bankImports: (accountId: string) => session.bankImports(accountId),
  bankUndoImport: (importId: string) => session.bankUndoImport(importId),
  bankQueue: (accountId: string, view?: QueueView) => session.bankQueue(accountId, view),
  bankCategorize: (id: number, input: CategorizeInput, overridePassphrase?: string) =>
    session.bankCategorize(id, input, overridePassphrase),
  bankTransfer: (id: number, otherTxnId: number, overridePassphrase?: string) =>
    session.bankTransfer(id, otherTxnId, overridePassphrase),
  bankAcceptSuggestions: (ids: number[], overridePassphrase?: string) =>
    session.bankAcceptSuggestions(ids, overridePassphrase),
  bankMatch: (id: number, entryId: number) => session.bankMatch(id, entryId),
  bankExclude: (id: number) => session.bankExclude(id),
  bankRestore: (id: number) => session.bankRestore(id),
  bankUndo: (id: number, overridePassphrase?: string) => session.bankUndo(id, overridePassphrase),
  bankRules: () => session.bankRules(),
  bankCreateRule: (input: RuleInput) => session.bankCreateRule(input),
  bankUpdateRule: (id: string, input: RuleInput) => session.bankUpdateRule(id, input),
  bankDeleteRule: (id: string) => session.bankDeleteRule(id),
  bankMoveRule: (id: string, direction: 'up' | 'down') => session.bankMoveRule(id, direction),
  reconcileState: (accountId: string) => session.reconcileState(accountId),
  reconcileStart: (
    accountId: string,
    statementDate: string,
    endingBalance: number,
    includeSubaccounts?: boolean,
  ) => session.reconcileStart(accountId, statementDate, endingBalance, includeSubaccounts),
  reconcileUpdate: (id: string, statementDate: string, endingBalance: number) =>
    session.reconcileUpdate(id, statementDate, endingBalance),
  reconcileSetCleared: (id: string, lineIds: number[], cleared: boolean) =>
    session.reconcileSetCleared(id, lineIds, cleared),
  reconcileSetAllCleared: (id: string, cleared: boolean) =>
    session.reconcileSetAllCleared(id, cleared),
  reconcileFinish: (id: string) => session.reconcileFinish(id),
  reconcileCancel: (id: string) => session.reconcileCancel(id),
  reconcileHistory: (accountId: string) => session.reconcileHistory(accountId),
  reconcileReport: (id: string) => session.reconcileReport(id),

  listBackups: () => session.listBackups(),
  backupNow: () => session.backupNow(),
  setBackupDir: (dir: FileSystemDirectoryHandle | null) => session.setBackupDir(dir),
  previewBackup: (name: string, passphrase: string) => session.previewBackup(name, passphrase),
  restoreBackup: (name: string, passphrase: string) => session.restoreBackup(name, passphrase),
  previewBackupFile: (file: FileSystemFileHandle, passphrase: string) =>
    session.previewBackupFile(file, passphrase),
  restoreInto: (
    file: FileSystemFileHandle,
    passphrase: string,
    target: FileSystemDirectoryHandle,
    device: string,
  ) => session.restoreInto(file, passphrase, target, device),

  // ---- M1 technical test only (remove with src/worker/spike.ts) ----

  spikeGenerate(years: number, entriesPerYear: number) {
    const start = performance.now();
    const counts = generateHistory(session.current().db, { years, entriesPerYear });
    session.touch();
    return { ...counts, generateMs: ms(start) };
  },

  spikeMeasure() {
    const company = session.current();
    dropIndexes(company.db);
    const noIndex = measureQueries(company.db);
    const indexMs = createIndexes(company.db);
    const withIndex = measureQueries(company.db);
    session.touch();
    return {
      noIndex,
      indexMs,
      withIndex,
      dbBytes: company.info().dbBytes,
      wasmHeapBytes: wasmHeapBytes(company.sqlite3),
    };
  },

  /** Close and reopen the open company, returning the open timings. */
  async spikeReopen(passphrase: string, device: string) {
    const dir = session.current().dir;
    await session.close();
    const outcome = await session.open(dir, passphrase, { device });
    if (outcome.kind !== 'opened') throw new Error('The company is locked by another device.');
    return { ...outcome.timings, wasmHeapBytes: wasmHeapBytes(session.current().sqlite3) };
  },

  spikeInfo() {
    const company = session.current();
    return { ...company.info(), wasmHeapBytes: wasmHeapBytes(company.sqlite3) };
  },

  async spikePbkdf2(): Promise<number> {
    const start = performance.now();
    await createCompanyKey('benchmark passphrase');
    return ms(start);
  },

  /**
   * Atomic-save test: stream data into company.ebk in small chunks over
   * `seconds`, so the tab can be killed part-way through, then abort. The data
   * uses a throwaway key, so if any of it ever reached company.ebk the company
   * would no longer open: reopening it afterwards is the test.
   */
  async spikeSlowWrite(seconds: number): Promise<number> {
    const company = session.current();
    const key = await createCompanyKey('throwaway', 1_000);
    const bytes = await encryptDatabase(key, serializeDatabase(company.sqlite3, company.db));
    const handle = await company.dir.getFileHandle(COMPANY_FILE);
    const writable = await handle.createWritable();
    const chunks = 50;
    const size = Math.ceil(bytes.byteLength / chunks);
    for (let i = 0; i < chunks; i++) {
      await writable.write(bytes.subarray(i * size, (i + 1) * size));
      await new Promise((r) => setTimeout(r, (seconds * 1000) / chunks));
    }
    // Deliberately abort rather than close: the test is about what survives
    // an interrupted write, and an abort must also leave the old file intact
    await writable.abort();
    return bytes.byteLength;
  },
};

export type WorkerApi = typeof api;

Comlink.expose(api);
