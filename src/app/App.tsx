// M1 technical-test screen. Replaced by the real app shell in M2; the spike
// panel goes away with src/worker/spike.ts.

import { useEffect, useState } from 'react';
import type { CompanyInfo } from '../worker/company';
import { db, errorMessage, errorName } from '../shared/workerClient';
import {
  ensureReadWrite,
  folderPickerSupported,
  forgetFolder,
  listRecentFolders,
  pickFolder,
  rememberFolder,
  type RecentFolder,
} from './recentFolders';

type Values = Record<string, string | number | boolean>;
interface Result {
  at: string;
  action: string;
  values: Values;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

function prefixed(prefix: string, values: Record<string, number>): Values {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [`${prefix}${k}`, v]));
}

function environment(): Values {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    folderPicker: folderPickerSupported(),
    openFilePicker: 'showOpenFilePicker' in window,
    installed: window.matchMedia('(display-mode: standalone)').matches,
    deviceMemoryGB: nav.deviceMemory ?? 'unknown',
    cpuCores: navigator.hardwareConcurrency,
  };
}

function toMarkdown(results: Result[]): string {
  return results
    .map(
      (r) =>
        `### ${r.action} (${r.at})\n\n| Measure | Value |\n| --- | --- |\n` +
        Object.entries(r.values)
          .map(([k, v]) => `| ${k} | ${String(v)} |`)
          .join('\n'),
    )
    .join('\n\n');
}

export function App() {
  const [passphrase, setPassphrase] = useState('');
  const [legalName, setLegalName] = useState('Spike Test LLC');
  const [years, setYears] = useState(17);
  const [perYear, setPerYear] = useState(6000);
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [recent, setRecent] = useState<RecentFolder[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>(() => [
    { at: new Date().toLocaleTimeString(), action: 'Environment', values: environment() },
  ]);

  const refreshRecent = () => listRecentFolders().then(setRecent);
  useEffect(() => {
    refreshRecent();
  }, []);

  const record = (action: string, values: Values) =>
    setResults((rs) => [...rs, { at: new Date().toLocaleTimeString(), action, values }]);

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(`${errorName(e)}: ${errorMessage(e)}`);
    } finally {
      setBusy(null);
    }
  }

  const needPassphrase = () => {
    if (passphrase.length < 8) throw new Error('Enter a passphrase of at least 8 characters.');
  };

  const createCompany = () =>
    run('Creating company', async () => {
      needPassphrase();
      const dir = await pickFolder();
      if (!dir) return;
      const { info, timings } = await db.createCompany(dir, passphrase, legalName);
      await rememberFolder(info.legalName, dir);
      setCompany(info);
      record('Create company', { ...timings, dbSize: mb(info.dbBytes) });
      await refreshRecent();
    });

  const openCompany = (folder?: RecentFolder) =>
    run('Opening company', async () => {
      needPassphrase();
      const dir = folder?.handle ?? (await pickFolder());
      if (!dir) return;
      if (!(await ensureReadWrite(dir))) throw new Error('Permission to the folder was refused.');
      const started = performance.now();
      const { info, timings, wasmHeapBytes } = await db.openCompany(dir, passphrase);
      await rememberFolder(info.legalName, dir);
      setCompany(info);
      record('Open company', {
        ...timings,
        totalMs: Math.round(performance.now() - started),
        dbSize: mb(info.dbBytes),
        wasmHeap: mb(wasmHeapBytes),
      });
      await refreshRecent();
    });

  const save = () =>
    run('Saving', async () => {
      const started = performance.now();
      const r = await db.save();
      record('Save', {
        ...r.timings,
        totalMs: Math.round(performance.now() - started),
        dbSize: mb(r.dbBytes),
        fileSize: mb(r.fileBytes),
      });
    });

  const generate = () =>
    run('Generating history', async () => {
      const r = await db.spikeGenerate(years, perYear);
      record('Generate history', { years, entriesPerYear: perYear, ...r });
      setCompany(await db.info());
    });

  const measure = () =>
    run('Measuring queries', async () => {
      const r = await db.spikeMeasure();
      record('Queries', {
        ...prefixed('noIndex_', { ...r.noIndex }),
        createIndexesMs: r.indexMs,
        ...prefixed('indexed_', { ...r.withIndex }),
        dbSize: mb(r.dbBytes),
        wasmHeap: mb(r.wasmHeapBytes),
      });
    });

  const pbkdf2 = () =>
    run('Timing PBKDF2', async () => {
      record('PBKDF2-SHA256 600,000 iterations', { ms: await db.spikePbkdf2() });
    });

  const slowWrite = () =>
    run('Slow write in progress: close this tab now to test atomic saves', async () => {
      const bytes = await db.spikeSlowWrite(10);
      record('Slow write aborted', { bytes, next: 'Reopen the company: it must still open' });
    });

  const close = () =>
    run('Closing', async () => {
      await db.close();
      setCompany(null);
    });

  return (
    <main>
      <header>
        <h1>EasyBooks</h1>
        <p className="muted">M1 technical test: encrypted company folders, in-memory SQLite.</p>
      </header>

      {!folderPickerSupported() && (
        <p className="warning">
          This browser can't open folders on disk (no <code>showDirectoryPicker</code>). Record this
          result; on Android it means Android is out of scope for the MVP.
        </p>
      )}
      {busy && <p className="status">{busy}…</p>}
      {error && <p className="error">{error}</p>}

      <section>
        <h2>Company</h2>
        {company ? (
          <p>
            Open: <strong>{company.legalName}</strong> · schema {company.schemaVersion} ·{' '}
            {mb(company.dbBytes)}
          </p>
        ) : (
          <p className="muted">No company open.</p>
        )}
        <div className="fields">
          <label>
            Passphrase
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
            />
          </label>
          <label>
            Legal name (new company)
            <input value={legalName} onChange={(e) => setLegalName(e.target.value)} />
          </label>
        </div>
        <div className="buttons">
          <button disabled={!!busy} onClick={createCompany}>
            New company in a folder…
          </button>
          <button disabled={!!busy} onClick={() => openCompany()}>
            Open company folder…
          </button>
          <button disabled={!!busy || !company} onClick={save}>
            Save
          </button>
          <button disabled={!!busy || !company} onClick={close}>
            Close
          </button>
        </div>
        {recent.length > 0 && (
          <ul className="recent">
            {recent.map((f) => (
              <li key={f.lastOpened}>
                <button className="link" disabled={!!busy} onClick={() => openCompany(f)}>
                  {f.name}
                </button>{' '}
                <span className="muted">({f.handle.name})</span>{' '}
                <button
                  className="link muted"
                  onClick={() => forgetFolder(f.handle).then(refreshRecent)}
                >
                  forget
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Measurements</h2>
        <div className="fields">
          <label>
            Years
            <input type="number" value={years} onChange={(e) => setYears(+e.target.value)} />
          </label>
          <label>
            Entries per year
            <input type="number" value={perYear} onChange={(e) => setPerYear(+e.target.value)} />
          </label>
        </div>
        <div className="buttons">
          <button disabled={!!busy || !company} onClick={generate}>
            Generate history
          </button>
          <button disabled={!!busy || !company} onClick={measure}>
            Measure queries
          </button>
          <button disabled={!!busy} onClick={pbkdf2}>
            Time PBKDF2
          </button>
          <button disabled={!!busy || !company} onClick={slowWrite}>
            Atomic-save test (10 s)
          </button>
        </div>
        <p className="muted">
          Steps: create a company, generate history, Save, Close, reopen it (open timings), then
          Measure queries. For the atomic-save test, start it and close the tab within 10 seconds;
          then reopen the app and the company.
        </p>
      </section>

      <section>
        <h2>Results</h2>
        <button onClick={() => navigator.clipboard.writeText(toMarkdown(results))}>
          Copy results as Markdown
        </button>
        {results.map((r, i) => (
          <details key={i} open={i === results.length - 1}>
            <summary>
              {r.at} · {r.action}
            </summary>
            <table>
              <tbody>
                {Object.entries(r.values).map(([k, v]) => (
                  <tr key={k}>
                    <th>{k}</th>
                    <td>{String(v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ))}
      </section>
    </main>
  );
}
