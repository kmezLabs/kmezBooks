// M1 technical-test tools, kept until docs/spikes/M1-results.md is complete;
// removed together with src/worker/spike.ts.

import { useState } from 'react';
import type { SessionStatus } from '../../worker/companySession';
import { db } from '../../shared/workerClient';
import { folderPickerSupported } from '../recentFolders';
import { deviceName } from '../settings';
import { ErrorText, TextField, useAction } from '../ui';

type Values = Record<string, string | number | boolean>;
interface Result {
  at: string;
  action: string;
  values: Values;
}

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

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

const toMarkdown = (results: Result[]) =>
  results
    .map(
      (r) =>
        `### ${r.action} (${r.at})\n\n| Measure | Value |\n| --- | --- |\n` +
        Object.entries(r.values)
          .map(([k, v]) => `| ${k} | ${String(v)} |`)
          .join('\n'),
    )
    .join('\n\n');

export function M1LabPage({ status }: { status: SessionStatus }) {
  const [years, setYears] = useState('17');
  const [perYear, setPerYear] = useState('6000');
  const [passphrase, setPassphrase] = useState('');
  const [results, setResults] = useState<Result[]>(() => [
    { at: new Date().toLocaleTimeString(), action: 'Environment', values: environment() },
  ]);
  const { busy, error, run } = useAction();

  const record = (action: string, values: Values) =>
    setResults((rs) => [...rs, { at: new Date().toLocaleTimeString(), action, values }]);

  return (
    <section>
      <h2>Technical test (M1)</h2>
      <p className="muted">
        Posts made-up deposits and payments into <strong>this</strong> test company's books, so they
        show in Transactions, the registers and the reports. Each run replaces the made-up history of
        the last run; entries you made yourself stay. Steps: generate, wait for "Saved", reopen
        (timings), time the reports. At 17 years of 6,000 it takes a few minutes and the file grows
        to over 100 MB.
      </p>
      <fieldset disabled={busy || status.readOnly}>
        <div className="fields">
          <TextField label="Years" value={years} onChange={setYears} width="short" />
          <TextField label="Entries per year" value={perYear} onChange={setPerYear} width="short" />
        </div>
        <div className="buttons">
          <button
            onClick={() =>
              run(async () => {
                const r = await db.spikeGenerate(Number(years), Number(perYear));
                record('Generate history', { years, entriesPerYear: perYear, ...r });
                const started = performance.now();
                await db.save();
                record('Save', { totalMs: Math.round(performance.now() - started) });
              })
            }
          >
            Generate history and save
          </button>
          <button
            className="secondary"
            onClick={() =>
              run(async () => {
                const r = await db.spikeMeasure();
                record('Reports', {
                  plOneYearMs: r.plOneYearMs,
                  plAllYearsMs: r.plAllYearsMs,
                  balanceSheetMs: r.balanceSheetMs,
                  trialBalanceMs: r.trialBalanceMs,
                  dbSize: mb(r.dbBytes),
                  wasmHeap: mb(r.wasmHeapBytes),
                });
              })
            }
          >
            Time the reports
          </button>
          <button
            className="secondary"
            onClick={() =>
              run(async () =>
                record('PBKDF2-SHA256 600,000 iterations', { ms: await db.spikePbkdf2() }),
              )
            }
          >
            Time PBKDF2
          </button>
          <button
            className="secondary"
            onClick={() =>
              run(async () => {
                const bytes = await db.spikeSlowWrite(10);
                record('Atomic-save test aborted', {
                  bytes,
                  next: 'Close and reopen the company: it must still open',
                });
              })
            }
          >
            Atomic-save test (10 s)
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const started = performance.now();
              const t = await db.spikeReopen(passphrase, deviceName());
              record('Open company', {
                ...Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'wasmHeapBytes')),
                totalMs: Math.round(performance.now() - started),
                wasmHeap: mb(t.wasmHeapBytes),
              });
            });
          }}
        >
          <div className="fields">
            <TextField
              label="Passphrase (to time a reopen)"
              type="password"
              value={passphrase}
              onChange={setPassphrase}
            />
          </div>
          <div className="buttons">
            <button type="submit" className="secondary" disabled={!passphrase}>
              Reopen and time it
            </button>
          </div>
        </form>
      </fieldset>
      {busy && <p className="status">Working…</p>}
      <ErrorText>{error}</ErrorText>
      <h3>Results</h3>
      <button
        className="secondary"
        onClick={() => navigator.clipboard.writeText(toMarkdown(results))}
      >
        Copy results as Markdown
      </button>
      {results.map((r, i) => (
        <details key={i} open={i === results.length - 1}>
          <summary>
            {r.at} · {r.action}
          </summary>
          <table className="kv">
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
  );
}
