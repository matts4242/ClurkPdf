import { writeToString } from 'fast-csv';
import type { ExportPayload, ExportRow } from '../types/index.js';
import { cellValue } from './exportService.js';
import { buildXlsx, type CellValue } from './xlsxWriter.js';

/**
 * Turning the flattened rows into the four files the spec asks for.
 *
 * JSON keeps the whole structure — issues, parsed numbers, the summary —
 * because something reading JSON can use it. The three tabular formats flatten
 * to the same columns as each other, so a CSV and an XLSX of one batch have
 * the same shape and anything built on one works on the other.
 */

export interface RenderedExport {
  body: Buffer;
  contentType: string;
  /** Suggested download name, without a directory. */
  filename: string;
}

/** Columns whose value is a number, when it parsed, rather than text. */
const NUMERIC = new Set(['subtotal', 'tax', 'total']);
const DATES = new Set(['invoice_date', 'due_date']);

export function toJson(payload: ExportPayload, name: string): RenderedExport {
  return {
    body: Buffer.from(JSON.stringify(payload, null, 2), 'utf8'),
    contentType: 'application/json; charset=utf-8',
    filename: `${name}.json`,
  };
}

/**
 * CSV, with a byte-order mark.
 *
 * The BOM is the difference between Excel showing `Café Rouge` and `CafÃ©
 * Rouge`: opened by double-click it assumes the system codepage unless the
 * file says otherwise, and three bytes at the front are the only way a CSV
 * has to say otherwise.
 */
export async function toCsv(payload: ExportPayload, name: string): Promise<RenderedExport> {
  const rows = payload.rows.map((row) =>
    payload.columns.map((column) => cellValue(row, column)),
  );

  const csv = await writeToString([[...payload.columns], ...rows], {
    // Excel's own convention, and harmless everywhere else.
    rowDelimiter: '\r\n',
  });

  return {
    body: Buffer.concat([Buffer.from('﻿', 'utf8'), Buffer.from(csv, 'utf8')]),
    contentType: 'text/csv; charset=utf-8',
    filename: `${name}.csv`,
  };
}

/**
 * XLSX, with amounts as numbers and dates as dates.
 *
 * This is the whole reason to offer it beside CSV: a spreadsheet given
 * `INV-0042` as text keeps it, and given a real date can sort by it.
 */
export function toXlsx(payload: ExportPayload, name: string): RenderedExport {
  const rows = payload.rows.map((row) =>
    payload.columns.map<CellValue>((column) => typedCell(row, column)),
  );

  const widths = payload.columns.map((column) =>
    Math.min(
      40,
      Math.max(
        column.length + 2,
        ...payload.rows.map((row) => Math.min(60, cellValue(row, column).length + 2)),
      ),
    ),
  );

  return {
    body: buildXlsx(payload.columns, rows, { name: 'Invoices', widths }),
    contentType:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    filename: `${name}.xlsx`,
  };
}

/**
 * The cell a spreadsheet should hold, typed where the value parsed.
 *
 * Only where it parsed: an amount that could not be read stays the text that
 * was captured, so the cell shows what is actually on the invoice rather than
 * going blank and hiding the problem.
 */
function typedCell(row: ExportRow, column: string): CellValue {
  const text = cellValue(row, column);
  if (text === '') return null;

  if (NUMERIC.has(column)) {
    const parsed = row.parsed[column as 'subtotal' | 'tax' | 'total'];
    // Tagged as money, so the column formats to two places throughout rather
    // than showing 1250 beside 1250.50.
    return parsed === undefined ? text : { amount: parsed };
  }

  if (DATES.has(column)) {
    const iso = column === 'invoice_date' ? row.parsed.invoiceDate : row.parsed.dueDate;
    return iso === undefined ? text : { date: iso };
  }

  return text;
}

/**
 * XML for an ERP, one `<invoice>` per document.
 *
 * Element names come from the same column list as the other formats, so the
 * custom fields a user named appear here too — sanitised, because an XML
 * element may not start with a digit and may not contain a space.
 */
export function toXml(payload: ExportPayload, name: string): RenderedExport {
  const invoices = payload.rows
    .map((row) => {
      const fields = payload.columns
        // `filename` is already an attribute, and the issues get their own
        // structured block below rather than being repeated as flat text.
        .filter((column) => column !== 'filename' && column !== 'issues')
        .map((column) => {
          const value = cellValue(row, column);
          if (value === '') return '';

          const tag = elementName(column);
          // An ERP wants a number it can read, and an auditor wants what was
          // printed on the invoice. The attribute carries the first without
          // losing the second.
          const normalised = machineValue(row, column);
          const attribute = normalised === null ? '' : ` value="${escapeXml(normalised)}"`;
          return `    <${tag}${attribute}>${escapeXml(value)}</${tag}>`;
        })
        .filter(Boolean)
        .join('\n');

      const issues = row.issues
        .map(
          (issue) =>
            `      <issue severity="${issue.severity}" code="${issue.code}">` +
            `${escapeXml(issue.message)}</issue>`,
        )
        .join('\n');

      return (
        `  <invoice id="${escapeXml(row.documentId)}" file="${escapeXml(row.filename)}">\n` +
        `${fields}\n` +
        (issues === '' ? '' : `    <issues>\n${issues}\n    </issues>\n`) +
        `  </invoice>`
      );
    })
    .join('\n');

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<invoices generated="${escapeXml(payload.generatedAt)}" count="${payload.rows.length}"` +
    (payload.batchName === undefined ? '' : ` batch="${escapeXml(payload.batchName)}"`) +
    `>\n${invoices}\n</invoices>\n`;

  return {
    body: Buffer.from(body, 'utf8'),
    contentType: 'application/xml; charset=utf-8',
    filename: `${name}.xml`,
  };
}

/**
 * The normalised form of a value, where there is one.
 *
 * `1,250.00` becomes `1250.00` and `14 March 2026` becomes `2026-03-14`, so a
 * consumer never has to guess at a separator convention or a date order.
 */
function machineValue(row: ExportRow, column: string): string | null {
  if (NUMERIC.has(column)) {
    const parsed = row.parsed[column as 'subtotal' | 'tax' | 'total'];
    return parsed === undefined ? null : parsed.toFixed(2);
  }
  if (DATES.has(column)) {
    const iso = column === 'invoice_date' ? row.parsed.invoiceDate : row.parsed.dueDate;
    return iso ?? null;
  }
  return null;
}

/**
 * A column key as a legal XML element name.
 *
 * The fixed columns are already snake_case and legal; only a user's custom
 * label can need this, and a label of "2026 reference" would otherwise
 * produce `<2026 reference>`, which no parser will read back.
 */
function elementName(column: string): string {
  const cleaned = column
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, '_')
    .replace(/^[^A-Za-z_]+/, '');
  return cleaned === '' ? 'field' : cleaned;
}

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** A filename stem for the download, from the batch name or the date. */
export function exportName(payload: ExportPayload): string {
  const stem =
    payload.batchName ?? `invoices-${payload.generatedAt.slice(0, 10)}`;
  const cleaned = stem
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned === '' ? 'invoices' : cleaned;
}
