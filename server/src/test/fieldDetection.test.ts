import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResponse, Document, FieldType } from '../types/index.js';
import { buildPdf, buildSplitLabelInvoicePdf } from './fixtures.js';
import './setup.js';

/**
 * Field detection, against real PDFs.
 *
 * The batch tests cover the ordinary invoice where each label and its value
 * share one text run. These cover the two cases that layout does not make
 * obvious: a label whose value is a separate run to its right, and the pair of
 * dates that a naive pattern would confuse.
 */

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));

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
});

async function upload(bytes: Buffer): Promise<Document> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'inv.pdf');

  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', body: form });
  const created = ((await response.json()) as ApiResponse<Document>).data;
  if (!created) throw new Error('upload failed');
  return created;
}

async function detect(document: Document): Promise<Map<FieldType, string>> {
  const { detectFields } = await import('../services/fieldDetection.js');
  const fields = await detectFields(document.id, document.pageCount);
  return new Map(fields.map((field) => [field.fieldType, field.text]));
}

describe('detectFields', () => {
  it('reaches to the right for a value in its own run', async () => {
    const found = await detect(await upload(buildSplitLabelInvoicePdf()));

    expect(found.get('INVOICE_NUMBER')).toBe('Invoice Number NW-7781');
    expect(found.get('TOTAL')).toBe('Total 1290.50');
  });

  it('keeps the due date and the invoice date apart', async () => {
    const found = await detect(await upload(buildSplitLabelInvoicePdf()));

    expect(found.get('DUE_DATE')).toBe('Due Date 02 May 2026');
    // "Due Date" is claimed first, so the plain date line is the invoice date.
    expect(found.get('INVOICE_DATE')).toBe('Date 02 April 2026');
  });

  it('takes the largest text at the top of the page as the vendor', async () => {
    const found = await detect(await upload(buildSplitLabelInvoicePdf()));
    expect(found.get('VENDOR_NAME')).toBe('Northwind Trading');
  });

  it('finds nothing in a document with no invoice fields', async () => {
    const found = await detect(await upload(buildPdf(['just some prose'])));

    expect(found.has('INVOICE_NUMBER')).toBe(false);
    expect(found.has('TOTAL')).toBe(false);
    // The largest text on the page is still the best vendor guess there is.
    expect(found.get('VENDOR_NAME')).toBe('just some prose');
  });
});
