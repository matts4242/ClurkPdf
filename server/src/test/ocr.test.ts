import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApiResponse, Document, ListRegionsResponse, Region, RunOcrResponse } from '../types/index.js';
import { buildInvoicePdf } from './fixtures.js';
import './setup.js';

/**
 * OCR tests.
 *
 * These run Tesseract for real against a generated invoice whose text we
 * chose, so the assertions are on actual recognition rather than a stub. The
 * first run downloads the language data, which is why the timeouts are
 * generous.
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
  const { terminateOcr } = await import('../services/ocrService.js');
  await terminateOcr();
});

const UNKNOWN_UUID = '11111111-1111-4111-8111-111111111111';

async function uploadInvoice(): Promise<Document> {
  const form = new FormData();
  const bytes = buildInvoicePdf();
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

/** Rectangles over the known fields of the generated invoice. */
const FIELDS = {
  vendor: { x: 0.1, y: 0.06, width: 0.35, height: 0.045, fieldType: 'VENDOR_NAME' },
  invoiceNumber: { x: 0.63, y: 0.108, width: 0.34, height: 0.03, fieldType: 'INVOICE_NUMBER' },
  total: { x: 0.63, y: 0.435, width: 0.3, height: 0.032, fieldType: 'TOTAL' },
  /** Deliberately over blank space, to show a low-signal read. */
  blank: { x: 0.1, y: 0.8, width: 0.2, height: 0.03, fieldType: 'CUSTOM' },
} as const;

async function addRegion(
  documentId: string,
  field: { x: number; y: number; width: number; height: number; fieldType: string },
): Promise<Region> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pageNumber: 1, ...field }),
  });
  const body = (await response.json()) as ApiResponse<{ region: Region }>;
  if (!body.data) throw new Error(`could not create region: ${JSON.stringify(body.error)}`);
  return body.data.region;
}

async function runOcr(
  documentId: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; payload: ApiResponse<RunOcrResponse> }> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/ocr`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as ApiResponse<RunOcrResponse> };
}

async function listRegions(documentId: string): Promise<Region[]> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions`);
  const body = (await response.json()) as ApiResponse<ListRegionsResponse>;
  return body.data?.regions ?? [];
}

describe('POST /api/documents/:id/ocr', () => {
  it('reads the text inside each region', { timeout: 180_000 }, async () => {
    const document = await uploadInvoice();
    await addRegion(document.id, FIELDS.vendor);
    await addRegion(document.id, FIELDS.invoiceNumber);
    await addRegion(document.id, FIELDS.total);

    const { status, payload } = await runOcr(document.id);
    expect(status).toBe(200);
    expect(payload.data?.succeeded).toBe(3);
    expect(payload.data?.failed).toBe(0);

    const regions = await listRegions(document.id);
    const textFor = (fieldType: string) =>
      regions.find((region) => region.fieldType === fieldType)?.rawText ?? '';

    expect(textFor('VENDOR_NAME')).toContain('ACME Supply Co');
    expect(textFor('INVOICE_NUMBER')).toContain('INV-2026-0042');
    expect(textFor('TOTAL')).toContain('5040.00');

    for (const region of regions) {
      expect(region.ocrStatus).toBe('DONE');
      expect(region.confidence).toBeGreaterThan(50);
      expect(region.ocrAt).toBeTruthy();
    }
  });

  it('processes only the requested regions', { timeout: 180_000 }, async () => {
    const document = await uploadInvoice();
    const vendor = await addRegion(document.id, FIELDS.vendor);
    await addRegion(document.id, FIELDS.total);

    const { payload } = await runOcr(document.id, { regionIds: [vendor.id] });
    expect(payload.data?.results).toHaveLength(1);

    const regions = await listRegions(document.id);
    expect(regions.find((region) => region.id === vendor.id)?.ocrStatus).toBe('DONE');
    expect(regions.find((region) => region.id !== vendor.id)?.ocrStatus).toBe('PENDING');
  });

  it('skips regions that already have text when onlyPending is set', { timeout: 180_000 }, async () => {
    const document = await uploadInvoice();
    await addRegion(document.id, FIELDS.vendor);

    await runOcr(document.id);
    const second = await runOcr(document.id, { onlyPending: true });

    expect(second.payload.data?.results).toHaveLength(0);
  });

  it('rejects a malformed regionIds', async () => {
    const document = await uploadInvoice();

    for (const body of [{ regionIds: 'nope' }, { regionIds: ['not-a-uuid'] }, { regionIds: [] }]) {
      const { status, payload } = await runOcr(document.id, body);
      expect(status).toBe(400);
      expect(payload.error?.code).toBe('INVALID_REQUEST');
    }
  });

  it('will not process a region that belongs to another document', async () => {
    const owner = await uploadInvoice();
    const other = await uploadInvoice();
    const region = await addRegion(owner.id, FIELDS.vendor);

    const { status, payload } = await runOcr(other.id, { regionIds: [region.id] });
    expect(status).toBe(404);
    expect(payload.error?.code).toBe('REGION_NOT_FOUND');
  });

  it('returns 404 for an unknown document', async () => {
    const { status, payload } = await runOcr(UNKNOWN_UUID);
    expect(status).toBe(404);
    expect(payload.error?.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('corrections', () => {
  it('stores a correction without losing the original reading', { timeout: 180_000 }, async () => {
    const document = await uploadInvoice();
    const region = await addRegion(document.id, FIELDS.vendor);
    await runOcr(document.id);

    const response = await fetch(`${baseUrl}/api/documents/${document.id}/regions/${region.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correctedText: 'ACME Supply Company Limited' }),
    });
    const body = (await response.json()) as ApiResponse<{ region: Region }>;

    expect(body.data?.region.correctedText).toBe('ACME Supply Company Limited');
    expect(body.data?.region.rawText).toContain('ACME Supply Co');
    expect(body.data?.region.confidence).toBeGreaterThan(50);
  });

  it('clears the correction when given an empty string', { timeout: 180_000 }, async () => {
    const document = await uploadInvoice();
    const region = await addRegion(document.id, FIELDS.vendor);
    await runOcr(document.id);

    const url = `${baseUrl}/api/documents/${document.id}/regions/${region.id}`;
    const put = (correctedText: string) =>
      fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correctedText }),
      });

    await put('Something else');
    const response = await put('   ');
    const body = (await response.json()) as ApiResponse<{ region: Region }>;

    expect(body.data?.region.correctedText).toBeUndefined();
    expect(body.data?.region.rawText).toContain('ACME');
  });

  it('rejects a non-string correction', async () => {
    const document = await uploadInvoice();
    const region = await addRegion(document.id, FIELDS.vendor);

    const response = await fetch(`${baseUrl}/api/documents/${document.id}/regions/${region.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ correctedText: 42 }),
    });
    expect(response.status).toBe(400);
  });
});

describe('OCR invalidation', () => {
  it(
    'discards text and corrections when the region is moved',
    { timeout: 180_000 },
    async () => {
      const document = await uploadInvoice();
      const region = await addRegion(document.id, FIELDS.vendor);
      await runOcr(document.id);

      const url = `${baseUrl}/api/documents/${document.id}/regions/${region.id}`;
      await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correctedText: 'Corrected by hand' }),
      });

      // Moving the box means it now covers different pixels, so the stored
      // reading no longer describes it.
      const moved = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ y: 0.5 }),
      });
      const body = (await moved.json()) as ApiResponse<{ region: Region }>;

      expect(body.data?.region.ocrStatus).toBe('PENDING');
      expect(body.data?.region.rawText).toBeUndefined();
      expect(body.data?.region.correctedText).toBeUndefined();
      expect(body.data?.region.confidence).toBeUndefined();
    },
  );

  it('keeps the text when only the field type changes', { timeout: 180_000 }, async () => {
    const document = await uploadInvoice();
    const region = await addRegion(document.id, FIELDS.vendor);
    await runOcr(document.id);

    const response = await fetch(`${baseUrl}/api/documents/${document.id}/regions/${region.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fieldType: 'VENDOR_ADDRESS' }),
    });
    const body = (await response.json()) as ApiResponse<{ region: Region }>;

    expect(body.data?.region.ocrStatus).toBe('DONE');
    expect(body.data?.region.rawText).toContain('ACME');
  });
});

describe('cropRegionToPng', () => {
  it('cuts the rectangle out of the page image', { timeout: 120_000 }, async () => {
    const document = await uploadInvoice();
    const { cropRegionToPng } = await import('../services/ocrService.js');

    const crop = await cropRegionToPng(document.id, 1, {
      x: 0.1,
      y: 0.06,
      width: 0.35,
      height: 0.045,
    });

    // PNG magic number, then a width matching the upscale rule.
    expect(crop.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(crop.readUInt32BE(16)).toBeGreaterThan(0);
  });

  it('clamps a rectangle that touches the page edge', { timeout: 120_000 }, async () => {
    const document = await uploadInvoice();
    const { cropRegionToPng } = await import('../services/ocrService.js');

    const crop = await cropRegionToPng(document.id, 1, {
      x: 0.9,
      y: 0.9,
      width: 0.1,
      height: 0.1,
    });
    expect(crop.readUInt32BE(16)).toBeGreaterThan(0);
  });
});
