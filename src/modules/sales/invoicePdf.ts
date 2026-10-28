// The invoice or estimate as a PDF (AR-4, AR-8): the company's logo and
// details, the customer, the lines and totals, and the footer. US Letter,
// more pages for long documents. Drawn with pdf-lib in the worker.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { formatMoney, type Cents } from '../../shared/money';
import type { DocKind, DocLineInput } from './documents';
import { formatQuantity } from './math';

export interface PdfCompany {
  legalName: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  invoiceFooter?: string | null;
}

export interface PdfDoc {
  kind: DocKind;
  number: string;
  date: string;
  dueDate: string | null;
  termsDays: number | null;
  memo: string | null;
  customer: string;
  /** The customer's billing address, as typed (several lines) */
  customerAddress: string | null;
  lines: (DocLineInput & { itemName?: string | null })[];
  total: Cents;
  paid: Cents;
}

const PAGE = { width: 612, height: 792 }; // US Letter, points
const MARGIN = 54;
const INK = rgb(0.11, 0.12, 0.14);
const MUTED = rgb(0.38, 0.42, 0.47);
const RULE = rgb(0.8, 0.82, 0.85);
const ACCENT = rgb(0.12, 0.31, 0.47);

const SPECIALS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  ' ': ' ',
  '•': '-',
};

/** What the standard fonts can draw (WinAnsi): curly quotes straightened, the rest as "?". */
export function pdfText(s: string): string {
  return [...s]
    .map((ch) => {
      if (SPECIALS[ch]) return SPECIALS[ch];
      const c = ch.charCodeAt(0);
      if (ch === '\t') return ' ';
      return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) ? ch : '?';
    })
    .join('');
}

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
export const longDate = (iso: string) =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;

/** Words into lines no wider than `width`. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of pdfText(text).split(/\r?\n/)) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export async function renderDocPdf(
  doc: PdfDoc,
  company: PdfCompany,
  logoPng: Uint8Array | null,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const title = doc.kind === 'invoice' ? 'Invoice' : 'Estimate';
  pdf.setTitle(`${title} ${doc.number}`);
  pdf.setAuthor(pdfText(company.legalName));
  pdf.setCreator('EasyBooks');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = logoPng ? await pdf.embedPng(logoPng) : null;

  let page: PDFPage = pdf.addPage([PAGE.width, PAGE.height]);
  const right = PAGE.width - MARGIN;
  const text = (
    p: PDFPage,
    s: string,
    x: number,
    y: number,
    opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; align?: 'right' } = {},
  ) => {
    const font = opts.font ?? regular;
    const size = opts.size ?? 10;
    const t = pdfText(s);
    const at = opts.align === 'right' ? x - font.widthOfTextAtSize(t, size) : x;
    p.drawText(t, { x: at, y, size, font, color: opts.color ?? INK });
  };

  // ---- head: logo and company on the left, title and numbers on the right ----
  let y = PAGE.height - MARGIN;
  if (logo) {
    const scale = Math.min(170 / logo.width, 64 / logo.height, 1);
    const w = logo.width * scale;
    const h = logo.height * scale;
    page.drawImage(logo, { x: MARGIN, y: y - h, width: w, height: h });
    y -= h + 12;
  }
  text(page, company.legalName, MARGIN, y - 11, { font: bold, size: 12 });
  y -= 26;
  const cityLine = [company.city, [company.state, company.postalCode].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ');
  for (const l of [
    company.addressLine1,
    company.addressLine2,
    cityLine,
    company.phone,
    company.email,
    company.website,
  ].filter(Boolean) as string[]) {
    text(page, l, MARGIN, y, { color: MUTED, size: 9.5 });
    y -= 13;
  }

  let ry = PAGE.height - MARGIN;
  text(page, title.toUpperCase(), right, ry - 22, {
    font: bold,
    size: 24,
    color: ACCENT,
    align: 'right',
  });
  ry -= 46;
  const facts: [string, string][] = [
    [`${title} no.`, doc.number],
    ['Date', longDate(doc.date)],
  ];
  if (doc.kind === 'invoice' && doc.dueDate) facts.push(['Due', longDate(doc.dueDate)]);
  if (doc.kind === 'invoice' && doc.termsDays !== null) {
    facts.push(['Terms', doc.termsDays === 0 ? 'Due on receipt' : `Net ${doc.termsDays}`]);
  }
  for (const [label, value] of facts) {
    text(page, label, right - 110, ry, { color: MUTED, size: 9.5 });
    text(page, value, right, ry, { font: bold, size: 9.5, align: 'right' });
    ry -= 14;
  }

  // ---- bill to ----
  y = Math.min(y, ry) - 18;
  text(page, doc.kind === 'invoice' ? 'BILL TO' : 'FOR', MARGIN, y, {
    font: bold,
    size: 8.5,
    color: MUTED,
  });
  y -= 15;
  text(page, doc.customer, MARGIN, y, { font: bold, size: 11 });
  y -= 14;
  for (const l of doc.customerAddress ? wrap(doc.customerAddress, regular, 10, 260) : []) {
    text(page, l, MARGIN, y, { size: 10 });
    y -= 13;
  }

  // ---- lines ----
  const cols = { qty: right - 200, rate: right - 105, amount: right };
  const descWidth = cols.qty - 50 - MARGIN;
  const tableHead = (p: PDFPage, at: number) => {
    p.drawRectangle({
      x: MARGIN,
      y: at - 6,
      width: right - MARGIN,
      height: 20,
      color: rgb(0.95, 0.96, 0.98),
    });
    text(p, 'Description', MARGIN + 6, at, { font: bold, size: 9 });
    text(p, 'Qty', cols.qty, at, { font: bold, size: 9, align: 'right' });
    text(p, 'Rate', cols.rate, at, { font: bold, size: 9, align: 'right' });
    text(p, 'Amount', cols.amount - 6, at, { font: bold, size: 9, align: 'right' });
    return at - 24;
  };
  y = tableHead(page, y - 22);
  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    text(page, `${title} ${doc.number} (continued)`, MARGIN, PAGE.height - MARGIN, {
      color: MUTED,
      size: 9,
    });
    y = tableHead(page, PAGE.height - MARGIN - 30);
  };
  for (const l of doc.lines) {
    const label = [l.itemName, l.description]
      .filter((s, i, a) => s && a.indexOf(s) === i)
      .join(': ');
    const rows = wrap(label || '—', regular, 10, descWidth);
    if (y - rows.length * 13 < MARGIN + 60) newPage();
    rows.forEach((r, i) => text(page, r, MARGIN + 6, y - i * 13, { size: 10 }));
    if (l.quantity !== null)
      text(page, formatQuantity(l.quantity), cols.qty, y, { align: 'right' });
    if (l.rate !== null) text(page, formatMoney(l.rate), cols.rate, y, { align: 'right' });
    text(page, formatMoney(l.amount), cols.amount - 6, y, { align: 'right' });
    y -= rows.length * 13 + 6;
    page.drawLine({
      start: { x: MARGIN, y: y + 2 },
      end: { x: right, y: y + 2 },
      thickness: 0.5,
      color: RULE,
    });
    y -= 6;
  }

  // ---- totals ----
  const totals: [string, Cents, boolean][] = [
    [doc.kind === 'invoice' ? 'Total' : 'Estimate total', doc.total, doc.kind !== 'invoice'],
  ];
  if (doc.kind === 'invoice') {
    if (doc.paid) totals.push(['Paid', -doc.paid, false]);
    totals.push(['Balance due', doc.total - doc.paid, true]);
  }
  if (y - totals.length * 18 < MARGIN + 40) newPage();
  y -= 6;
  for (const [label, amount, strong] of totals) {
    text(page, label, cols.rate, y, {
      font: strong ? bold : regular,
      size: strong ? 11 : 10,
      align: 'right',
    });
    text(page, formatMoney(amount), cols.amount - 6, y, {
      font: strong ? bold : regular,
      size: strong ? 11 : 10,
      align: 'right',
    });
    y -= 18;
  }

  // ---- message and footer ----
  const tail = [doc.memo, company.invoiceFooter].filter(Boolean) as string[];
  for (const block of tail) {
    const rows = wrap(block, regular, 9.5, right - MARGIN);
    if (y - rows.length * 12 - 16 < MARGIN) newPage();
    y -= 12;
    for (const r of rows) {
      text(page, r, MARGIN, y, { size: 9.5, color: block === doc.memo ? INK : MUTED });
      y -= 12;
    }
  }

  // Page numbers when there's more than one
  const pages = pdf.getPages();
  if (pages.length > 1) {
    pages.forEach((p, i) =>
      text(p, `Page ${i + 1} of ${pages.length}`, right, MARGIN / 2, {
        size: 8,
        color: MUTED,
        align: 'right',
      }),
    );
  }
  return pdf.save();
}
