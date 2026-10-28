import { unzlibSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { pdfText, renderDocPdf, type PdfDoc } from './invoicePdf';

const company = {
  legalName: 'Acme Child Care LLC',
  addressLine1: '1 Main St',
  city: 'Alpharetta',
  state: 'GA',
  postalCode: '30005',
  email: 'office@acme.example',
  invoiceFooter: 'Pay by check to Acme Child Care LLC, or by Zelle to office@acme.example.',
};

const invoice = (lines = 2): PdfDoc => ({
  kind: 'invoice',
  number: '1042',
  date: '2026-01-05',
  dueDate: '2026-01-20',
  termsDays: 15,
  memo: 'Thank you for choosing us!',
  customer: 'Smith Family',
  customerAddress: '12 Oak Lane\nRoswell, GA 30075',
  lines: Array.from({ length: lines }, (_, i) => ({
    itemId: null,
    itemName: 'Tuition',
    description: `Week ${i + 1} – “full day”`,
    quantity: 2500,
    rate: 380_00,
    amount: 950_00,
    incomeAccountId: 'x',
  })),
  total: lines * 950_00,
  paid: 500_00,
});

/** The text drawn on the pages: each content stream inflated, its hex strings decoded. */
function textOf(bytes: Uint8Array): string {
  const raw = new TextDecoder('latin1').decode(bytes);
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    let content: string;
    try {
      content = new TextDecoder('latin1').decode(unzlibSync(bytes.subarray(start, end)));
    } catch {
      content = raw.slice(start, end);
    }
    for (const h of content.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
      out.push(
        h[1]!
          .match(/../g)!
          .map((b) => String.fromCharCode(parseInt(b, 16)))
          .join(''),
      );
    }
    for (const t of content.matchAll(/\(((?:[^()\\]|\\.)*)\)\s*Tj/g)) out.push(t[1]!);
    re.lastIndex = end + 'endstream'.length;
  }
  return out.join('\n');
}

describe('invoice PDF (AR-4, AR-8)', () => {
  it('draws the company, customer, lines, totals, message and footer on one page', async () => {
    const bytes = await renderDocPdf(invoice(), company, null);
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
    expect(loaded.getTitle()).toBe('Invoice 1042');
    const text = textOf(bytes);
    for (const s of [
      'INVOICE',
      '1042',
      'Jan 20, 2026',
      'Net 15',
      'Acme Child Care LLC',
      'office@acme.example',
      'Smith Family',
      'Roswell, GA 30075',
      'Tuition: Week 1 - "full day"',
      '2.5',
      '380.00',
      '1,900.00',
      '-500.00',
      '1,400.00',
      'Thank you for choosing us!',
      'Pay by check',
    ]) {
      expect(text, s).toContain(s);
    }
  });

  it('continues a long invoice on more pages, numbered', async () => {
    const bytes = await renderDocPdf(invoice(60), company, null);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
    const text = textOf(bytes);
    expect(text).toContain('Invoice 1042 (continued)');
    expect(text).toContain(`Page 1 of ${loaded.getPageCount()}`);
  });

  it('titles an estimate as one, without a balance due', async () => {
    const bytes = await renderDocPdf({ ...invoice(), kind: 'estimate', paid: 0 }, company, null);
    const text = textOf(bytes);
    expect(text).toContain('ESTIMATE');
    expect(text).toContain('Estimate total');
    expect(text).not.toContain('Balance due');
  });

  it('keeps to what the standard fonts can draw', () => {
    expect(pdfText('“Café” – 5…')).toBe('"Café" - 5...');
    expect(pdfText('日本 🙂')).toBe('?? ?');
  });
});
