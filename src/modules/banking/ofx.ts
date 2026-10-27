// Bank and card statements in .qbo (QuickBooks Web Connect), which is OFX
// with an Intuit header (BK-1). Banks send OFX 1.x, an SGML dialect where
// value elements have no closing tag, or OFX 2.x, which is XML; one reader
// handles both by treating any element with text as a value. .ofx and .qfx
// files are the same format. Amounts become integer cents from their digits,
// never through floating point (CLAUDE.md rule 9).

import type { Cents } from '../../shared/money';

export interface OfxTransaction {
  /** The bank's id for the transaction (FITID), the key for duplicates (BK-6) */
  fitid: string | null;
  date: string;
  /** Debit minus credit for the account: deposits and card payments positive */
  amount: Cents;
  type: string | null;
  name: string | null;
  memo: string | null;
  checkNo: string | null;
}

export interface OfxStatement {
  kind: 'bank' | 'card';
  bankId: string | null;
  accountNumber: string;
  /** CHECKING, SAVINGS, MONEYMRKT, CREDITLINE… for bank accounts */
  accountType: string | null;
  currency: string | null;
  startDate: string | null;
  endDate: string | null;
  /** The bank's ledger balance at balanceDate, signed like amounts */
  balance: Cents | null;
  balanceDate: string | null;
  transactions: OfxTransaction[];
}

export class OfxError extends Error {
  override name = 'OfxError';
}

// ---- text ----

/** Decode a statement file, honouring the OFX 1.x CHARSET header or the XML encoding. */
export function decodeOfx(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  const xmlEncoding = /<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];
  const charset = /^\s*CHARSET\s*:\s*(\S+)/im.exec(head)?.[1];
  let label = 'utf-8';
  if (xmlEncoding) label = xmlEncoding;
  else if (charset === '1252') label = 'windows-1252';
  else if (charset && /^8859-?1$/i.test(charset)) label = 'iso-8859-1';
  else if (/^\s*ENCODING\s*:\s*USASCII/im.test(head)) label = 'windows-1252';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

const ENTITIES: Record<string, string> = {
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  amp: '&',
  nbsp: ' ',
};

function decodeEntities(s: string): string {
  return s.replace(/&(lt|gt|quot|apos|amp|nbsp|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) =>
    e[0] === '#'
      ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ENTITIES[e]!,
  );
}

// ---- tree ----

interface Node {
  name: string;
  value: string | null;
  children: Node[];
}

/**
 * Build the element tree. An element followed by text is a value (OFX 1.x
 * leaves its closing tag out; 2.x has one, which is skipped). An element
 * without text opens an aggregate, closed by its closing tag; a closing tag
 * also closes any aggregates left open inside it.
 */
function parseTree(text: string): Node {
  const start = text.search(/<OFX>/i);
  if (start < 0) throw new OfxError('This is not a bank statement file (.qbo, .ofx or .qfx).');
  const root: Node = { name: '#root', value: null, children: [] };
  const stack: Node[] = [root];
  const body = text.slice(start).replace(/<!--[\s\S]*?-->/g, '');
  for (const m of body.matchAll(/<(\/?)([A-Za-z0-9._]+)[^>]*>([^<]*)/g)) {
    const closing = m[1] === '/';
    const name = m[2]!.toUpperCase();
    const content = decodeEntities(m[3]!).trim();
    if (closing) {
      const i = stack.findLastIndex((n) => n.name === name);
      if (i > 0) stack.length = i;
      continue;
    }
    const node: Node = { name, value: null, children: [] };
    stack.at(-1)!.children.push(node);
    if (content !== '') node.value = content;
    else stack.push(node);
  }
  return root;
}

const child = (n: Node | undefined, name: string) => n?.children.find((c) => c.name === name);
const value = (n: Node | undefined, name: string) => child(n, name)?.value ?? null;

function findAll(n: Node, names: string[], out: Node[] = []): Node[] {
  for (const c of n.children) {
    if (names.includes(c.name)) out.push(c);
    else findAll(c, names, out);
  }
  return out;
}

// ---- values ----

/** "20250131", "20250131120000.000[-5:EST]" → "2025-01-31". */
export function ofxDate(text: string | null): string | null {
  const m = text ? /^(\d{4})(\d{2})(\d{2})/.exec(text.trim()) : null;
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * "-1234.56", "+5", "12.3400", "-1234,56" → cents. Null for anything else,
 * including fractions of a cent.
 */
export function ofxAmount(text: string | null): Cents | null {
  if (text === null) return null;
  let t = text.trim().replace(/^\+/, '');
  // A comma as the decimal separator, as some banks write it
  if (!t.includes('.') && /,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[2] === '' && !m[3])) return null;
  const fraction = (m[3] ?? '').padEnd(2, '0');
  if (/[^0]/.test(fraction.slice(2))) return null;
  const cents = BigInt(m[2] || '0') * 100n + BigInt(fraction.slice(0, 2));
  const n = Number(cents);
  if (!Number.isSafeInteger(n)) return null;
  return m[1] === '-' && n !== 0 ? -n : n;
}

const tidy = (s: string | null) => (s ? s.replace(/\s+/g, ' ').trim() || null : null);

function transaction(n: Node, where: string): OfxTransaction {
  const date = ofxDate(value(n, 'DTPOSTED')) ?? ofxDate(value(n, 'DTUSER'));
  if (!date) throw new OfxError(`${where}: a transaction has no valid date.`);
  const amount = ofxAmount(value(n, 'TRNAMT'));
  if (amount === null) {
    throw new OfxError(`${where}: the amount "${value(n, 'TRNAMT') ?? ''}" is not valid.`);
  }
  return {
    fitid: tidy(value(n, 'FITID')),
    date,
    amount,
    type: tidy(value(n, 'TRNTYPE')),
    name: tidy(value(n, 'NAME') ?? value(child(n, 'PAYEE'), 'NAME')),
    memo: tidy(value(n, 'MEMO')),
    checkNo: tidy(value(n, 'CHECKNUM')),
  };
}

function statement(n: Node): OfxStatement {
  const card = n.name === 'CCSTMTRS';
  const from = child(n, card ? 'CCACCTFROM' : 'BANKACCTFROM');
  const accountNumber = tidy(value(from, 'ACCTID'));
  if (!accountNumber) throw new OfxError('The statement does not say which account it is for.');
  const where = `Account ending ${accountNumber.slice(-4)}`;
  const list = child(n, 'BANKTRANLIST');
  const ledger = child(n, 'LEDGERBAL');
  const transactions = (list?.children ?? [])
    .filter((c) => c.name === 'STMTTRN')
    .map((t) => transaction(t, where))
    // A zero-amount line (some banks send them for holds) moves no money
    .filter((t) => t.amount !== 0);
  return {
    kind: card ? 'card' : 'bank',
    bankId: card ? null : tidy(value(from, 'BANKID')),
    accountNumber,
    accountType: card ? null : tidy(value(from, 'ACCTTYPE')),
    currency: tidy(value(n, 'CURDEF')),
    startDate: ofxDate(value(list, 'DTSTART')),
    endDate: ofxDate(value(list, 'DTEND')),
    balance: ofxAmount(value(ledger, 'BALAMT')),
    balanceDate: ofxDate(value(ledger, 'DTASOF')),
    transactions,
  };
}

/** Every bank and card statement in a .qbo, .ofx or .qfx file. */
export function parseOfx(text: string): OfxStatement[] {
  const root = parseTree(text);
  const statements = findAll(root, ['STMTRS', 'CCSTMTRS']).map(statement);
  if (statements.length === 0) {
    const status = findAll(root, ['STATUS'])[0];
    const message = value(status, 'MESSAGE');
    throw new OfxError(
      message
        ? `The file has no statement. The bank says: ${message}`
        : 'The file has no bank or credit card statement.',
    );
  }
  return statements;
}

/** Identifies the account across files: bank routing and account number, or the card. */
export function feedKey(s: Pick<OfxStatement, 'kind' | 'bankId' | 'accountNumber'>): string {
  return s.kind === 'card'
    ? `card:${s.accountNumber}`
    : `bank:${s.bankId ?? ''}:${s.accountNumber}`;
}

const TYPE_NAMES: Record<string, string> = {
  CHECKING: 'Checking',
  SAVINGS: 'Savings',
  MONEYMRKT: 'Money market',
  CREDITLINE: 'Line of credit',
  CD: 'CD',
};

/** "Checking ••7890", "Credit card ••1234": enough to recognise, without the full number. */
export function feedLabel(s: Pick<OfxStatement, 'kind' | 'accountType' | 'accountNumber'>): string {
  const kind =
    s.kind === 'card'
      ? 'Credit card'
      : ((s.accountType && TYPE_NAMES[s.accountType.toUpperCase()]) ?? 'Bank account');
  return `${kind} ••${s.accountNumber.slice(-4)}`;
}
