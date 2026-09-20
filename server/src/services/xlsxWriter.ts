import { deflateRawSync, crc32 } from 'node:zlib';

/**
 * A minimal .xlsx writer: one sheet, typed cells, no dependency.
 *
 * Why hand-rolled rather than a library. SheetJS's maintained builds are not
 * published to npm — the version there is years stale with open advisories —
 * and ExcelJS brings nine transitive packages, one of them flagged, to write a
 * single flat sheet. What is actually needed here is small and fully
 * specified: an .xlsx is a ZIP of a few XML parts, and writing numbers, dates
 * and strings into one worksheet is the easy corner of that specification.
 *
 * Why bother at all, when CSV opens in Excel: because CSV has no types. A
 * spreadsheet reading `INV-0042` guesses, `0042` loses its leading zeros, and
 * `03/04/2026` is silently reinterpreted by locale. Those are exactly the
 * values on an invoice, so the typed file is worth the pages below.
 *
 * Everything here is `deflate`d with Node's own zlib and framed by hand; the
 * tests read the result back with a real ZIP reader rather than trusting it.
 */

/**
 * What a cell holds.
 *
 * `{ amount }` and `{ date }` are tagged rather than inferred: a bare number
 * could be money or a count, and guessing from whether it happens to be whole
 * would format 1250 and 1250.50 differently in the same column.
 */
export type CellValue = string | number | { amount: number } | { date: string } | null;

export interface SheetOptions {
  /** Worksheet name, as shown on its tab. */
  name?: string;
  /** Column widths in characters, by column index. */
  widths?: number[];
}

/**
 * Build an .xlsx holding one sheet.
 *
 * The first row is the header and is written bold and frozen, because a
 * fifty-row export is read by scrolling.
 */
export function buildXlsx(
  header: readonly string[],
  rows: readonly (readonly CellValue[])[],
  options: SheetOptions = {},
): Buffer {
  const sheetName = sanitizeSheetName(options.name ?? 'Export');

  const files: ZipEntry[] = [
    { path: '[Content_Types].xml', data: Buffer.from(CONTENT_TYPES, 'utf8') },
    { path: '_rels/.rels', data: Buffer.from(ROOT_RELS, 'utf8') },
    { path: 'xl/workbook.xml', data: Buffer.from(workbookXml(sheetName), 'utf8') },
    { path: 'xl/_rels/workbook.xml.rels', data: Buffer.from(WORKBOOK_RELS, 'utf8') },
    { path: 'xl/styles.xml', data: Buffer.from(STYLES, 'utf8') },
    {
      path: 'xl/worksheets/sheet1.xml',
      data: Buffer.from(sheetXml(header, rows, options.widths ?? []), 'utf8'),
    },
  ];

  return zip(files);
}

// ---------------------------------------------------------------------------
// Worksheet
// ---------------------------------------------------------------------------

/**
 * Style indices into `STYLES` below: 0 plain, 1 bold (the header), 2 a date,
 * 3 an amount to two places.
 */
const STYLE_PLAIN = 0;
const STYLE_HEADER = 1;
const STYLE_DATE = 2;
const STYLE_AMOUNT = 3;

function sheetXml(
  header: readonly string[],
  rows: readonly (readonly CellValue[])[],
  widths: readonly number[],
): string {
  const cols =
    widths.length === 0
      ? ''
      : `<cols>${widths
          .map(
            (width, index) =>
              `<col min="${index + 1}" max="${index + 1}" width="${clampWidth(width)}" customWidth="1"/>`,
          )
          .join('')}</cols>`;

  const headerRow = `<row r="1">${header
    .map((text, index) => cell(index, 1, text, STYLE_HEADER))
    .join('')}</row>`;

  const body = rows
    .map((row, rowIndex) => {
      const number = rowIndex + 2;
      const cells = row
        .map((value, index) => cell(index, number, value, STYLE_PLAIN))
        .join('');
      return `<row r="${number}">${cells}</row>`;
    })
    .join('');

  // The pane freeze keeps the header in view; the autoFilter puts the
  // dropdowns on it that make a long export usable.
  const lastColumn = columnName(Math.max(header.length, 1) - 1);
  const lastRow = rows.length + 1;

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView workbookViewId="0" tabSelected="1">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `</sheetView></sheetViews>` +
    cols +
    `<sheetData>${headerRow}${body}</sheetData>` +
    `<autoFilter ref="A1:${lastColumn}${lastRow}"/>` +
    `</worksheet>`
  );
}

/**
 * One cell, typed.
 *
 * Strings go inline rather than through a shared-strings table: the table
 * saves space when values repeat, and an invoice export is nearly all distinct
 * values, so it would cost a whole extra part for nothing.
 */
function cell(index: number, row: number, value: CellValue, style: number): string {
  const ref = `${columnName(index)}${row}`;

  if (value === null || value === '') return '';

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    return `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  }

  if (typeof value === 'object') {
    if ('amount' in value) {
      if (!Number.isFinite(value.amount)) return '';
      return `<c r="${ref}" s="${STYLE_AMOUNT}"><v>${value.amount}</v></c>`;
    }

    const serial = dateSerial(value.date);
    if (serial === null) return inlineString(ref, value.date, style);
    return `<c r="${ref}" s="${STYLE_DATE}"><v>${serial}</v></c>`;
  }

  return inlineString(ref, value, style);
}

const inlineString = (ref: string, text: string, style: number): string =>
  `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;

/**
 * Days since 1899-12-30, which is how a spreadsheet stores a date.
 *
 * The epoch is two days before 1900-01-01 rather than one, because Excel
 * believes 1900 was a leap year and every file has agreed with it since.
 */
function dateSerial(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return null;

  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(utc)) return null;

  const epoch = Date.UTC(1899, 11, 30);
  return Math.round((utc - epoch) / 86_400_000);
}

/** 0 -> A, 25 -> Z, 26 -> AA. */
export function columnName(index: number): string {
  let name = '';
  let remaining = index;
  do {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
  } while (remaining >= 0);
  return name;
}

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters are not legal in XML 1.0 at all; tab, newline and
    // carriage return are the only ones below 0x20 that are.
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const clampWidth = (width: number): number =>
  Math.max(4, Math.min(80, Math.round(width * 100) / 100));

/** Sheet names may not carry `: \ / ? * [ ]`, nor exceed 31 characters. */
function sanitizeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31);
  return cleaned === '' ? 'Export' : cleaned;
}

// ---------------------------------------------------------------------------
// The fixed parts
// ---------------------------------------------------------------------------

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_RELS =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
  `</Relationships>`;

const workbookXml = (sheetName: string): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
  `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
  `</workbook>`;

/**
 * Four cell formats, in the order the STYLE_ constants name them.
 *
 * `numFmtId="164"` is the first id free for a custom format; 0-163 are
 * reserved by the specification for the built-ins.
 */
const STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
  `<fonts count="2">` +
  `<font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
  `</fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="4">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `</styleSheet>`;

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

interface ZipEntry {
  path: string;
  data: Buffer;
}

/**
 * A ZIP archive, deflated, written in one pass.
 *
 * Only what an .xlsx needs: no directory entries, no ZIP64, no encryption.
 * Sizes and CRCs are known before anything is written because every part is
 * already in memory, so the streaming data descriptor is not needed either.
 */
function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed: 2.0, deflate
    local.writeUInt16LE(0x0800, 6); // flags: names and text are UTF-8
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // modification time
    local.writeUInt16LE(0x2101, 12); // modification date: a fixed 1996-08-01
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length
    name.copy(local, 30);

    locals.push(local, compressed);

    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0); // central directory header
    directory.writeUInt16LE(20, 4); // version made by
    directory.writeUInt16LE(20, 6); // version needed
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(8, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x2101, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(entry.data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30); // extra
    directory.writeUInt16LE(0, 32); // comment
    directory.writeUInt16LE(0, 34); // disk number
    directory.writeUInt16LE(0, 36); // internal attributes
    directory.writeUInt32LE(0, 38); // external attributes
    directory.writeUInt32LE(offset, 42); // where its local header sits
    name.copy(directory, 46);

    central.push(directory);
    offset += local.length + compressed.length;
  }

  const centralBytes = Buffer.concat(central);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16); // where the directory starts
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBytes, end]);
}
