// Report export (RP-6): CSV, Excel (.xlsx) and print/PDF. CSV and Excel are
// built here from the same Report the screen shows. Amounts go out as plain
// decimals made from cents with string formatting, never float arithmetic.

import { strToU8, zipSync } from 'fflate';
import { centsToDecimal } from '../../shared/money';
import type { Cell, Report, ReportRow } from '../../shared/report';

const INDENT = '    ';

function headerLines(r: Report): string[] {
  return [r.company, r.title, r.period, r.basis];
}

function textOf(row: ReportRow, i: number, cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return centsToDecimal(cell);
  return i === 0 ? INDENT.repeat(row.depth) + cell : cell;
}

// ---- CSV ----

function csvField(s: string): string {
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function reportToCsv(r: Report): string {
  const lines = [
    ...headerLines(r).map(csvField),
    '',
    r.columns.map((c) => csvField(c.label)).join(','),
    ...r.rows.map((row) => row.cells.map((cell, i) => csvField(textOf(row, i, cell))).join(',')),
    ...(r.notes.length ? ['', ...r.notes.map(csvField)] : []),
  ];
  // The byte-order mark makes Excel read the file as UTF-8
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// ---- Excel (.xlsx) ----

const xml = (s: string) =>
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

// Cell styles (indexes into cellXfs below)
const STYLE = { text: 0, title: 1, bold: 2, money: 3, moneyBold: 4, header: 5 } as const;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00;-#,##0.00"/></numFmts>
<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="2"><border/><border><bottom style="thin"/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>
</cellXfs>
</styleSheet>`;

function sheetXml(r: Report): string {
  const rows: string[] = [];
  let n = 0;
  const textCell = (col: number, text: string, style: number) =>
    `<c r="${colName(col)}${n}" t="inlineStr" s="${style}"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
  const numCell = (col: number, cents: number, style: number) =>
    `<c r="${colName(col)}${n}" s="${style}"><v>${centsToDecimal(cents)}</v></c>`;
  const addRow = (cells: string[]) => rows.push(`<row r="${n}">${cells.join('')}</row>`);

  headerLines(r).forEach((line, i) => {
    n++;
    addRow([textCell(0, line, i === 1 ? STYLE.title : STYLE.text)]);
  });
  n++;
  n++;
  addRow(r.columns.map((c, i) => textCell(i, c.label, STYLE.header)));
  for (const row of r.rows) {
    n++;
    const bold = row.kind !== 'row';
    addRow(
      row.cells.flatMap((cell, i) => {
        if (cell === null) return [];
        if (typeof cell === 'number')
          return [numCell(i, cell, bold ? STYLE.moneyBold : STYLE.money)];
        return [textCell(i, textOf(row, i, cell), bold ? STYLE.bold : STYLE.text)];
      }),
    );
  }
  for (const note of r.notes) {
    n += 1;
    addRow([textCell(0, note, STYLE.text)]);
  }
  const widths = r.columns
    .map(
      (c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${i === 0 ? 44 : c.numeric ? 16 : 22}" customWidth="1"/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>${widths}</cols><sheetData>${rows.join('')}</sheetData></worksheet>`;
}

export function reportToXlsx(r: Report): Uint8Array {
  const sheetName = xml(r.title.slice(0, 31));
  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${sheetName}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml': STYLES_XML,
    'xl/worksheets/sheet1.xml': sheetXml(r),
  };
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])),
  );
}

// ---- files ----

export function reportFileName(r: Report, extension: string): string {
  const name = `${r.company} - ${r.title} - ${r.period}`
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ');
  return `${name.slice(0, 150)}.${extension}`;
}

export function download(fileName: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
