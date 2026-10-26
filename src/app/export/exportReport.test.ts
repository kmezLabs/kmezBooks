import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Report } from '../../shared/report';
import { reportFileName, reportToCsv, reportToXlsx } from './exportReport';

const report: Report = {
  kind: 'pl',
  title: 'Profit and Loss',
  company: 'Acme, "the best" LLC',
  period: 'January 1, 2026 – January 31, 2026',
  basis: 'Cash basis',
  generatedAt: '2026-10-26T12:00:00Z',
  notes: [],
  columns: [
    { label: '', numeric: false },
    { label: 'Total', numeric: true },
  ],
  rows: [
    { kind: 'section', depth: 0, cells: ['Income', null] },
    { kind: 'row', depth: 1, cells: ['Services', 1_234_567_89] },
    { kind: 'row', depth: 1, cells: ['Refunds & <returns>', -5] },
    { kind: 'total', depth: 0, cells: ['Total Income', 1_234_567_84] },
  ],
};

describe('report export (RP-6)', () => {
  it('writes CSV with plain decimals, indentation and quoting', () => {
    const csv = reportToCsv(report);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.split('\r\n')).toEqual([
      '﻿"Acme, ""the best"" LLC"',
      'Profit and Loss',
      '"January 1, 2026 – January 31, 2026"',
      'Cash basis',
      '',
      ',Total',
      'Income,',
      '"    Services",1234567.89',
      '"    Refunds & <returns>",-0.05',
      'Total Income,1234567.84',
      '',
    ]);
  });

  it('writes a valid xlsx package with numbers as numbers', () => {
    const files = unzipSync(reportToXlsx(report));
    expect(Object.keys(files).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<v>1234567.89</v>');
    expect(sheet).toContain('<v>-0.05</v>');
    expect(sheet).toContain('Refunds &amp; &lt;returns&gt;');
    expect(sheet).toContain('Acme, &quot;the best&quot; LLC');
    expect(strFromU8(files['xl/workbook.xml']!)).toContain('name="Profit and Loss"');
  });

  it('makes a safe file name', () => {
    expect(reportFileName({ ...report, period: 'As of 1/31/2026' }, 'csv')).toBe(
      'Acme, -the best- LLC - Profit and Loss - As of 1-31-2026.csv',
    );
  });
});
