import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  Document,
  DocumentWithStats,
  ListRegionsResponse,
  Region,
} from '../types/index.js';
import { buildPdf } from './fixtures.js';
import './setup.js';

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

/** Upload a PDF and wait until the server has finished with it. */
async function uploadDocument(pages = 2): Promise<Document> {
  const form = new FormData();
  const bytes = buildPdf(Array.from({ length: pages }, (_, i) => `Page ${i + 1}`));
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), 'inv.pdf');

  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', body: form });
  const created = ((await response.json()) as ApiResponse<Document>).data;
  if (!created) throw new Error('upload failed');

  for (let i = 0; i < 40; i++) {
    const poll = await fetch(`${baseUrl}/api/documents/${created.id}`);
    const document = ((await poll.json()) as ApiResponse<Document>).data;
    if (document && document.status !== 'processing') return document;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('document never finished processing');
}

interface RegionBody {
  pageNumber?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fieldType?: string;
  fieldLabel?: string;
}

const VALID: RegionBody = {
  pageNumber: 1,
  x: 0.1,
  y: 0.1,
  width: 0.2,
  height: 0.1,
  fieldType: 'INVOICE_NUMBER',
};

async function postRegion(
  documentId: string,
  body: RegionBody,
): Promise<{ status: number; payload: ApiResponse<{ region: Region }> }> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as ApiResponse<{ region: Region }> };
}

async function putRegion(
  documentId: string,
  regionId: string,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: ApiResponse<{ region: Region }> }> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions/${regionId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, payload: (await response.json()) as ApiResponse<{ region: Region }> };
}

describe('POST /api/documents/:id/regions', () => {
  it('creates a region and returns it', async () => {
    const document = await uploadDocument();
    const { status, payload } = await postRegion(document.id, VALID);

    expect(status).toBe(201);
    const region = payload.data?.region;
    expect(region?.documentId).toBe(document.id);
    expect(region?.fieldType).toBe('INVOICE_NUMBER');
    expect(region?.pageNumber).toBe(1);
  });

  it('rounds coordinates to four decimal places', async () => {
    const document = await uploadDocument();
    const { payload } = await postRegion(document.id, {
      ...VALID,
      x: 0.123456789,
      y: 0.987654321 - 0.9,
    });

    expect(payload.data?.region.x).toBe(0.1235);
    expect(payload.data?.region.y).toBe(0.0877);
  });

  it('keeps a trimmed label on a CUSTOM region', async () => {
    const document = await uploadDocument();
    const { payload } = await postRegion(document.id, {
      ...VALID,
      fieldType: 'CUSTOM',
      fieldLabel: '  Shipping Ref  ',
    });

    expect(payload.data?.region.fieldLabel).toBe('Shipping Ref');
  });

  it('drops a label on a non-CUSTOM region', async () => {
    const document = await uploadDocument();
    const { payload } = await postRegion(document.id, {
      ...VALID,
      fieldType: 'TOTAL',
      fieldLabel: 'ignored',
    });

    expect(payload.data?.region.fieldType).toBe('TOTAL');
    expect(payload.data?.region.fieldLabel).toBeUndefined();
  });

  it('rejects a rectangle that runs off the page', async () => {
    const document = await uploadDocument();

    for (const overflow of [
      { ...VALID, x: 0.8, width: 0.5 },
      { ...VALID, y: 0.95, height: 0.2 },
      { ...VALID, x: -0.1 },
      { ...VALID, y: -0.01 },
    ]) {
      const { status, payload } = await postRegion(document.id, overflow);
      expect(status).toBe(400);
      expect(payload.error?.code).toBe('REGION_OUT_OF_BOUNDS');
    }
  });

  it('rejects a rectangle with no area', async () => {
    const document = await uploadDocument();

    for (const empty of [
      { ...VALID, width: 0 },
      { ...VALID, height: 0 },
      { ...VALID, height: -0.2 },
    ]) {
      const { status, payload } = await postRegion(document.id, empty);
      expect(status).toBe(400);
      expect(payload.error?.code).toBe('INVALID_DIMENSIONS');
    }
  });

  it('rejects a page outside the document', async () => {
    const document = await uploadDocument(2);

    for (const pageNumber of [0, 3, 99]) {
      const { status, payload } = await postRegion(document.id, { ...VALID, pageNumber });
      expect(status).toBe(400);
      expect(payload.error?.code).toBe('INVALID_PAGE');
    }
  });

  it('rejects an unknown field type', async () => {
    const document = await uploadDocument();
    const { status, payload } = await postRegion(document.id, { ...VALID, fieldType: 'NOPE' });

    expect(status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_FIELD_TYPE');
  });

  it('rejects a missing coordinate', async () => {
    const document = await uploadDocument();
    const body = { ...VALID };
    delete body.x;

    const { status, payload } = await postRegion(document.id, body);
    expect(status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('returns 404 for an unknown document', async () => {
    const { status, payload } = await postRegion(UNKNOWN_UUID, VALID);
    expect(status).toBe(404);
    expect(payload.error?.code).toBe('DOCUMENT_NOT_FOUND');
  });
});

describe('GET /api/documents/:id/regions', () => {
  it('lists every region, and filters by page', async () => {
    const document = await uploadDocument(2);
    await postRegion(document.id, { ...VALID, pageNumber: 1 });
    await postRegion(document.id, { ...VALID, pageNumber: 2, fieldType: 'TOTAL' });
    await postRegion(document.id, { ...VALID, pageNumber: 2, y: 0.5, fieldType: 'TAX' });

    const all = await fetch(`${baseUrl}/api/documents/${document.id}/regions`);
    const allBody = (await all.json()) as ApiResponse<ListRegionsResponse>;
    expect(allBody.data?.total).toBe(3);

    const page2 = await fetch(`${baseUrl}/api/documents/${document.id}/regions/page/2`);
    const page2Body = (await page2.json()) as ApiResponse<ListRegionsResponse>;
    expect(page2Body.data?.total).toBe(2);
    expect(page2Body.data?.regions.every((region) => region.pageNumber === 2)).toBe(true);
  });

  it('returns 404 for an unknown document rather than an empty list', async () => {
    const response = await fetch(`${baseUrl}/api/documents/${UNKNOWN_UUID}/regions`);
    expect(response.status).toBe(404);
  });
});

describe('PUT /api/documents/:id/regions/:regionId', () => {
  it('moves a region', async () => {
    const document = await uploadDocument();
    const created = (await postRegion(document.id, VALID)).payload.data!.region;

    const { status, payload } = await putRegion(document.id, created.id, { x: 0.4, y: 0.35 });
    expect(status).toBe(200);
    expect(payload.data?.region.x).toBe(0.4);
    expect(payload.data?.region.y).toBe(0.35);
    // Untouched fields survive.
    expect(payload.data?.region.width).toBe(0.2);
  });

  it('validates the merged rectangle, not just the fields sent', async () => {
    const document = await uploadDocument();
    // Sits at x=0.9 with width 0.05, so widening alone pushes it off the page.
    const created = (await postRegion(document.id, { ...VALID, x: 0.9, width: 0.05 })).payload.data!
      .region;

    const { status, payload } = await putRegion(document.id, created.id, { width: 0.5 });
    expect(status).toBe(400);
    expect(payload.error?.code).toBe('REGION_OUT_OF_BOUNDS');

    // The stored region is unchanged.
    const after = await fetch(`${baseUrl}/api/documents/${document.id}/regions`);
    const body = (await after.json()) as ApiResponse<ListRegionsResponse>;
    expect(body.data?.regions[0]?.width).toBe(0.05);
  });

  it('changes the field type, clearing a label that no longer applies', async () => {
    const document = await uploadDocument();
    const created = (
      await postRegion(document.id, { ...VALID, fieldType: 'CUSTOM', fieldLabel: 'Ref' })
    ).payload.data!.region;
    expect(created.fieldLabel).toBe('Ref');

    const { payload } = await putRegion(document.id, created.id, { fieldType: 'TAX' });
    expect(payload.data?.region.fieldType).toBe('TAX');
    expect(payload.data?.region.fieldLabel).toBeUndefined();
  });

  it('rejects an update with no fields', async () => {
    const document = await uploadDocument();
    const created = (await postRegion(document.id, VALID)).payload.data!.region;

    const { status, payload } = await putRegion(document.id, created.id, {});
    expect(status).toBe(400);
    expect(payload.error?.code).toBe('INVALID_REQUEST');
  });

  it('will not edit a region through another document', async () => {
    const owner = await uploadDocument();
    const other = await uploadDocument();
    const created = (await postRegion(owner.id, VALID)).payload.data!.region;

    const { status, payload } = await putRegion(other.id, created.id, { x: 0.5 });
    expect(status).toBe(404);
    expect(payload.error?.code).toBe('REGION_NOT_FOUND');

    // And the region is untouched.
    const check = await fetch(`${baseUrl}/api/documents/${owner.id}/regions`);
    const body = (await check.json()) as ApiResponse<ListRegionsResponse>;
    expect(body.data?.regions[0]?.x).toBe(0.1);
  });

  it('returns 404 for an unknown region', async () => {
    const document = await uploadDocument();
    const { status, payload } = await putRegion(document.id, UNKNOWN_UUID, { x: 0.5 });
    expect(status).toBe(404);
    expect(payload.error?.code).toBe('REGION_NOT_FOUND');
  });
});

describe('DELETE /api/documents/:id/regions/:regionId', () => {
  it('deletes a region, and reports a second attempt as missing', async () => {
    const document = await uploadDocument();
    const created = (await postRegion(document.id, VALID)).payload.data!.region;

    const first = await fetch(
      `${baseUrl}/api/documents/${document.id}/regions/${created.id}`,
      { method: 'DELETE' },
    );
    expect(first.status).toBe(200);

    const second = await fetch(
      `${baseUrl}/api/documents/${document.id}/regions/${created.id}`,
      { method: 'DELETE' },
    );
    expect(second.status).toBe(404);
  });

  it('will not delete a region through another document', async () => {
    const owner = await uploadDocument();
    const other = await uploadDocument();
    const created = (await postRegion(owner.id, VALID)).payload.data!.region;

    const response = await fetch(
      `${baseUrl}/api/documents/${other.id}/regions/${created.id}`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(404);

    const check = await fetch(`${baseUrl}/api/documents/${owner.id}/regions`);
    const body = (await check.json()) as ApiResponse<ListRegionsResponse>;
    expect(body.data?.total).toBe(1);
  });
});

describe('document and region lifecycle', () => {
  it('reports region counts on the document', async () => {
    const document = await uploadDocument(2);
    await postRegion(document.id, { ...VALID, pageNumber: 1 });
    await postRegion(document.id, { ...VALID, pageNumber: 2 });
    await postRegion(document.id, { ...VALID, pageNumber: 2, y: 0.6 });

    const response = await fetch(`${baseUrl}/api/documents/${document.id}`);
    const body = (await response.json()) as ApiResponse<DocumentWithStats>;

    expect(body.data?.regionCount).toBe(3);
    expect(body.data?.pagesWithRegions).toEqual([1, 2]);
  });

  it('deletes regions along with their document', async () => {
    const document = await uploadDocument();
    await postRegion(document.id, VALID);

    await fetch(`${baseUrl}/api/documents/${document.id}`, { method: 'DELETE' });

    const response = await fetch(`${baseUrl}/api/documents/${document.id}/regions`);
    expect(response.status).toBe(404);
  });
});
