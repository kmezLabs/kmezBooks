// The SQLite worker: the only code that touches the database or company files
// (CLAUDE.md rule 6). The UI calls it through Comlink; see src/shared/workerClient.ts.

import * as Comlink from 'comlink';
import { OpenCompany, type CompanyInfo, type SaveResult, type Timings } from './company';
import { COMPANY_FILE } from './companyFolder';
import { createCompanyKey, encryptDatabase } from './ebkFormat';
import { NoCompanyOpenError } from './errors';
import {
  createIndexes,
  dropIndexes,
  generateHistory,
  measureQueries,
  wasmHeapBytes,
} from './spike';
import { serializeDatabase } from './sqlite';

let current: OpenCompany | undefined;

function open(): OpenCompany {
  if (!current) throw new NoCompanyOpenError('No company is open.');
  return current;
}

async function replaceCurrent(next: OpenCompany) {
  current?.close();
  current = next;
}

const ms = (start: number) => Math.round(performance.now() - start);

const api = {
  async createCompany(
    dir: FileSystemDirectoryHandle,
    passphrase: string,
    legalName: string,
  ): Promise<{ info: CompanyInfo; timings: Timings }> {
    const { company, timings } = await OpenCompany.create(dir, passphrase, legalName);
    await replaceCurrent(company);
    return { info: company.info(), timings };
  },

  async openCompany(
    dir: FileSystemDirectoryHandle,
    passphrase: string,
  ): Promise<{ info: CompanyInfo; timings: Timings; wasmHeapBytes: number }> {
    const { company, timings } = await OpenCompany.open(dir, passphrase);
    await replaceCurrent(company);
    return { info: company.info(), timings, wasmHeapBytes: wasmHeapBytes(company.sqlite3) };
  },

  info(): CompanyInfo | null {
    return current?.info() ?? null;
  },

  save(): Promise<SaveResult> {
    return open().save();
  },

  close(): void {
    current?.close();
    current = undefined;
  },

  // ---- M1 technical test only (remove with src/worker/spike.ts) ----

  spikeGenerate(years: number, entriesPerYear: number) {
    const start = performance.now();
    const counts = generateHistory(open().db, { years, entriesPerYear });
    return { ...counts, generateMs: ms(start) };
  },

  spikeMeasure() {
    const company = open();
    dropIndexes(company.db);
    const noIndex = measureQueries(company.db);
    const indexMs = createIndexes(company.db);
    const withIndex = measureQueries(company.db);
    return {
      noIndex,
      indexMs,
      withIndex,
      dbBytes: company.info().dbBytes,
      wasmHeapBytes: wasmHeapBytes(company.sqlite3),
    };
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
    const company = open();
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
