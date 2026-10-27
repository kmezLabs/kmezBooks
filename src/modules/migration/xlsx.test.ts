import { strToU8, zipSync } from 'fflate';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { amount, xlsx } from './testing/qboFixtures';
import { decimalToCents, decodeXml, readFirstSheet, serialToIsoDate } from './xlsx';

describe('decimalToCents (MG-2: amounts never pass through floating point)', () => {
  it.each([
    ['12500.0', 1_250_000],
    ['4250.2', 425_020],
    ['-654321.09', -65_432_109],
    ['0.0', 0],
    ['-0.004', 0],
    ['-12345.299999999999', -1_234_530],
    ['1.005', 101],
    ['1.5E-2', 2],
    ['1e5', 10_000_000],
    ['.5', 50],
  ])('%s → %i', (text, cents) => {
    expect(decimalToCents(text)).toBe(cents);
  });

  it('refuses text that is not a number', () => {
    for (const t of ['', '-', 'abc', '1.2.3', '$5']) expect(decimalToCents(t)).toBeNull();
  });

  it('reads back every amount QuickBooks writes', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1e13, max: 1e13 }), (cents) => {
        expect(decimalToCents(amount(cents))).toBe(cents);
      }),
    );
  });
});

describe('readFirstSheet', () => {
  it('reads shared strings, numbers as text, and literal formulas', () => {
    const sheet = readFirstSheet(
      xlsx('Trial Balance', [['Acme & Co'], null, ['Checking', { f: '1234.56' }, { n: '2045.0' }]]),
    );
    expect(sheet.name).toBe('Trial Balance');
    expect(sheet.rows.map((r) => r.r)).toEqual([1, 3]);
    expect(sheet.rows[0]!.cells[0]).toEqual({ text: 'Acme & Co', numeric: false });
    expect(sheet.rows[1]!.cells).toEqual([
      { text: 'Checking', numeric: false },
      { text: '1234.56', numeric: true },
      { text: '2045.0', numeric: true },
    ]);
  });

  it('leaves out formulas QuickBooks did not evaluate (totals)', () => {
    const sheet = readFirstSheet(xlsx('S', [['TOTAL', { f: '(B6)+(B7)' }]]));
    expect(sheet.rows[0]!.cells[1]).toBeUndefined();
  });

  it('reads inline strings, rich text and sheets found through the relationships file', () => {
    const files = {
      'xl/workbook.xml': `<workbook xmlns:r="r"><sheets><sheet name="Data" sheetId="1" r:id="rId7"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId7" Target="/xl/worksheets/data.xml"/></Relationships>`,
      'xl/sharedStrings.xml': `<sst><si><r><t>Rich </t></r><r><t>text</t></r><rPh><t>ignored</t></rPh></si></sst>`,
      'xl/worksheets/data.xml': `<worksheet><sheetData><row r="2"><c r="B2" t="inlineStr"><is><t>a &lt;b&gt; _x000D_</t></is></c><c r="C2" t="s"><v>0</v></c><c r="D2"/></row></sheetData></worksheet>`,
    };
    const bytes = zipSync(
      Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])),
    );
    const sheet = readFirstSheet(bytes);
    expect(sheet.name).toBe('Data');
    expect(sheet.rows[0]!.cells[1]!.text).toBe('a <b> \r');
    expect(sheet.rows[0]!.cells[2]!.text).toBe('Rich text');
    expect(sheet.rows[0]!.cells[3]).toBeUndefined();
  });

  it('says clearly when a file is not a workbook', () => {
    expect(() => readFirstSheet(strToU8('hello'))).toThrow(
      expect.objectContaining({ name: 'NotAWorkbookError' }),
    );
  });

  it('decodes entities and Excel date serials', () => {
    expect(decodeXml('&amp;lt; &#39; &#x41;')).toBe("&lt; ' A");
    expect(serialToIsoDate(45658)).toBe('2025-01-01');
  });
});
