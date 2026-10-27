import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { formatPercent, percentToDecimal, type Report } from '../../shared/report';
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

  it('writes a % of Income column as percentages (RP-10)', () => {
    const withPercent: Report = {
      ...report,
      columns: [...report.columns, { label: '% of Income', numeric: true, unit: 'percent' }],
      rows: [
        { kind: 'section', depth: 0, cells: ['Income', null, null] },
        { kind: 'row', depth: 1, cells: ['Services', 2_000_00, 133_33] },
        { kind: 'row', depth: 1, cells: ['Refunds', -500_00, -33_33] },
        { kind: 'total', depth: 0, cells: ['Total Income', 1_500_00, 100_00] },
      ],
    };
    expect(reportToCsv(withPercent).split('\r\n').slice(5, 10)).toEqual([
      ',Total,% of Income',
      'Income,,',
      '"    Services",2000.00,133.33%',
      '"    Refunds",-500.00,-33.33%',
      'Total Income,1500.00,100.00%',
    ]);
    const files = unzipSync(reportToXlsx(withPercent));
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']!);
    expect(sheet).toContain('<c r="C8" s="6"><v>1.3333</v></c>');
    expect(sheet).toContain('<c r="C9" s="6"><v>-0.3333</v></c>');
    expect(sheet).toContain('<c r="C10" s="7"><v>1.0000</v></c>');
    expect(strFromU8(files['xl/styles.xml']!)).toContain('<cellXfs count="8">');
  });

  it('formats percentages from hundredths of a percent', () => {
    expect(formatPercent(0)).toBe('0.00%');
    expect(formatPercent(5)).toBe('0.05%');
    expect(formatPercent(-1_234)).toBe('-12.34%');
    expect(formatPercent(1_234_567)).toBe('12345.67%');
    expect(percentToDecimal(5)).toBe('0.0005');
    expect(percentToDecimal(-1_234)).toBe('-0.1234');
    expect(percentToDecimal(25_000)).toBe('2.5000');
  });

  it('makes a safe file name', () => {
    expect(reportFileName({ ...report, period: 'As of 1/31/2026' }, 'csv')).toBe(
      'Acme, -the best- LLC - Profit and Loss - As of 1-31-2026.csv',
    );
  });
});
