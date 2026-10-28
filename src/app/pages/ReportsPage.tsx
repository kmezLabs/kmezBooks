// Reports (RP-1 to RP-6): P&L, balance sheet, trial balance and general
// ledger detail, with presets, drill-down, export and print.

import { Fragment, useEffect, useState } from 'react';
import type { AccountRow } from '../../shared/accounts';
import {
  AS_OF_PRESETS,
  RANGE_PRESETS,
  asOfFor,
  rangeFor,
  type AsOfPreset,
  type RangePreset,
} from '../../shared/periods';
import {
  REPORT_TITLES,
  formatNumber,
  type Cell,
  type Drill,
  type Report,
  type ReportRow,
  type ReportKind,
  type ReportRequest,
} from '../../shared/report';
import type { SessionStatus } from '../../worker/companySession';
import { db, errorMessage } from '../../shared/workerClient';
import { download, reportFileName, reportToCsv, reportToXlsx } from '../export/exportReport';
import { EntryPeek } from '../EntryPeek';
import { AccountSelect, formatDate, todayIso } from '../ledgerUi';
import { ErrorText, formatDateTime } from '../ui';

const usesRange = (kind: ReportKind) => kind === 'pl' || kind === 'gl';

interface Controls {
  req: ReportRequest;
  rangePreset: RangePreset;
  asOfPreset: AsOfPreset;
}

function initial(kind: ReportKind, fyStartMonth: number): Controls {
  const today = todayIso();
  const range = rangeFor('this_year_to_date', today, fyStartMonth);
  return {
    req: usesRange(kind)
      ? { kind, from: range.from, to: range.to, accountId: null }
      : { kind, to: today },
    rangePreset: 'this_year_to_date',
    asOfPreset: 'today',
  };
}

function ReportTable({ report, onDrill }: { report: Report; onDrill: (d: Drill) => void }) {
  return (
    <div className="report-sheet">
      <header className="report-head">
        <div className="report-company">{report.company}</div>
        <h2>{report.title}</h2>
        <div>{report.period}</div>
        <div className="muted">{report.basis}</div>
      </header>
      {report.kind === 'gl' ? (
        <GeneralLedgerTable report={report} onDrill={onDrill} />
      ) : (
        <table className={`report report-${report.kind}`}>
          <thead>
            <tr>
              {report.columns.map((c, i) => (
                <th key={i} className={c.numeric ? 'num' : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row, r) => (
              <tr
                key={r}
                className={`${row.kind}${row.drill ? ' clickable' : ''}`}
                onClick={row.drill ? () => onDrill(row.drill!) : undefined}
                title={
                  row.drill
                    ? row.drill.kind === 'entry'
                      ? 'Open this entry'
                      : 'Show the entries behind this figure'
                    : undefined
                }
              >
                {row.cells.map((cell, i) => (
                  <td
                    key={i}
                    className={report.columns[i]?.numeric ? 'num' : undefined}
                    style={
                      i === 0 && row.depth
                        ? { paddingLeft: `${0.4 + row.depth * 1.25}rem` }
                        : undefined
                    }
                  >
                    {cell === null
                      ? ''
                      : typeof cell === 'number'
                        ? formatNumber(cell, report.columns[i])
                        : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {report.notes.map((n) => (
        <p key={n} className="warning">
          {n}
        </p>
      ))}
      <p className="muted report-foot">Prepared {formatDateTime(report.generatedAt)}</p>
    </div>
  );
}

/**
 * The general ledger on screen: each line in two rows (date, payee, the other
 * account and the amounts; then entry number, ref and memo), opening in place
 * when clicked. Exports keep the report's full columns.
 * Cells: date, entry, ref, name, memo, split, debit, credit, balance.
 */
function GeneralLedgerTable({ report, onDrill }: { report: Report; onDrill: (d: Drill) => void }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const toggle = (r: number) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (!next.delete(r)) next.add(r);
      return next;
    });
  const money = (cell: Cell | undefined, i: number) =>
    typeof cell === 'number' ? formatNumber(cell, report.columns[i]) : '';
  const amounts = (row: ReportRow) => (
    <>
      <td className="num">{money(row.cells[6], 6)}</td>
      <td className="num">{money(row.cells[7], 7)}</td>
      <td className="num">{money(row.cells[8], 8)}</td>
    </>
  );

  return (
    <table className="report report-gl two-line">
      <colgroup>
        <col className="gl-date" />
        <col />
        <col className="gl-account" />
        <col className="gl-money" />
        <col className="gl-money" />
        <col className="gl-money" />
      </colgroup>
      <thead>
        <tr>
          <th>Date</th>
          <th className="wide">Payee and memo</th>
          <th>Account</th>
          <th className="num">Debit</th>
          <th className="num">Credit</th>
          <th className="num">Balance</th>
        </tr>
      </thead>
      <tbody>
        {report.rows.map((row, r) => {
          const c = row.cells;
          if (row.kind === 'section') {
            return (
              <tr key={r} className="section">
                <td colSpan={6}>{c[0]}</td>
              </tr>
            );
          }
          if (!row.drill || row.drill.kind !== 'entry') {
            return (
              <tr key={r} className={row.kind}>
                <td colSpan={3} style={row.depth ? { paddingLeft: '1.65rem' } : undefined}>
                  {c[0]}
                </td>
                {amounts(row)}
              </tr>
            );
          }
          const drill = row.drill;
          const open = expanded.has(r);
          const name = c[3] as string | null;
          const memo = c[4] as string | null;
          return (
            <Fragment key={r}>
              <tr
                className={`row clickable${open ? ' open' : ''}`}
                aria-expanded={open}
                title={open ? undefined : 'Show this entry'}
                onClick={() => toggle(r)}
              >
                <td className="nowrap" style={{ paddingLeft: '1.65rem' }}>
                  <div>{formatDate(String(c[0]))}</div>
                  <div className="sub">No. {c[1]}</div>
                </td>
                <td className="wide">
                  <div className="line">{name ?? memo ?? '—'}</div>
                  <div className="sub line">
                    {[c[2] && `Ref ${String(c[2])}`, name ? memo : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </div>
                </td>
                <td>
                  <div className="line account">{c[5]}</div>
                </td>
                {amounts(row)}
              </tr>
              {open && (
                <tr className="peek">
                  <td colSpan={6}>
                    <EntryPeek id={drill.entryId} onOpen={() => onDrill(drill)} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export function ReportsPage(props: { status: SessionStatus; onOpenEntry: (id: number) => void }) {
  const [fyStartMonth, setFyStartMonth] = useState<number | null>(null);
  const [controls, setControls] = useState<Controls | null>(null);
  const [history, setHistory] = useState<Controls[]>([]);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // Kept apart from the request so it survives switching reports and drilling down
  const [percentOfIncome, setPercentOfIncome] = useState(false);

  useEffect(() => {
    void db.details().then((d) => {
      setFyStartMonth(d.fiscalYearStartMonth);
      // The general ledger first (owner's choice, Oct 28)
      setControls((c) => c ?? initial('gl', d.fiscalYearStartMonth));
    });
    void db.accounts().then(setAccounts);
  }, [props.status.companyId]);

  const req = controls?.req;
  useEffect(() => {
    if (!req) return;
    let current = true;
    const t = setTimeout(() => {
      setRunning(true);
      db.report(req.kind === 'pl' && percentOfIncome ? { ...req, percentOfIncome } : req).then(
        (r) => {
          if (!current) return;
          setReport(r);
          setError(null);
          setRunning(false);
        },
        (e) => {
          if (!current) return;
          setError(errorMessage(e));
          setRunning(false);
        },
      );
    }, 150);
    return () => {
      current = false;
      clearTimeout(t);
    };
  }, [req, percentOfIncome, props.status.lastSavedAt]);

  if (!controls || fyStartMonth === null) return null;
  const { kind } = controls.req;
  const set = (c: Partial<Controls>) => setControls({ ...controls, ...c });
  const setReq = (r: Partial<ReportRequest>) => set({ req: { ...controls.req, ...r } });

  const chooseKind = (k: ReportKind) => {
    setHistory([]);
    if (usesRange(k) === usesRange(kind)) setReq({ kind: k });
    else setControls(initial(k, fyStartMonth));
  };

  const chooseRange = (p: RangePreset) => {
    if (p === 'custom') return set({ rangePreset: p });
    const r = rangeFor(p, todayIso(), fyStartMonth);
    set({ rangePreset: p, req: { ...controls.req, from: r.from, to: r.to } });
  };

  const chooseAsOf = (p: AsOfPreset) => {
    if (p === 'custom') return set({ asOfPreset: p });
    set({ asOfPreset: p, req: { ...controls.req, to: asOfFor(p, todayIso(), fyStartMonth) } });
  };

  const drill = (d: Drill) => {
    if (d.kind === 'entry') {
      props.onOpenEntry(d.entryId);
      return;
    }
    setHistory([...history, controls]);
    setControls({
      rangePreset: 'custom',
      asOfPreset: 'custom',
      req:
        d.kind === 'account'
          ? { kind: 'gl', from: d.from, to: d.to, accountId: d.accountId }
          : { kind: 'pl', from: d.from, to: d.to },
    });
  };

  const back = () => {
    setControls(history.at(-1)!);
    setHistory(history.slice(0, -1));
  };

  return (
    <section className="reports">
      <div className="report-controls">
        <div className="fields">
          <label className="short">
            Report
            <select value={kind} onChange={(e) => chooseKind(e.target.value as ReportKind)}>
              {(Object.keys(REPORT_TITLES) as ReportKind[]).map((k) => (
                <option key={k} value={k}>
                  {REPORT_TITLES[k]}
                </option>
              ))}
            </select>
          </label>
          {usesRange(kind) ? (
            <>
              <label className="short">
                Period
                <select
                  value={controls.rangePreset}
                  onChange={(e) => chooseRange(e.target.value as RangePreset)}
                >
                  {(Object.keys(RANGE_PRESETS) as RangePreset[]).map((p) => (
                    <option key={p} value={p}>
                      {RANGE_PRESETS[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="short">
                From
                <input
                  type="date"
                  value={controls.req.from ?? ''}
                  onChange={(e) =>
                    set({
                      rangePreset: 'custom',
                      req: { ...controls.req, from: e.target.value || null },
                    })
                  }
                />
              </label>
              <label className="short">
                To
                <input
                  type="date"
                  value={controls.req.to}
                  required
                  onChange={(e) =>
                    e.target.value &&
                    set({ rangePreset: 'custom', req: { ...controls.req, to: e.target.value } })
                  }
                />
              </label>
            </>
          ) : (
            <>
              <label className="short">
                As of
                <select
                  value={controls.asOfPreset}
                  onChange={(e) => chooseAsOf(e.target.value as AsOfPreset)}
                >
                  {(Object.keys(AS_OF_PRESETS) as AsOfPreset[]).map((p) => (
                    <option key={p} value={p}>
                      {AS_OF_PRESETS[p]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="short">
                Date
                <input
                  type="date"
                  value={controls.req.to}
                  onChange={(e) =>
                    e.target.value &&
                    set({ asOfPreset: 'custom', req: { ...controls.req, to: e.target.value } })
                  }
                />
              </label>
            </>
          )}
          {kind === 'pl' && (
            <label className="check inline">
              <input
                type="checkbox"
                checked={percentOfIncome}
                onChange={(e) => setPercentOfIncome(e.target.checked)}
              />
              % of income
            </label>
          )}
          {kind === 'gl' && (
            <AccountSelect
              label="Account"
              accounts={accounts}
              value={controls.req.accountId ?? ''}
              onChange={(id) => setReq({ accountId: id || null })}
              emptyLabel="All accounts"
            />
          )}
        </div>
        <div className="buttons">
          {history.length > 0 && (
            <button className="secondary" onClick={back}>
              ← Back
            </button>
          )}
          <button
            className="secondary"
            disabled={!report}
            onClick={() =>
              report &&
              download(reportFileName(report, 'csv'), reportToCsv(report), 'text/csv;charset=utf-8')
            }
          >
            Export CSV
          </button>
          <button
            className="secondary"
            disabled={!report}
            onClick={() =>
              report &&
              download(
                reportFileName(report, 'xlsx'),
                reportToXlsx(report) as Uint8Array<ArrayBuffer>,
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              )
            }
          >
            Export Excel
          </button>
          <button className="secondary" disabled={!report} onClick={() => window.print()}>
            Print or save as PDF
          </button>
          {running && <span className="muted">Updating…</span>}
        </div>
        <ErrorText>{error}</ErrorText>
      </div>
      {report && <ReportTable report={report} onDrill={drill} />}
    </section>
  );
}
