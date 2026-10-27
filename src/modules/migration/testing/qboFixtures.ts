// Anonymized QuickBooks Online exports for tests: made-up companies written in
// the exact layout of real "Export data" files (checked against a real export
// in M5). Each test describes accounts and transactions; this writes the
// Journal, General Ledger, Trial Balance, Balance Sheet, Account List and
// contact lists the way QuickBooks does, including its quirks: check numbers
// as numbers, statement amounts as formulas with a cached 0, nested
// sub-accounts by indentation, and "Cash Basis" in the footer.

import { strToU8, zipSync } from 'fflate';
import { isDebitNormal } from '../../../shared/accounts';
import { dayBefore } from '../../../shared/periods';
import type { SourceFile } from '../analysis';
import { mapQboType } from '../qboAccounts';

/** A text cell, a number (decimal text), or a formula holding a number. */
export type XCell = string | { n: string } | { f: string } | null | undefined;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function colName(i: number): string {
  let n = i + 1;
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** An .xlsx with one sheet; `rows[i]` is sheet row i + 1, null for a blank row. */
export function xlsx(sheetName: string, rows: (XCell[] | null)[]): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const str = (s: string) => {
    if (!sharedIndex.has(s)) {
      sharedIndex.set(s, shared.length);
      shared.push(s);
    }
    return sharedIndex.get(s)!;
  };
  const rowXml = rows
    .map((cells, i) => {
      if (!cells) return '';
      const r = i + 1;
      const cx = cells
        .map((c, j) => {
          const ref = `${colName(j)}${r}`;
          if (c === null || c === undefined) return '';
          if (typeof c === 'string') return `<c r="${ref}" s="2" t="s"><v>${str(c)}</v></c>`;
          if ('n' in c) return `<c r="${ref}" s="3" t="n"><v>${c.n}</v></c>`;
          return `<c r="${ref}" s="4" t="n"><f>${c.f}</f><v>0.0</v></c>`;
        })
        .join('');
      return `<row r="${r}">${cx}</row>`;
    })
    .join('');
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName)}" r:id="rId3" sheetId="1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

// ---- companies ----

export interface FxAccount {
  /** Full name, "Parent:Child" */
  name: string;
  /** QuickBooks type and detail type, as in its Account List */
  type: string;
  detail: string;
}

export interface FxLine {
  account: string;
  debit?: number;
  credit?: number;
  memo?: string;
  name?: string;
}

export interface FxTxn {
  date: string;
  type: string;
  /** A check number (written as a number, like QuickBooks) or other text */
  num?: number | string;
  name?: string;
  lines: FxLine[];
}

export interface FxYear {
  from: string;
  to: string;
  txns: FxTxn[];
}

export interface FxCompany {
  company: string;
  accounts: FxAccount[];
  /** Posted before the first exported year: shows only as beginning balances */
  before?: FxTxn[];
  years: FxYear[];
  customers?: string[];
  vendors?: string[];
}

/** QuickBooks's way of writing an amount: "12500.0", "4250.2", "-654321.09". */
export function amount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const frac = String(abs % 100)
    .padStart(2, '0')
    .replace(/0$/, '');
  return `${sign}${Math.floor(abs / 100)}.${frac || '0'}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const usDate = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
const longDate = (d: string) =>
  `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
const yearPeriod = (y: FxYear) =>
  `${MONTHS[Number(y.from.slice(5, 7)) - 1]} - ${MONTHS[Number(y.to.slice(5, 7)) - 1]} ${y.to.slice(0, 4)}`;
const FOOTER = 'Tuesday, Oct 27, 2026 10:06:28 AM GMT-7';

type Kind = 'asset' | 'liability' | 'equity' | 'income' | 'expense';

export interface FxOptions {
  /** Basis printed in the footer of the cash-basis reports */
  basis?: 'Cash Basis' | 'Accrual Basis';
  /** Leave files out, e.g. ['General_ledger.xlsx'] */
  omit?: string[];
  /** Change a trial balance amount before writing: [year index, account, cents] */
  tbOverride?: [number, string, number];
  /** Journal transactions that differ from the ledger (accrual documents), per year index */
  journalExtra?: Record<number, FxTxn[]>;
  /** Accounts left out of the Account List, as QuickBooks does with deleted ones */
  unlisted?: string[];
}

/** Every file of the company's exports, as the owner would put them in one folder. */
export function exportFiles(c: FxCompany, opts: FxOptions = {}): SourceFile[] {
  const kind = new Map<string, Kind>();
  for (const a of c.accounts) kind.set(a.name, mapQboType(a.type, a.detail)!.type);
  const kindOf = (name: string) => {
    const k = kind.get(name);
    if (!k) throw new Error(`Fixture account ${name} is not in the account list`);
    return k;
  };
  const isPl = (n: string) => ['income', 'expense'].includes(kindOf(n));
  const normal = (n: string, net: number) => (isDebitNormal(kindOf(n)) ? net : -net);
  const basis = opts.basis ?? 'Cash Basis';
  const out: SourceFile[] = [];
  const add = (path: string, name: string, rows: (XCell[] | null)[]) => {
    if (!opts.omit?.includes(path.split('/').at(-1)!)) out.push({ path, bytes: xlsx(name, rows) });
  };
  const net = (t: FxTxn[], filter: (d: string) => boolean) => {
    const m = new Map<string, number>();
    for (const x of t.filter((x) => filter(x.date)))
      for (const l of x.lines)
        m.set(l.account, (m.get(l.account) ?? 0) + (l.debit ?? 0) - (l.credit ?? 0));
    return m;
  };
  const all = [...(c.before ?? []), ...c.years.flatMap((y) => y.txns)];
  const reName = c.accounts.find((a) => /retained/i.test(a.detail))?.name ?? 'Retained Earnings';

  c.years.forEach((y, yi) => {
    const folder = `${c.company} ${y.from.replaceAll('-', '')}-${y.to.replaceAll('-', '')}`;
    const head = (title: string, sub: string): (XCell[] | null)[] => [
      [c.company],
      [title],
      [sub],
      null,
    ];

    // Journal
    const jrows: (XCell[] | null)[] = [
      ...head('Journal', yearPeriod(y)),
      [
        null,
        'Date',
        'Transaction Type',
        'Num',
        'Name',
        'Memo/Description',
        'Account',
        'Debit',
        'Credit',
      ],
    ];
    let jd = 0;
    let jc = 0;
    for (const t of [...y.txns, ...(opts.journalExtra?.[yi] ?? [])]) {
      t.lines.forEach((l, i) => {
        const num =
          t.num === undefined ? null : typeof t.num === 'number' ? { n: `${t.num}.0` } : t.num;
        jrows.push([
          null,
          i === 0 ? usDate(t.date) : null,
          i === 0 ? t.type : null,
          i === 0 ? num : null,
          i === 0 ? (t.name ?? null) : (l.name ?? null),
          l.memo ?? null,
          l.account,
          l.debit ? { n: amount(l.debit) } : null,
          l.credit ? { n: amount(l.credit) } : null,
        ]);
      });
      const d = t.lines.reduce((s, l) => s + (l.debit ?? 0), 0);
      const k = t.lines.reduce((s, l) => s + (l.credit ?? 0), 0);
      jd += d;
      jc += k;
      jrows.push(
        [null, null, null, null, null, null, null, { n: amount(d) }, { n: amount(k) }],
        null,
      );
    }
    jrows.push(
      ['TOTAL', null, null, null, null, null, null, { n: amount(jd) }, { n: amount(jc) }],
      null,
      null,
      [FOOTER],
    );
    add(`${folder}/Journal.xlsx`, 'Journal', jrows);

    // General Ledger: a section per account, sub-accounts nested
    const before = net(all, (d) => d < y.from);
    const priorPl = [...before].filter(([n]) => isPl(n)).reduce((s, [, v]) => s + v, 0);
    const beginning = new Map<string, number>();
    for (const [n, v] of before) if (!isPl(n)) beginning.set(n, normal(n, v));
    beginning.set(reName, (beginning.get(reName) ?? 0) + normal(reName, priorPl));
    const glRows: (XCell[] | null)[] = [
      ...head('General Ledger', yearPeriod(y)),
      [
        null,
        'Date',
        'Transaction Type',
        'Num',
        'Name',
        'Memo/Description',
        'Account',
        'Debit',
        'Credit',
        'Balance',
      ],
    ];
    const names = c.accounts.map((a) => a.name);
    const emitSection = (name: string, depth: number) => {
      const pad = '   '.repeat(depth);
      const leaf = name.split(':').at(-1)!;
      const lines = y.txns.flatMap((t) =>
        t.lines.filter((l) => l.account === name).map((l) => ({ t, l })),
      );
      const children = names.filter(
        (n) => n.startsWith(`${name}:`) && n.split(':').length === name.split(':').length + 1,
      );
      const begin = beginning.get(name) ?? 0;
      const hasChildActivity = (n: string): boolean =>
        y.txns.some((t) => t.lines.some((l) => l.account === n)) ||
        (beginning.get(n) ?? 0) !== 0 ||
        names.some((m) => m.startsWith(`${n}:`) && hasChildActivity(m));
      if (!lines.length && !begin && !children.some(hasChildActivity)) return;
      glRows.push([`${pad}${leaf}`]);
      if (begin)
        glRows.push([
          null,
          'Beginning Balance',
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          { n: amount(begin) },
        ]);
      let bal = begin;
      for (const { t, l } of lines.sort((a, b) => a.t.date.localeCompare(b.t.date))) {
        bal += normal(name, (l.debit ?? 0) - (l.credit ?? 0));
        const num =
          t.num === undefined ? null : typeof t.num === 'number' ? { n: `${t.num}.0` } : t.num;
        glRows.push([
          null,
          usDate(t.date),
          t.type,
          num,
          l.name ?? t.name ?? null,
          l.memo ?? null,
          name,
          l.debit ? { n: amount(l.debit) } : null,
          l.credit ? { n: amount(l.credit) } : null,
          { n: amount(bal) },
        ]);
      }
      for (const ch of children) emitSection(ch, depth + 1);
      glRows.push([`${pad}Total for ${leaf}`]);
    };
    for (const n of names.filter((x) => !x.includes(':'))) emitSection(n, 0);
    glRows.push(null, null, [`${FOOTER} - ${basis}`]);
    add(`${folder}/General_ledger.xlsx`, 'General Ledger', glRows);

    // Trial Balance as of the year end
    const upTo = net(all, (d) => d <= y.to);
    const thisYear = net(all, (d) => d >= y.from && d <= y.to);
    const tb = new Map<string, number>();
    for (const n of names) {
      const v = isPl(n) ? (thisYear.get(n) ?? 0) : (upTo.get(n) ?? 0);
      if (v) tb.set(n, v);
    }
    tb.set(reName, (tb.get(reName) ?? 0) + priorPl);
    if (tb.get(reName) === 0) tb.delete(reName);
    if (opts.tbOverride?.[0] === yi) tb.set(opts.tbOverride[1], opts.tbOverride[2]);
    const tbRows: (XCell[] | null)[] = [
      ...head('Trial Balance', `As of ${longDate(y.to)}`),
      [null, 'Debit', 'Credit'],
    ];
    for (const [n, v] of tb)
      tbRows.push([n, v > 0 ? { f: amount(v) } : null, v < 0 ? { f: amount(-v) } : null]);
    tbRows.push(['TOTAL', { f: '(B6)+(B7)' }, { f: '(C6)+(C7)' }], null, null, null, [
      `${FOOTER} - ${basis}`,
    ]);
    add(`${folder}/Trial_balance.xlsx`, 'Trial Balance', tbRows);

    // Balance Sheet: headings, indented accounts, totals as formulas
    const bsRows: (XCell[] | null)[] = [
      ...head('Balance Sheet', `As of ${longDate(y.to)}`),
      [null, 'Total'],
    ];
    const shown = (n: string) => {
      const v = n === reName ? (tb.get(n) ?? 0) : (upTo.get(n) ?? 0);
      return normal(n, v);
    };
    const bsAccounts = (k: Kind, depth: number) => {
      const emit = (n: string, d: number) => {
        const pad = '   '.repeat(d);
        const leaf = n.split(':').at(-1)!;
        const kids = names.filter(
          (m) => m.startsWith(`${n}:`) && m.split(':').length === n.split(':').length + 1,
        );
        const v = shown(n);
        if (kids.length) {
          bsRows.push(v ? [`${pad}${leaf}`, { f: amount(v) }] : [`${pad}${leaf}`]);
          for (const kid of kids) emit(kid, d + 1);
          bsRows.push([`${pad}Total ${leaf}`, { f: 'B1' }]);
        } else if (v) {
          bsRows.push([`${pad}${leaf}`, { f: amount(v) }]);
        }
      };
      for (const n of names.filter((x) => !x.includes(':') && kindOf(x) === k)) emit(n, depth);
    };
    bsRows.push(['ASSETS'], ['   Current Assets']);
    bsAccounts('asset', 2);
    bsRows.push(['   Total Current Assets', { f: 'B7' }], ['TOTAL ASSETS', { f: 'B8' }]);
    bsRows.push(['LIABILITIES AND EQUITY'], ['   Liabilities']);
    bsAccounts('liability', 2);
    bsRows.push(['   Total Liabilities', { f: 'B9' }], ['   Equity']);
    bsAccounts('equity', 2);
    const ni = -[...thisYear].filter(([n]) => isPl(n)).reduce((s, [, v]) => s + v, 0);
    if (ni) bsRows.push(['      Net Income', { f: amount(ni) }]);
    bsRows.push(
      ['   Total Equity', { f: 'B10' }],
      ['TOTAL LIABILITIES AND EQUITY', { f: 'B11' }],
      null,
      null,
      [`${FOOTER} - ${basis}`],
    );
    add(`${folder}/Balance_sheet.xlsx`, 'Balance Sheet', bsRows);

    // Contact lists, as Export data writes them in each folder
    const contacts = (
      title: string,
      first: string,
      list: string[] | undefined,
    ): (XCell[] | null)[] => [
      [c.company],
      [title],
      null,
      null,
      [
        null,
        first,
        'Phone Numbers',
        'Email',
        'Full Name',
        first === 'Customer' ? 'Billing Address' : 'Address',
      ],
      ...(list ?? []).map((n): XCell[] => [null, n]),
      null,
      null,
      [FOOTER],
    ];
    add(
      `${folder}/Customers.xlsx`,
      'Customer Contact List',
      contacts('Customer Contact List', 'Customer', c.customers),
    );
    add(
      `${folder}/Vendors.xlsx`,
      'Vendor Contact List',
      contacts('Vendor Contact List', 'Vendor', c.vendors),
    );
  });

  add(`${c.company}_Account List.xlsx`, 'Sheet1', [
    [c.company],
    ['Account List'],
    null,
    ['Account Name', 'Type', 'Detail type', 'Description', 'Total balance'],
    ...c.accounts
      .filter((a) => !opts.unlisted?.includes(a.name))
      .map((a): XCell[] => [a.name, a.type, a.detail]),
    ['TOTAL', null, null, null, { f: 'E5+E6' }],
  ]);
  return out;
}

/** The day before a company's first exported year: where the opening entry goes. */
export const openingDate = (c: FxCompany) => dayBefore(c.years[0]!.from);
