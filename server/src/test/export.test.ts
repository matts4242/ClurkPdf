import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  Batch,
  Document,
  ExportPayload,
  ExportRow,
  FieldType,
  IssueCode,
  Region,
} from '../types/index.js';
import {
  buildColumnarInvoicePdf,
  buildInvoicePdf,
  buildPdf,
  buildPositionedPdf,
} from './fixtures.js';

/**
 * Week 7 end to end: real PDFs through the real queue, out as four files.
 *
 * The CSV and XLSX are read back the way a spreadsheet would read them — the
 * workbook through an actual ZIP reader — rather than asserted against the
 * strings that produced them.
 */

let baseUrl: string;
let close: () => Promise<void>;
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-test-'));

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  const { startWorker } = await import('../queue/documentQueue.js');

  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  startWorker();

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  baseUrl = `http://127.0.0.1:${address.port}`;

  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

afterAll(async () => {
  await close?.();
  fs.rmSync(workdir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createBatch(name = 'March invoices'): Promise<Batch> {
  const response = await fetch(`${baseUrl}/api/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await response.json()) as ApiResponse<{ batch: Batch }>;
  return body.data!.batch;
}

async function uploadAndWait(
  bytes: Buffer,
  filename = 'invoice.pdf',
  batchId?: string,
): Promise<Document> {
  const form = new FormData();
  if (batchId !== undefined) form.append('batchId', batchId);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), filename);

  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', body: form });
  const created = ((await response.json()) as ApiResponse<Document>).data;
  if (!created) throw new Error('upload failed');

  for (let i = 0; i < 150; i += 1) {
    const poll = await fetch(`${baseUrl}/api/documents/${created.id}`);
    const document = ((await poll.json()) as ApiResponse<Document>).data;
    if (document && (document.status === 'ready' || document.status === 'error')) {
      return document;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`document ${created.id} was never processed`);
}

async function listRegions(documentId: string): Promise<Region[]> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions`);
  const body = (await response.json()) as ApiResponse<{ regions: Region[] }>;
  return body.data?.regions ?? [];
}

/** Correct one field's text, the way a person reviewing would. */
async function correct(documentId: string, fieldType: FieldType, text: string): Promise<void> {
  const region = (await listRegions(documentId)).find((r) => r.fieldType === fieldType);
  if (!region) throw new Error(`no ${fieldType} region on ${documentId}`);

  await fetch(`${baseUrl}/api/documents/${documentId}/regions/${region.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ correctedText: text }),
  });
}

const exportUrl = (batchId: string | null, query = ''): string =>
  batchId === null ? `${baseUrl}/api/exports${query}` : `${baseUrl}/api/batches/${batchId}/export${query}`;

async function exportJson(batchId: string | null, query = ''): Promise<ExportPayload> {
  const response = await fetch(exportUrl(batchId, query));
  if (!response.ok) throw new Error(`export failed: ${response.status}`);
  return (await response.json()) as ExportPayload;
}

async function exportFile(batchId: string | null, format: string): Promise<{
  buffer: Buffer;
  contentType: string;
  disposition: string;
}> {
  const response = await fetch(exportUrl(batchId, `?format=${format}`));
  if (!response.ok) throw new Error(`export failed: ${response.status}`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? '',
    disposition: response.headers.get('content-disposition') ?? '',
  };
}

const codes = (row: ExportRow): IssueCode[] => row.issues.map((issue) => issue.code);

const rowFor = (payload: ExportPayload, filename: string): ExportRow => {
  const row = payload.rows.find((candidate) => candidate.filename === filename);
  if (!row) throw new Error(`no row for ${filename} in ${payload.rows.map((r) => r.filename)}`);
  return row;
};

/** Parse a CSV into rows, handling the quoting the writer emits. */
function parseCsv(text: string): string[][] {
  const withoutBom = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < withoutBom.length; i += 1) {
    const char = withoutBom[i];
    if (quoted) {
      if (char === '"') {
        if (withoutBom[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\r') {
      // part of \r\n
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** An invoice whose subtotal and tax do not add up to its total. */
const brokenArithmeticInvoice = (): Buffer =>
  buildPositionedPdf([
    [72, 720, 22, 'Globex Industries'],
    [400, 720, 14, 'INVOICE'],
    [400, 695, 12, 'Invoice No: GX-500'],
    [400, 675, 12, 'Invoice Date: 2026-05-01'],
    [400, 480, 12, 'Subtotal: 1000.00'],
    [400, 460, 12, 'Tax: 200.00'],
    // Should be 1200.00.
    [400, 435, 14, 'Total: 9999.00'],
  ]);

// ---------------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------------

describe('flattening documents to rows', () => {
  it('puts one row per document, with the captured fields', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const payload = await exportJson(batch.id);

    expect(payload.rows).toHaveLength(1);
    const row = rowFor(payload, 'acme.pdf');
    expect(row.fields.invoice_number).toBe('INV-2026-0042');
    expect(row.fields.total).toBe('5040.00');
    expect(row.fields.vendor_name).toBe('ACME Supply Co');
    expect(row.parsed.total).toBe(5040);
    expect(row.parsed.invoiceDate).toBe('2026-03-14');
  });

  it('brings both capture modes through the same columns', async () => {
    // Week 3 OCR and Week 4 highlights are both Region rows, so exporting is
    // one query rather than a merge; this is what says so.
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const regions = await listRegions(document.id);
    expect(regions.some((region) => region.textSource === 'TEXT_LAYER')).toBe(true);

    const payload = await exportJson(batch.id);
    expect(rowFor(payload, 'acme.pdf').fields.total).toBe('5040.00');
  });

  it('prefers a human correction over what was read', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    await correct(document.id, 'INVOICE_NUMBER', 'CORRECTED-1');

    expect(rowFor(await exportJson(batch.id), 'acme.pdf').fields.invoice_number).toBe(
      'CORRECTED-1',
    );
  });

  it('gives a custom field its own column, named by its label', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    await fetch(`${baseUrl}/api/documents/${document.id}/regions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageNumber: 1,
        x: 0.1,
        y: 0.06,
        width: 0.3,
        height: 0.03,
        fieldType: 'CUSTOM',
        fieldLabel: 'Cost centre',
        textSource: 'TEXT_LAYER',
      }),
    });

    const payload = await exportJson(batch.id);
    expect(payload.columns).toContain('Cost centre');
    expect(rowFor(payload, 'acme.pdf').custom['Cost centre']).toBeTruthy();
  });

  it('leaves unprocessed documents out unless asked for', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const { getPrisma } = await import('../db/client.js');
    const stuck = await uploadAndWait(buildPdf(['Stuck']), 'stuck.pdf', batch.id);
    await getPrisma().document.update({
      where: { id: stuck.id },
      data: { status: 'queued' },
    });

    expect((await exportJson(batch.id)).rows).toHaveLength(1);

    const everything = await exportJson(batch.id, '?includeUnprocessed=true');
    expect(everything.rows).toHaveLength(2);
    expect(codes(rowFor(everything, 'stuck.pdf'))).toContain('NOT_PROCESSED');
  });

  it('reports the batch it covers and sums what parsed', async () => {
    const batch = await createBatch('April invoices');
    await uploadAndWait(buildInvoicePdf(), 'a.pdf', batch.id);
    await uploadAndWait(buildColumnarInvoicePdf(), 'b.pdf', batch.id);

    const payload = await exportJson(batch.id);

    expect(payload.batchName).toBe('April invoices');
    expect(payload.summary.documents).toBe(2);
    // 5040.00 + 1500.00
    expect(payload.summary.totalValue).toBe(6540);
  });

  it('404s for a batch that does not exist', async () => {
    const response = await fetch(
      `${baseUrl}/api/batches/00000000-0000-4000-8000-000000000000/export`,
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validation', () => {
  it('passes an invoice whose numbers add up', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    // 4200.00 + 840.00 = 5040.00
    expect(codes(rowFor(await exportJson(batch.id), 'acme.pdf'))).not.toContain(
      'TOTAL_MISMATCH',
    );
  });

  it('catches a total that does not match its parts', async () => {
    const batch = await createBatch();
    await uploadAndWait(brokenArithmeticInvoice(), 'globex.pdf', batch.id);

    const row = rowFor(await exportJson(batch.id), 'globex.pdf');

    expect(codes(row)).toContain('TOTAL_MISMATCH');
    expect(row.needsReview).toBe(true);
    const issue = row.issues.find((candidate) => candidate.code === 'TOTAL_MISMATCH');
    expect(issue?.severity).toBe('error');
    // The message says what it expected, so the row can be fixed without opening it.
    expect(issue?.message).toContain('1200.00');
  });

  it('catches an amount that cannot be read', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    await correct(document.id, 'TOTAL', 'see attached schedule');

    const row = rowFor(await exportJson(batch.id), 'acme.pdf');
    expect(codes(row)).toContain('INVALID_AMOUNT');
  });

  it('catches a date that cannot be read', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    await correct(document.id, 'INVOICE_DATE', 'last Tuesday');

    expect(codes(rowFor(await exportJson(batch.id), 'acme.pdf'))).toContain('INVALID_DATE');
  });

  it('catches a due date before its invoice date', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildColumnarInvoicePdf(), 'nw.pdf', batch.id);

    await correct(document.id, 'DUE_DATE', '2026-01-01');

    expect(codes(rowFor(await exportJson(batch.id), 'nw.pdf'))).toContain(
      'DUE_BEFORE_INVOICE',
    );
  });

  it('does not call a date wrong on an ambiguous reading', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildColumnarInvoicePdf(), 'nw.pdf', batch.id);

    // Both read day-first or month-first; ordering cannot be judged.
    await correct(document.id, 'INVOICE_DATE', '03/04/2026');
    await correct(document.id, 'DUE_DATE', '04/03/2026');

    expect(codes(rowFor(await exportJson(batch.id), 'nw.pdf'))).not.toContain(
      'DUE_BEFORE_INVOICE',
    );
  });

  it('warns about a field it never captured', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildPdf(['Barely an invoice']), 'thin.pdf', batch.id);

    const row = rowFor(await exportJson(batch.id), 'thin.pdf');
    const missing = row.issues.filter((issue) => issue.code === 'MISSING_FIELD');

    expect(missing.length).toBeGreaterThan(0);
    // Absent is a warning; contradictory is an error.
    expect(missing.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('counts errors and warnings separately in the summary', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'good.pdf', batch.id);
    await uploadAndWait(brokenArithmeticInvoice(), 'bad.pdf', batch.id);

    const payload = await exportJson(batch.id);

    expect(payload.summary.documents).toBe(2);
    expect(payload.summary.withErrors).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Formats
// ---------------------------------------------------------------------------

describe('CSV', () => {
  it('downloads with the columns as its header row', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const { buffer, contentType, disposition } = await exportFile(batch.id, 'csv');

    expect(contentType).toContain('text/csv');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('.csv');

    const rows = parseCsv(buffer.toString('utf8'));
    expect(rows[0]).toContain('invoice_number');
    expect(rows[0]).toContain('total');
    expect(rows[1]).toContain('INV-2026-0042');
  });

  it('starts with a byte-order mark, so a spreadsheet reads it as UTF-8', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const { buffer } = await exportFile(batch.id, 'csv');
    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  });

  it('quotes a value containing a comma or a newline', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    await correct(document.id, 'VENDOR_NAME', 'Smith, Jones & Co\nBristol');

    const { buffer } = await exportFile(batch.id, 'csv');
    const rows = parseCsv(buffer.toString('utf8'));
    const vendor = rows[0]!.indexOf('vendor_name');

    // Both survive the round trip, which is the whole point of quoting.
    expect(rows[1]![vendor]).toBe('Smith, Jones & Co\nBristol');
    // And the row did not split on the embedded newline.
    expect(rows).toHaveLength(2);
  });
});

describe('XLSX', () => {
  it('downloads a valid workbook', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const { buffer, contentType, disposition } = await exportFile(batch.id, 'xlsx');

    expect(contentType).toContain('spreadsheetml.sheet');
    expect(disposition).toContain('.xlsx');

    const file = path.join(workdir, 'export.xlsx');
    fs.writeFileSync(file, buffer);
    expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toContain(
      'No errors detected',
    );
  });

  it('writes amounts as numbers and dates as dates', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const { buffer } = await exportFile(batch.id, 'xlsx');
    const file = path.join(workdir, 'typed.xlsx');
    fs.writeFileSync(file, buffer);

    const sheet = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], {
      encoding: 'utf8',
    });

    // 5040.00 as a number, and 2026-03-14 as the serial a spreadsheet uses.
    expect(sheet).toContain('<v>5040</v>');
    expect(sheet).toContain('<v>46095</v>');
  });

  it('keeps an identifier as text, so its leading zeros survive', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    await correct(document.id, 'INVOICE_NUMBER', '0042');

    const { buffer } = await exportFile(batch.id, 'xlsx');
    const file = path.join(workdir, 'zeros.xlsx');
    fs.writeFileSync(file, buffer);

    const sheet = execFileSync('unzip', ['-p', file, 'xl/worksheets/sheet1.xml'], {
      encoding: 'utf8',
    });
    expect(sheet).toContain('>0042<');
  });
});

describe('XML', () => {
  it('downloads one element per document', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const { buffer, contentType } = await exportFile(batch.id, 'xml');
    const text = buffer.toString('utf8');

    expect(contentType).toContain('application/xml');
    expect(text).toContain('<invoices');
    expect(text).toContain('<invoice ');
    expect(text).toContain('<invoice_number>INV-2026-0042</invoice_number>');
  });

  it('carries a machine-readable value beside what was printed', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildColumnarInvoicePdf(), 'nw.pdf', batch.id);

    const { buffer } = await exportFile(batch.id, 'xml');
    const text = buffer.toString('utf8');

    // An ERP reads the attribute; the element keeps the invoice's own wording.
    expect(text).toContain('<total value="1500.00">1,500.00</total>');
    expect(text).toContain('<invoice_date value="2026-03-14">');
  });

  it('reports the issues once, as structure rather than as text too', async () => {
    const batch = await createBatch();
    await uploadAndWait(brokenArithmeticInvoice(), 'globex.pdf', batch.id);

    const { buffer } = await exportFile(batch.id, 'xml');
    const text = buffer.toString('utf8');

    expect(text).toContain('<issue severity="error" code="TOTAL_MISMATCH">');
    // `<issues>` opens the structured block and nothing else: it must never
    // also appear as a flat column carrying the same text.
    expect(text).not.toMatch(/<issues>\s*[^<\s]/);
    expect(text.match(/<issues>/g)).toHaveLength(1);
  });

  it('escapes what would otherwise break the document', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    await correct(document.id, 'VENDOR_NAME', 'Smith & Sons <Holdings>');

    const { buffer } = await exportFile(batch.id, 'xml');
    const text = buffer.toString('utf8');

    expect(text).toContain('Smith &amp; Sons &lt;Holdings&gt;');
    // And it still parses.
    expect(() =>
      execFileSync('python3', ['-c', 'import sys,xml.dom.minidom as m;m.parseString(sys.stdin.read())'], {
        input: text,
      }),
    ).not.toThrow();
  });

  it('turns a custom label into a legal element name', async () => {
    const batch = await createBatch();
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    await fetch(`${baseUrl}/api/documents/${document.id}/regions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pageNumber: 1,
        x: 0.1,
        y: 0.06,
        width: 0.3,
        height: 0.03,
        fieldType: 'CUSTOM',
        fieldLabel: '2026 cost centre',
        textSource: 'TEXT_LAYER',
      }),
    });

    const { buffer } = await exportFile(batch.id, 'xml');
    const text = buffer.toString('utf8');

    // An element may not begin with a digit or contain a space.
    expect(text).not.toContain('<2026 cost centre>');
    expect(text).toContain('cost_centre');
  });
});

describe('the export endpoints', () => {
  it('serves JSON inline rather than as a download', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const response = await fetch(`${baseUrl}/api/batches/${batch.id}/export?format=json`);

    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('content-disposition')).toBeNull();
  });

  it('serves JSON as a file when asked to', async () => {
    // A link's `download` attribute is ignored across origins, so the header
    // is what actually makes the JSON button download something.
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'acme.pdf', batch.id);

    const response = await fetch(
      `${baseUrl}/api/batches/${batch.id}/export?format=json&download=1`,
    );

    expect(response.headers.get('content-disposition')).toContain('attachment');
    expect(response.headers.get('content-disposition')).toContain('.json');
  });

  it('rejects a format it does not have', async () => {
    const batch = await createBatch();
    const response = await fetch(`${baseUrl}/api/batches/${batch.id}/export?format=pdf`);
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('exports everything held when no batch is named', async () => {
    const batch = await createBatch();
    await uploadAndWait(buildInvoicePdf(), 'a.pdf', batch.id);
    await uploadAndWait(buildColumnarInvoicePdf(), 'b.pdf');

    const payload = await exportJson(null);
    expect(payload.rows.length).toBeGreaterThanOrEqual(2);
  });

  it('exports only the documents it is given', async () => {
    const batch = await createBatch();
    const wanted = await uploadAndWait(buildInvoicePdf(), 'wanted.pdf', batch.id);
    await uploadAndWait(buildColumnarInvoicePdf(), 'other.pdf', batch.id);

    const payload = await exportJson(null, `?documentIds=${wanted.id}`);

    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]!.filename).toBe('wanted.pdf');
  });

  it('rejects a malformed document id', async () => {
    const response = await fetch(`${baseUrl}/api/exports?documentIds=not-a-uuid`);
    expect(response.status).toBe(400);
  });

  it('exports an empty batch as an empty set rather than failing', async () => {
    const batch = await createBatch('nothing here');
    const payload = await exportJson(batch.id);

    expect(payload.rows).toEqual([]);
    expect(payload.summary.documents).toBe(0);
    // A sum of nothing is unknown, not zero.
    expect(payload.summary.totalValue).toBeUndefined();

    // And every format still renders.
    for (const format of ['csv', 'xlsx', 'xml']) {
      const { buffer } = await exportFile(batch.id, format);
      expect(buffer.length).toBeGreaterThan(0);
    }
  });
});
