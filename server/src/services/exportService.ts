import { getPrisma } from '../db/client.js';
import type {
  DocumentStatus,
  ExportField,
  ExportPayload,
  ExportRow,
  ExportSummary,
  FieldType,
  ValidationIssue,
} from '../types/index.js';
import { EXPORT_FIELDS } from '../types/index.js';
import { batchNotFound } from '../utils/errors.js';
import { parseAmount, parseDate, toPence } from './fieldValues.js';

/**
 * Flattening captured work into one row per document, and checking it.
 *
 * This is the first point in the project where the two capture modes have to
 * agree. They already do: a drawn region read by OCR and a highlighted span
 * taken from the PDF's own text are both `Region` rows with a `fieldType`, so
 * exporting is one query and a pivot rather than a merge of two shapes.
 *
 * The checking is the other half. Fifty invoices export as fifty rows whether
 * or not the numbers make sense, and the value of the export is knowing which
 * three to open — so every row carries what is wrong with it, and an error is
 * kept distinct from a thing merely worth a look.
 */

/** Which region field type fills which column. CUSTOM is handled separately. */
const FIELD_COLUMN: Record<Exclude<FieldType, 'CUSTOM'>, ExportField> = {
  VENDOR_NAME: 'vendor_name',
  VENDOR_ADDRESS: 'vendor_address',
  INVOICE_NUMBER: 'invoice_number',
  INVOICE_DATE: 'invoice_date',
  DUE_DATE: 'due_date',
  PO_NUMBER: 'po_number',
  SUBTOTAL: 'subtotal',
  TAX: 'tax',
  TOTAL: 'total',
  LINE_ITEMS: 'line_items',
};

/** Fields whose absence is worth flagging. A receipt may lack the others. */
const EXPECTED: ExportField[] = ['vendor_name', 'invoice_number', 'total'];

/** Below this, a reading is worth a second look. Matches the Week 3 banding. */
const LOW_CONFIDENCE = 70;

export interface BuildExportOptions {
  /** Limit to one batch. */
  batchId?: string;
  /** Or to these documents. */
  documentIds?: readonly string[];
  /**
   * Include documents the queue has not finished with. Off by default: a
   * queued document has no fields yet and would export as an empty row.
   */
  includeUnprocessed?: boolean;
}

/**
 * Build the whole export.
 *
 * One query. The regions come back with their documents, so the pivot below
 * never goes back to the database per row.
 */
export async function buildExport(options: BuildExportOptions = {}): Promise<ExportPayload> {
  const { batchId, documentIds, includeUnprocessed = false } = options;

  if (batchId !== undefined) {
    const batch = await getPrisma().batch.findUnique({
      where: { id: batchId },
      select: { id: true },
    });
    if (!batch) throw batchNotFound(batchId);
  }

  const documents = await getPrisma().document.findMany({
    where: {
      ...(batchId === undefined ? {} : { batchId }),
      ...(documentIds === undefined ? {} : { id: { in: [...documentIds] } }),
      ...(includeUnprocessed ? {} : { status: 'ready' }),
    },
    orderBy: { createdAt: 'asc' },
    include: {
      regions: { orderBy: [{ pageNumber: 'asc' }, { createdAt: 'asc' }] },
      batch: { select: { name: true } },
      template: { select: { name: true } },
    },
  });

  const rows = documents.map(toRow);

  return {
    generatedAt: new Date().toISOString(),
    ...(batchId === undefined ? {} : { batchId }),
    ...(documents[0]?.batch?.name === undefined || batchId === undefined
      ? {}
      : { batchName: documents[0].batch.name }),
    summary: summarise(rows),
    columns: columnsFor(rows),
    rows,
  };
}

// ---------------------------------------------------------------------------
// Pivot
// ---------------------------------------------------------------------------

type DocumentWithRegions = {
  id: string;
  originalName: string;
  status: string;
  pageCount: number;
  createdAt: Date;
  batch: { name: string } | null;
  template: { name: string } | null;
  regions: {
    fieldType: string;
    fieldLabel: string | null;
    rawText: string | null;
    correctedText: string | null;
    confidence: number | null;
    ocrStatus: string;
  }[];
};

function toRow(document: DocumentWithRegions): ExportRow {
  const fields: Partial<Record<ExportField, string>> = {};
  const custom: Record<string, string> = {};
  let lowest: { confidence: number; field: string } | null = null;
  let unread = 0;

  for (const region of document.regions) {
    // A correction is the human's word on it and always wins.
    const text = (region.correctedText ?? region.rawText ?? '').trim();

    if (text === '') {
      unread += 1;
      continue;
    }

    if (region.fieldType === 'CUSTOM') {
      const label = region.fieldLabel?.trim();
      if (label) custom[label] = append(custom[label], text);
    } else {
      const column = FIELD_COLUMN[region.fieldType as Exclude<FieldType, 'CUSTOM'>];
      if (column) fields[column] = append(fields[column], text);
    }

    // A human correction is trusted, so it does not drag the confidence down.
    if (region.correctedText === null && region.confidence !== null) {
      if (lowest === null || region.confidence < lowest.confidence) {
        lowest = {
          confidence: region.confidence,
          field:
            region.fieldType === 'CUSTOM'
              ? (region.fieldLabel?.trim() ?? 'custom')
              : (FIELD_COLUMN[region.fieldType as Exclude<FieldType, 'CUSTOM'>] ??
                region.fieldType),
        };
      }
    }
  }

  const parsed = parseFields(fields);
  const issues = validate({
    status: document.status as DocumentStatus,
    fields,
    parsed,
    lowest,
    unread,
  });

  return {
    documentId: document.id,
    filename: document.originalName,
    status: document.status as DocumentStatus,
    pages: document.pageCount,
    uploadedAt: document.createdAt.toISOString(),
    ...(document.batch?.name === undefined ? {} : { batchName: document.batch.name }),
    ...(document.template?.name === undefined ? {} : { templateName: document.template.name }),
    fields,
    custom,
    parsed,
    issues,
    needsReview: issues.length > 0,
  };
}

/**
 * Two regions of the same type on one document.
 *
 * Rare — the UI offers one of each — but a two-page invoice with a total on
 * both pages would do it, and silently dropping one would be worse than
 * showing both.
 */
const append = (existing: string | undefined, text: string): string =>
  existing === undefined || existing === '' ? text : `${existing}\n${text}`;

// ---------------------------------------------------------------------------
// Parsing and validation
// ---------------------------------------------------------------------------

function parseFields(fields: Partial<Record<ExportField, string>>): ExportRow['parsed'] {
  const subtotal = parseAmount(fields.subtotal);
  const tax = parseAmount(fields.tax);
  const total = parseAmount(fields.total);
  const invoiceDate = parseDate(fields.invoice_date);
  const dueDate = parseDate(fields.due_date);

  return {
    ...(subtotal === null ? {} : { subtotal: subtotal.value }),
    ...(tax === null ? {} : { tax: tax.value }),
    ...(total === null ? {} : { total: total.value }),
    ...(invoiceDate === null ? {} : { invoiceDate: invoiceDate.iso }),
    ...(dueDate === null ? {} : { dueDate: dueDate.iso }),
  };
}

interface ValidationInput {
  status: DocumentStatus;
  fields: Partial<Record<ExportField, string>>;
  parsed: ExportRow['parsed'];
  /** The least confident reading on the row, and which field it was. */
  lowest: { confidence: number; field: string } | null;
  unread: number;
}

/**
 * Everything wrong with one row.
 *
 * The cross-field arithmetic is the check worth having: a subtotal and a tax
 * that do not add up to the total means one of the three was read off the
 * wrong line, and no amount of per-field plausibility would catch it.
 */
export function validate(input: ValidationInput): ValidationIssue[] {
  const { status, fields, parsed, lowest, unread } = input;
  const issues: ValidationIssue[] = [];

  if (status !== 'ready') {
    issues.push({
      code: 'NOT_PROCESSED',
      severity: 'error',
      message: `The queue has not finished with this document (${status})`,
    });
  }

  for (const field of EXPECTED) {
    if (fields[field] === undefined) {
      issues.push({
        code: 'MISSING_FIELD',
        severity: 'warning',
        field,
        message: `No ${field.replace(/_/g, ' ')} was captured`,
      });
    }
  }

  // Present but unreadable: worse than absent, because a row that looks filled
  // in is the one nobody checks.
  for (const field of ['subtotal', 'tax', 'total'] as const) {
    if (fields[field] !== undefined && parsed[field] === undefined) {
      issues.push({
        code: 'INVALID_AMOUNT',
        severity: 'error',
        field,
        message: `"${fields[field]}" is not an amount`,
      });
    }
  }

  const dateChecks = [
    ['invoice_date', 'invoiceDate'],
    ['due_date', 'dueDate'],
  ] as const;
  for (const [field, key] of dateChecks) {
    if (fields[field] !== undefined && parsed[key] === undefined) {
      issues.push({
        code: 'INVALID_DATE',
        severity: 'error',
        field,
        message: `"${fields[field]}" is not a date`,
      });
    }
  }

  // Subtotal + tax = total, to the penny.
  const { subtotal, tax, total } = parsed;
  if (subtotal !== undefined && total !== undefined) {
    const expected = toPence(subtotal) + toPence(tax ?? 0);
    if (expected !== toPence(total)) {
      issues.push({
        code: 'TOTAL_MISMATCH',
        severity: 'error',
        field: 'total',
        message:
          `Subtotal ${subtotal.toFixed(2)} plus tax ${(tax ?? 0).toFixed(2)} ` +
          `is ${(expected / 100).toFixed(2)}, not ${total.toFixed(2)}`,
      });
    }
  }

  // Only when both dates were unambiguous: a numeric date read day-first could
  // be wrong, and reporting an error on a guess would be worse than silence.
  const invoiceDate = parseDate(fields.invoice_date);
  const dueDate = parseDate(fields.due_date);
  if (
    invoiceDate?.unambiguous === true &&
    dueDate?.unambiguous === true &&
    dueDate.date.getTime() < invoiceDate.date.getTime()
  ) {
    issues.push({
      code: 'DUE_BEFORE_INVOICE',
      severity: 'error',
      field: 'due_date',
      message: `Due ${dueDate.iso} is before the invoice date ${invoiceDate.iso}`,
    });
  }

  if (lowest !== null && lowest.confidence < LOW_CONFIDENCE) {
    // Naming the field is what makes this worth reporting: without it the
    // warning fires on most rows and says nothing about where to look.
    issues.push({
      code: 'LOW_CONFIDENCE',
      severity: 'warning',
      field: lowest.field,
      message: `${lowest.field.replace(/_/g, ' ')} was read at ${Math.round(
        lowest.confidence,
      )}% confidence`,
    });
  }

  if (unread > 0) {
    issues.push({
      code: 'UNREAD_REGION',
      severity: 'warning',
      message: `${unread} region${unread === 1 ? ' has' : 's have'} no text yet`,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

/**
 * The column keys, in order: metadata, the fixed fields, then whatever custom
 * labels this particular set of documents happens to use.
 *
 * Custom columns vary per export by design — they are named by the user, and a
 * fixed schema could not hold them.
 */
export function columnsFor(rows: readonly ExportRow[]): string[] {
  const customLabels = new Set<string>();
  for (const row of rows) {
    for (const label of Object.keys(row.custom)) customLabels.add(label);
  }

  return [
    'filename',
    ...EXPORT_FIELDS,
    ...[...customLabels].sort((a, b) => a.localeCompare(b)),
    'needs_review',
    'issues',
  ];
}

/** One row's value for one column, as the text a spreadsheet cell holds. */
export function cellValue(row: ExportRow, column: string): string {
  switch (column) {
    case 'filename':
      return row.filename;
    case 'needs_review':
      return row.needsReview ? 'yes' : 'no';
    case 'issues':
      return row.issues.map((issue) => `${issue.severity}: ${issue.message}`).join('; ');
    default:
      break;
  }

  if ((EXPORT_FIELDS as readonly string[]).includes(column)) {
    return row.fields[column as ExportField] ?? '';
  }
  return row.custom[column] ?? '';
}

function summarise(rows: readonly ExportRow[]): ExportSummary {
  let withErrors = 0;
  let withWarnings = 0;
  let totalPence = 0;
  let counted = 0;

  for (const row of rows) {
    const hasError = row.issues.some((issue) => issue.severity === 'error');
    if (hasError) withErrors += 1;
    else if (row.issues.length > 0) withWarnings += 1;

    if (row.parsed.total !== undefined) {
      totalPence += toPence(row.parsed.total);
      counted += 1;
    }
  }

  const currencies = new Set(
    rows
      .map((row) => parseAmount(row.fields.total)?.currency)
      .filter((currency): currency is string => currency !== undefined),
  );

  return {
    documents: rows.length,
    withErrors,
    withWarnings,
    // Only when something parsed; a sum of nothing is not zero, it is unknown.
    ...(counted === 0 ? {} : { totalValue: totalPence / 100 }),
    // Adding pounds to euros would be a lie, so the total goes uncurrencied
    // unless every row agreed.
    ...(currencies.size === 1 ? { currency: [...currencies][0] as string } : {}),
  };
}
