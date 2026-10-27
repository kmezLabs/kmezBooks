// A small .xlsx reader for QuickBooks Online exports (MG-1, MG-2). It reads
// the first worksheet into rows of text cells. Numbers stay as the decimal
// text Excel stored, so amounts never pass through floating point (CLAUDE.md
// rule 9). Runs in the worker, which has no DOMParser, so the XML is read with
// patterns; Excel's own XML is regular enough for that.

import { strFromU8, unzipSync } from 'fflate';

export interface Cell {
  /** The cell's text, or for a number its decimal digits as stored ("4130.2", "1.5E-2"). */
  text: string;
  numeric: boolean;
}

export interface SheetRow {
  /** 1-based row number in the sheet */
  r: number;
  /** Indexed by column, 0 = A. Empty cells are undefined. */
  cells: (Cell | undefined)[];
}

export interface Sheet {
  name: string;
  rows: SheetRow[];
}

export class NotAWorkbookError extends Error {
  override name = 'NotAWorkbookError';
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** XML entities, then Excel's _xHHHH_ escapes for control characters. */
export function decodeXml(s: string): string {
  return s
    .replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) =>
      e[0] === '#'
        ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
        : ENTITIES[e]!,
    )
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const attr = (tag: string, name: string) =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** The text of every <t> in a string item, leaving out phonetic runs. */
function itemText(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += m[1] ?? '';
  }
  return decodeXml(out);
}

function sharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => itemText(m[1] ?? ''));
}

/** "AB12" → 27 (0-based column of AB). */
function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of /^[A-Z]+/.exec(ref)?.[0] ?? '') n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?$/;

function parseCell(tag: string, body: string, shared: string[]): Cell | undefined {
  const type = attr(tag, 't');
  const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
  const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(body)?.[1];
  switch (type) {
    case 's':
      return v === undefined ? undefined : { text: shared[Number(v)] ?? '', numeric: false };
    case 'inlineStr': {
      const is = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1];
      return is === undefined ? undefined : { text: itemText(is), numeric: false };
    }
    case 'str':
    case 'e':
      return v === undefined ? undefined : { text: decodeXml(v), numeric: false };
    case 'b':
      return v === undefined ? undefined : { text: v === '1' ? 'TRUE' : 'FALSE', numeric: false };
    default: {
      // QuickBooks writes report amounts as formulas holding the number
      // ("=1234.56") with a cached value of 0, so a literal formula wins.
      // A real formula (a total) has no trustworthy value here: leave it out.
      if (f !== undefined) {
        const literal = decodeXml(f).trim();
        if (NUMBER_LITERAL.test(literal)) return { text: literal, numeric: true };
        return undefined;
      }
      return v === undefined ? undefined : { text: v.trim(), numeric: true };
    }
  }
}

function parseSheet(xml: string, shared: string[]): SheetRow[] {
  const rows: SheetRow[] = [];
  let nextRow = 1;
  for (const m of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const r = Number(attr(m[0], 'r') ?? nextRow);
    nextRow = r + 1;
    const cells: (Cell | undefined)[] = [];
    let nextCol = 0;
    for (const c of (m[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[0], 'r');
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      const cell = parseCell(c[1] ?? '', c[2] ?? '', shared);
      if (cell && cell.text !== '') cells[col] = cell;
    }
    rows.push({ r, cells });
  }
  return rows;
}

/** Path of the workbook's first sheet, following the relationships file. */
function firstSheetPath(files: Record<string, Uint8Array>): { name: string; path: string } {
  const workbook = files['xl/workbook.xml'];
  if (!workbook) throw new NotAWorkbookError('This is not an Excel workbook.');
  const sheet = /<sheet\b[^>]*>/.exec(strFromU8(workbook))?.[0];
  if (!sheet) throw new NotAWorkbookError('The workbook has no sheets.');
  const name = decodeXml(attr(sheet, 'name') ?? 'Sheet1');
  const relId = attr(sheet, 'r:id');
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (relId && rels) {
    for (const rel of strFromU8(rels).matchAll(/<Relationship\b[^>]*>/g)) {
      if (attr(rel[0], 'Id') === relId) {
        const target = attr(rel[0], 'Target') ?? '';
        return { name, path: target.startsWith('/') ? target.slice(1) : `xl/${target}` };
      }
    }
  }
  return { name, path: 'xl/worksheets/sheet1.xml' };
}

/** Read the first worksheet of an .xlsx file. */
export function readFirstSheet(bytes: Uint8Array): Sheet {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new NotAWorkbookError('This is not an Excel (.xlsx) file.');
  }
  const { name, path } = firstSheetPath(files);
  const sheet = files[path];
  if (!sheet) throw new NotAWorkbookError('The workbook’s first sheet is missing.');
  const shared = sharedStrings(
    files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : undefined,
  );
  return { name, rows: parseSheet(strFromU8(sheet), shared) };
}

// ---- values ----

/**
 * A stored number ("4130.2", "-15436.299999999999", "1.5E-2") → integer cents,
 * rounded half away from zero, using only the digits. Null if it isn't a number.
 */
export function decimalToCents(text: string): number | null {
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([-+]?\d+))?$/.exec(text.trim());
  if (!m || (m[2] === '' && !m[3])) return null;
  const negative = m[1] === '-';
  let digits = (m[2] ?? '') + (m[3] ?? '');
  // Position of the decimal point within `digits`, after the exponent
  let point = (m[2] ?? '').length + Number(m[4] ?? 0);
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  digits = digits.padEnd(point + 3, '0');
  const whole = BigInt(digits.slice(0, point + 2) || '0');
  const next = Number(digits[point + 2]);
  const cents = whole + (next >= 5 ? 1n : 0n);
  const n = Number(cents);
  if (!Number.isSafeInteger(n)) return null;
  return negative && n !== 0 ? -n : n;
}

/** Excel's date serial (1900 system) → YYYY-MM-DD. */
export function serialToIsoDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}
