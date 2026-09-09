import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  Document,
  ListRegionsResponse,
  Region,
  TextLayer,
} from '../types/index.js';
import { buildInvoicePdf, buildPdf } from './fixtures.js';
import './setup.js';

/**
 * Text-layer extraction and highlight-mode regions.
 *
 * The fixture invoice places known strings at known coordinates, so these
 * assert on real extraction rather than a stub.
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

const UNKNOWN_UUID = '11111111-1111-4111-8111-111111111111';

async function upload(bytes: Buffer): Promise<Document> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'inv.pdf');

  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', body: form });
  const created = ((await response.json()) as ApiResponse<Document>).data;
  if (!created) throw new Error('upload failed');

  for (let i = 0; i < 60; i++) {
    const poll = await fetch(`${baseUrl}/api/documents/${created.id}`);
    const document = ((await poll.json()) as ApiResponse<Document>).data;
    if (document && document.status !== 'processing') return document;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('document never finished processing');
}

async function getTextLayer(
  documentId: string,
  pageNumber: number,
): Promise<{ status: number; payload: ApiResponse<TextLayer> }> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/text-layer/${pageNumber}`);
  return { status: response.status, payload: (await response.json()) as ApiResponse<TextLayer> };
}

async function highlight(
  documentId: string,
  rect: { x: number; y: number; width: number; height: number },
  fieldType = 'INVOICE_NUMBER',
): Promise<Region> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageNumber: 1, ...rect, fieldType, textSource: 'TEXT_LAYER' }),
  });
  const body = (await response.json()) as ApiResponse<{ region: Region }>;
  if (!body.data) throw new Error(`could not create region: ${JSON.stringify(body.error)}`);
  return body.data.region;
}

describe('GET /api/documents/:id/text-layer/:pageNumber', () => {
  it('returns every text run with normalised positions', async () => {
    const document = await upload(buildInvoicePdf());
    const { status, payload } = await getTextLayer(document.id, 1);

    expect(status).toBe(200);
    const layer = payload.data;
    expect(layer?.hasText).toBe(true);
    expect(layer?.pageWidth).toBe(612);
    expect(layer?.pageHeight).toBe(792);

    const texts = layer?.textItems.map((item) => item.text) ?? [];
    expect(texts).toContain('ACME Supply Co');
    expect(texts).toContain('Invoice No: INV-2026-0042');
    expect(texts).toContain('Total: 5040.00');

    for (const item of layer?.textItems ?? []) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.x + item.width).toBeLessThanOrEqual(1.001);
      expect(item.y + item.height).toBeLessThanOrEqual(1.001);
      expect(item.fontSize).toBeGreaterThan(0);
    }
  });

  it('places a run where the page actually draws it', async () => {
    const document = await upload(buildInvoicePdf());
    const { payload } = await getTextLayer(document.id, 1);

    // "ACME Supply Co" is drawn at 72pt from the left on a 612pt page, with a
    // 22pt font whose baseline sits 720pt up a 792pt page.
    const vendor = payload.data?.textItems.find((item) => item.text === 'ACME Supply Co');
    expect(vendor?.x).toBeCloseTo(72 / 612, 3);
    expect(vendor?.y).toBeCloseTo((792 - 720 - 22) / 792, 2);
    expect(vendor?.fontSize).toBeCloseTo(22, 1);
  });

  it('drops the zero-width markers pdf.js emits for line breaks', async () => {
    const document = await upload(buildInvoicePdf());
    const { payload } = await getTextLayer(document.id, 1);

    for (const item of payload.data?.textItems ?? []) {
      expect(item.text.trim()).not.toBe('');
    }
  });

  it('reports a page with no text as having none', async () => {
    // buildPdf writes a single short run; an empty string produces a page with
    // nothing selectable on it.
    const document = await upload(buildPdf(['']));
    const { payload } = await getTextLayer(document.id, 1);

    expect(payload.data?.hasText).toBe(false);
    expect(payload.data?.textItems).toEqual([]);
  });

  it('rejects an unknown document and an out-of-range page', async () => {
    const document = await upload(buildInvoicePdf());

    const missing = await getTextLayer(UNKNOWN_UUID, 1);
    expect(missing.status).toBe(404);
    expect(missing.payload.error?.code).toBe('DOCUMENT_NOT_FOUND');

    const past = await getTextLayer(document.id, 9);
    expect(past.status).toBe(404);
    expect(past.payload.error?.code).toBe('PAGE_NOT_FOUND');
  });
});

describe('highlighting the text layer', () => {
  it('fills the region text from the PDF at full confidence', async () => {
    const document = await upload(buildInvoicePdf());
    const region = await highlight(document.id, { x: 0.65, y: 0.105, width: 0.25, height: 0.02 });

    expect(region.textSource).toBe('TEXT_LAYER');
    expect(region.ocrStatus).toBe('DONE');
    expect(region.rawText).toBe('Invoice No: INV-2026-0042');
    // The document's own text, not a guess.
    expect(region.confidence).toBe(100);
  });

  /**
   * pdf.js emits a whole line as one run, so a user highlighting a few
   * characters produces a rectangle covering a fraction of it. Touching a line
   * anywhere must capture the whole field.
   */
  it('expands a partial selection to the whole run', async () => {
    const document = await upload(buildInvoicePdf());
    // A sliver over the "INV" part of "Invoice No: INV-2026-0042".
    const region = await highlight(document.id, {
      x: 0.75,
      y: 0.108,
      width: 0.02,
      height: 0.012,
    });

    expect(region.rawText).toBe('Invoice No: INV-2026-0042');
  });

  it('snaps the stored rectangle onto the text it captured', async () => {
    const document = await upload(buildInvoicePdf());
    const { payload } = await getTextLayer(document.id, 1);
    const run = payload.data?.textItems.find((item) => item.text === 'Total: 5040.00');
    expect(run).toBeDefined();

    const region = await highlight(
      document.id,
      { x: 0.7, y: 0.435, width: 0.02, height: 0.01 },
      'TOTAL',
    );

    expect(region.x).toBeCloseTo(run!.x, 3);
    expect(region.y).toBeCloseTo(run!.y, 3);
    expect(region.width).toBeCloseTo(run!.width, 3);
  });

  it('joins several lines in reading order', async () => {
    const document = await upload(buildInvoicePdf());
    const region = await highlight(
      document.id,
      { x: 0.64, y: 0.37, width: 0.3, height: 0.08 },
      'LINE_ITEMS',
    );

    expect(region.rawText).toBe('Subtotal: 4200.00\nTax: 840.00\nTotal: 5040.00');
  });

  it('keeps a neighbouring column out of the result', async () => {
    const document = await upload(buildInvoicePdf());
    // The right-hand totals block only; the left column sits at x < 0.29.
    const region = await highlight(
      document.id,
      { x: 0.64, y: 0.37, width: 0.3, height: 0.02 },
      'SUBTOTAL',
    );

    expect(region.rawText).toBe('Subtotal: 4200.00');
    expect(region.rawText).not.toContain('Consulting');
  });

  it('leaves a region over blank space unread, so OCR can still run', async () => {
    const document = await upload(buildInvoicePdf());
    const region = await highlight(
      document.id,
      { x: 0.1, y: 0.7, width: 0.2, height: 0.03 },
      'CUSTOM',
    );

    expect(region.textSource).toBe('NONE');
    expect(region.ocrStatus).toBe('PENDING');
    expect(region.rawText).toBeUndefined();
  });

  it('leaves a plain drawn region unread', async () => {
    const document = await upload(buildInvoicePdf());
    const response = await fetch(`${baseUrl}/api/documents/${document.id}/regions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageNumber: 1,
        x: 0.65,
        y: 0.105,
        width: 0.25,
        height: 0.02,
        fieldType: 'INVOICE_NUMBER',
      }),
    });
    const body = (await response.json()) as ApiResponse<{ region: Region }>;

    expect(body.data?.region.textSource).toBe('NONE');
    expect(body.data?.region.ocrStatus).toBe('PENDING');
  });

  it('rejects an unknown textSource', async () => {
    const document = await upload(buildInvoicePdf());
    const response = await fetch(`${baseUrl}/api/documents/${document.id}/regions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        pageNumber: 1,
        x: 0.1,
        y: 0.1,
        width: 0.2,
        height: 0.02,
        fieldType: 'TOTAL',
        textSource: 'MAGIC',
      }),
    });
    expect(response.status).toBe(400);
  });
});

describe('moving a text-layer region', () => {
  it('re-reads its text at the new position instead of clearing it', async () => {
    const document = await upload(buildInvoicePdf());
    const region = await highlight(document.id, { x: 0.65, y: 0.105, width: 0.25, height: 0.02 });
    expect(region.rawText).toBe('Invoice No: INV-2026-0042');

    // Slide it down onto the date line.
    const response = await fetch(
      `${baseUrl}/api/documents/${document.id}/regions/${region.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ y: 0.131 }),
      },
    );
    const body = (await response.json()) as ApiResponse<{ region: Region }>;

    expect(body.data?.region.textSource).toBe('TEXT_LAYER');
    expect(body.data?.region.ocrStatus).toBe('DONE');
    expect(body.data?.region.rawText).toBe('Date: 14 March 2026');
  });

  it('falls back to unread when moved onto blank space', async () => {
    const document = await upload(buildInvoicePdf());
    const region = await highlight(document.id, { x: 0.65, y: 0.105, width: 0.25, height: 0.02 });

    const response = await fetch(
      `${baseUrl}/api/documents/${document.id}/regions/${region.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ y: 0.72 }),
      },
    );
    const body = (await response.json()) as ApiResponse<{ region: Region }>;

    expect(body.data?.region.textSource).toBe('NONE');
    expect(body.data?.region.ocrStatus).toBe('PENDING');
    expect(body.data?.region.rawText).toBeUndefined();
  });

  it('keeps the text when only the field type changes', async () => {
    const document = await upload(buildInvoicePdf());
    const region = await highlight(document.id, { x: 0.65, y: 0.105, width: 0.25, height: 0.02 });

    const response = await fetch(
      `${baseUrl}/api/documents/${document.id}/regions/${region.id}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fieldType: 'PO_NUMBER' }),
      },
    );
    const body = (await response.json()) as ApiResponse<{ region: Region }>;

    expect(body.data?.region.rawText).toBe('Invoice No: INV-2026-0042');
    expect(body.data?.region.textSource).toBe('TEXT_LAYER');
  });

  it('appears in the document listing like any other region', async () => {
    const document = await upload(buildInvoicePdf());
    await highlight(document.id, { x: 0.65, y: 0.105, width: 0.25, height: 0.02 });

    const response = await fetch(`${baseUrl}/api/documents/${document.id}/regions`);
    const body = (await response.json()) as ApiResponse<ListRegionsResponse>;

    expect(body.data?.total).toBe(1);
    expect(body.data?.regions[0]?.textSource).toBe('TEXT_LAYER');
  });
});
