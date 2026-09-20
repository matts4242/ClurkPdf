import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  ApplyTemplateResponse,
  Batch,
  Document,
  FieldType,
  Region,
  Template,
  TemplateSuggestion,
} from '../types/index.js';
import {
  buildColumnarInvoicePdf,
  buildInvoicePdf,
  buildPdf,
  buildPositionedPdf,
} from './fixtures.js';

/**
 * Week 6 end to end: mark a document up, save it as a template, and watch the
 * next invoice from that vendor arrive already filled in.
 *
 * Nothing is stubbed — real PDFs through the real queue against a real Redis,
 * with the same worker `npm run dev` runs.
 */

let baseUrl: string;
let close: () => Promise<void>;

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
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function upload(bytes: Buffer, filename = 'invoice.pdf', batchId?: string): Promise<Document> {
  const form = new FormData();
  if (batchId !== undefined) form.append('batchId', batchId);
  form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), filename);

  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', body: form });
  const body = (await response.json()) as ApiResponse<Document>;
  if (!body.data) throw new Error(`upload failed: ${JSON.stringify(body.error)}`);
  return body.data;
}

/** Upload and wait for the queue to finish with it. */
async function uploadAndWait(
  bytes: Buffer,
  filename = 'invoice.pdf',
  batchId?: string,
): Promise<Document> {
  const created = await upload(bytes, filename, batchId);
  return waitForDocument(created.id);
}

async function waitForDocument(id: string, attempts = 150): Promise<Document> {
  for (let i = 0; i < attempts; i += 1) {
    const response = await fetch(`${baseUrl}/api/documents/${id}`);
    const body = (await response.json()) as ApiResponse<Document>;
    const document = body.data;
    if (document && (document.status === 'ready' || document.status === 'error')) {
      return document;
    }
    await sleep(100);
  }
  throw new Error(`document ${id} was never processed`);
}

async function listRegions(documentId: string): Promise<Region[]> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions`);
  const body = (await response.json()) as ApiResponse<{ regions: Region[] }>;
  return body.data?.regions ?? [];
}

async function saveTemplate(
  documentId: string,
  options: { name?: string; vendorIdentifier?: string } = {},
): Promise<Template> {
  const response = await fetch(`${baseUrl}/api/templates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ documentId, ...options }),
  });
  const body = (await response.json()) as ApiResponse<{ template: Template }>;
  if (!body.data) throw new Error(`template not saved: ${JSON.stringify(body.error)}`);
  return body.data.template;
}

async function applyTemplate(
  templateId: string,
  target: { documentIds?: string[]; batchId?: string },
): Promise<ApplyTemplateResponse> {
  const response = await fetch(`${baseUrl}/api/templates/${templateId}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(target),
  });
  const body = (await response.json()) as ApiResponse<ApplyTemplateResponse>;
  if (!body.data) throw new Error(`apply failed: ${JSON.stringify(body.error)}`);
  return body.data;
}

async function createBatch(): Promise<Batch> {
  const response = await fetch(`${baseUrl}/api/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'template batch' }),
  });
  const body = (await response.json()) as ApiResponse<{ batch: Batch }>;
  return body.data!.batch;
}

async function createRegion(
  documentId: string,
  region: {
    pageNumber: number;
    x: number;
    y: number;
    width: number;
    height: number;
    fieldType: FieldType;
    fieldLabel?: string;
  },
): Promise<Region> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...region, textSource: 'TEXT_LAYER' }),
  });
  const body = (await response.json()) as ApiResponse<{ region: Region }>;
  if (!body.data) throw new Error(`region not created: ${JSON.stringify(body.error)}`);
  return body.data.region;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const textOf = (region: Region): string => region.correctedText ?? region.rawText ?? '';

const byType = (regions: Region[]): Record<string, string> =>
  Object.fromEntries(regions.map((region) => [region.fieldType, textOf(region)]));

/**
 * A second ACME invoice: the same letterhead, different values, and the fields
 * one line lower than the first so a replayed rectangle has to snap.
 */
const secondAcmeInvoice = (): Buffer =>
  buildPositionedPdf([
    [72, 720, 22, 'ACME Supply Co'],
    [72, 690, 12, '119 Harbour Road, Bristol'],
    [400, 720, 14, 'INVOICE'],
    [400, 685, 12, 'Invoice No: INV-2026-0099'],
    [400, 665, 12, 'Date: 20 April 2026'],
    [400, 645, 12, 'PO Number: PO-77001'],
    [400, 470, 12, 'Subtotal: 1500.00'],
    [400, 450, 12, 'Tax: 300.00'],
    [400, 425, 14, 'Total: 1800.00'],
  ]);

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

describe('POST /api/templates', () => {
  it("names itself from the document's vendor region", async () => {
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf');

    const template = await saveTemplate(document.id);

    // Week 5 detected the vendor; Week 6 keys the template on it with no typing.
    expect(template.vendorIdentifier).toBe('ACME Supply Co');
    expect(template.name).toBe('ACME Supply Co');
    expect(template.sourceDocumentId).toBe(document.id);
    expect(template.useCount).toBe(0);
  });

  it("saves every one of the document's regions", async () => {
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf');
    const regions = await listRegions(document.id);

    const template = await saveTemplate(document.id);

    expect(template.regions).toHaveLength(regions.length);
    for (const saved of template.regions) {
      const original = regions.find((region) => region.fieldType === saved.fieldType);
      expect(original).toBeDefined();
      expect(saved.x).toBeCloseTo(original!.x, 4);
      expect(saved.y).toBeCloseTo(original!.y, 4);
    }
  });

  it('accepts an explicit name and vendor', async () => {
    const document = await uploadAndWait(buildInvoicePdf(), 'acme.pdf');

    const template = await saveTemplate(document.id, {
      name: 'ACME monthly',
      vendorIdentifier: 'ACME Supply Company',
    });

    expect(template.name).toBe('ACME monthly');
    expect(template.vendorIdentifier).toBe('ACME Supply Company');
  });

  it('refuses a document with no regions to save', async () => {
    // A page with no text layer at all: nothing to detect, so no regions.
    const document = await uploadAndWait(buildPositionedPdf([]), 'blank.pdf');
    expect(await listRegions(document.id)).toHaveLength(0);

    const response = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: document.id }),
    });
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe('TEMPLATE_EMPTY');
  });

  it('404s for a document that does not exist', async () => {
    const response = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: '00000000-0000-4000-8000-000000000000' }),
    });

    expect(response.status).toBe(404);
  });

  it('rejects a malformed document id', async () => {
    const response = await fetch(`${baseUrl}/api/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId: 'not-a-uuid' }),
    });

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Automatic matching
// ---------------------------------------------------------------------------

describe('matching a template on upload', () => {
  it('fills in the next invoice from the same vendor', async () => {
    const first = await uploadAndWait(buildInvoicePdf(), 'acme-1.pdf');
    const template = await saveTemplate(first.id);

    const second = await uploadAndWait(secondAcmeInvoice(), 'acme-2.pdf');

    expect(second.templateId).toBe(template.id);
    expect(second.templateScore).toBeGreaterThanOrEqual(0.8);

    // The values are this invoice's, not the template's.
    const values = byType(await listRegions(second.id));
    expect(values.INVOICE_NUMBER).toBe('INV-2026-0099');
    expect(values.TOTAL).toBe('1800.00');
    expect(values.PO_NUMBER).toBe('PO-77001');
  });

  it('counts the use against the template', async () => {
    const first = await uploadAndWait(buildInvoicePdf(), 'acme-1.pdf');
    const template = await saveTemplate(first.id);

    await uploadAndWait(secondAcmeInvoice(), 'acme-2.pdf');

    const response = await fetch(`${baseUrl}/api/templates/${template.id}`);
    const body = (await response.json()) as ApiResponse<{ template: Template }>;

    expect(body.data?.template.useCount).toBe(1);
    expect(body.data?.template.lastUsedAt).toBeTruthy();
  });

  it('leaves a different vendor alone', async () => {
    const acme = await uploadAndWait(buildInvoicePdf(), 'acme.pdf');
    await saveTemplate(acme.id);

    const northwind = await uploadAndWait(buildColumnarInvoicePdf(), 'northwind.pdf');

    expect(northwind.templateId).toBeUndefined();
    // Week 5's detection still ran, so it is not empty.
    expect((await listRegions(northwind.id)).length).toBeGreaterThan(0);
  });

  it('snaps a replayed rectangle onto this document\'s own text', async () => {
    const first = await uploadAndWait(buildInvoicePdf(), 'acme-1.pdf');
    const template = await saveTemplate(first.id);
    const savedTotal = template.regions.find((region) => region.fieldType === 'TOTAL');

    // The second invoice has its total on a different line.
    const second = await uploadAndWait(secondAcmeInvoice(), 'acme-2.pdf');
    const total = (await listRegions(second.id)).find(
      (region) => region.fieldType === 'TOTAL',
    );

    expect(textOf(total!)).toBe('1800.00');
    // Snapped, so the box moved to where the text actually is.
    expect(total!.y).not.toBeCloseTo(savedTotal!.y, 3);
  });

  it('marks template-placed regions for review', async () => {
    const first = await uploadAndWait(buildInvoicePdf(), 'acme-1.pdf');
    await saveTemplate(first.id);

    const second = await uploadAndWait(secondAcmeInvoice(), 'acme-2.pdf');

    for (const region of await listRegions(second.id)) {
      expect(region.autoDetected).toBe(true);
    }
  });

  it('prefers the template over the regex detector for the same field', async () => {
    const first = await uploadAndWait(buildInvoicePdf(), 'acme-1.pdf');
    // Save a template whose only region is a CUSTOM one the detector could
    // never produce, so its presence proves the template ran.
    await createRegion(first.id, {
      pageNumber: 1,
      x: 0.1,
      y: 0.06,
      width: 0.3,
      height: 0.03,
      fieldType: 'CUSTOM',
      fieldLabel: 'Letterhead',
    });
    await saveTemplate(first.id);

    const second = await uploadAndWait(secondAcmeInvoice(), 'acme-2.pdf');
    const regions = await listRegions(second.id);

    const custom = regions.find((region) => region.fieldType === 'CUSTOM');
    expect(custom?.fieldLabel).toBe('Letterhead');
    // And exactly one region per ordinary field type, not one each from the
    // template and the detector.
    const totals = regions.filter((region) => region.fieldType === 'TOTAL');
    expect(totals).toHaveLength(1);
  });

  it('does nothing for a scan, which has no header to read', async () => {
    const first = await uploadAndWait(buildInvoicePdf(), 'acme-1.pdf');
    await saveTemplate(first.id);

    // A PDF with no text layer at all stands in for a scan.
    const scan = await uploadAndWait(buildPositionedPdf([]), 'scan.pdf');

    expect(scan.templateId).toBeUndefined();
    expect(scan.status).toBe('ready');
  });
});

// ---------------------------------------------------------------------------
// Applying by hand
// ---------------------------------------------------------------------------

describe('POST /api/templates/:id/apply', () => {
  it('applies to named documents', async () => {
    const source = await uploadAndWait(buildInvoicePdf(), 'acme.pdf');
    const template = await saveTemplate(source.id, { vendorIdentifier: 'Someone Else Entirely' });

    // A different vendor, so nothing matched automatically.
    const target = await uploadAndWait(secondAcmeInvoice(), 'acme-2.pdf');
    const before = await listRegions(target.id);
    await Promise.all(
      before.map((region) =>
        fetch(`${baseUrl}/api/documents/${target.id}/regions/${region.id}`, {
          method: 'DELETE',
        }),
      ),
    );

    const result = await applyTemplate(template.id, { documentIds: [target.id] });

    expect(result.regionsCreated).toBeGreaterThan(0);
    expect(result.applications).toHaveLength(1);
    expect(byType(await listRegions(target.id)).TOTAL).toBe('1800.00');
  });

  it('applies to every ready document in a batch', async () => {
    const source = await uploadAndWait(buildInvoicePdf(), 'source.pdf');
    const template = await saveTemplate(source.id, { vendorIdentifier: 'Nothing Matches This' });

    const batch = await createBatch();
    await Promise.all([
      uploadAndWait(secondAcmeInvoice(), 'a.pdf', batch.id),
      uploadAndWait(secondAcmeInvoice(), 'b.pdf', batch.id),
    ]);

    const result = await applyTemplate(template.id, { batchId: batch.id });

    expect(result.applications).toHaveLength(2);
  });

  it('never overwrites a field the document already has', async () => {
    const source = await uploadAndWait(buildInvoicePdf(), 'source.pdf');
    const template = await saveTemplate(source.id, { vendorIdentifier: 'Nothing Matches This' });

    // Already filled in by Week 5's detector.
    const target = await uploadAndWait(secondAcmeInvoice(), 'target.pdf');
    const before = await listRegions(target.id);
    const beforeTotal = before.find((region) => region.fieldType === 'TOTAL');

    const result = await applyTemplate(template.id, { documentIds: [target.id] });

    expect(result.applications[0]!.skipped).toContain('TOTAL');
    const after = await listRegions(target.id);
    const afterTotal = after.find((region) => region.fieldType === 'TOTAL');
    // The same row, untouched.
    expect(afterTotal!.id).toBe(beforeTotal!.id);
    expect(after.filter((region) => region.fieldType === 'TOTAL')).toHaveLength(1);
  });

  it('is safe to apply twice', async () => {
    const source = await uploadAndWait(buildInvoicePdf(), 'source.pdf');
    const template = await saveTemplate(source.id, { vendorIdentifier: 'Nothing Matches This' });
    const target = await uploadAndWait(buildPdf(['Blank enough']), 'target.pdf');
    // The detector may already have guessed a field or two here.
    const before = (await listRegions(target.id)).length;

    const first = await applyTemplate(template.id, { documentIds: [target.id] });
    const afterFirst = await listRegions(target.id);
    expect(afterFirst).toHaveLength(before + first.regionsCreated);

    const second = await applyTemplate(template.id, { documentIds: [target.id] });

    expect(second.regionsCreated).toBe(0);
    expect(await listRegions(target.id)).toHaveLength(afterFirst.length);
  });

  it('skips a page the target document does not have', async () => {
    const source = await uploadAndWait(buildInvoicePdf(), 'source.pdf');
    await createRegion(source.id, {
      pageNumber: 1,
      x: 0.5,
      y: 0.5,
      width: 0.2,
      height: 0.05,
      fieldType: 'CUSTOM',
      fieldLabel: 'Only on page 1',
    });
    const template = await saveTemplate(source.id, { vendorIdentifier: 'Nothing Matches This' });

    const target = await uploadAndWait(buildPdf(['One page only']), 'target.pdf');
    const result = await applyTemplate(template.id, { documentIds: [target.id] });

    // Nothing threw, and the one-page target got what fitted.
    expect(result.applications[0]!.documentId).toBe(target.id);
  });

  it('404s for a template that does not exist', async () => {
    const response = await fetch(
      `${baseUrl}/api/templates/00000000-0000-4000-8000-000000000000/apply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentIds: [] }),
      },
    );
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('rejects an apply naming no targets', async () => {
    const source = await uploadAndWait(buildInvoicePdf(), 'source.pdf');
    const template = await saveTemplate(source.id);

    const response = await fetch(`${baseUrl}/api/templates/${template.id}/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

describe('GET /api/documents/:id/template-suggestions', () => {
  it('offers the templates that look like this document, best first', async () => {
    const acme = await uploadAndWait(buildInvoicePdf(), 'acme.pdf');
    const acmeTemplate = await saveTemplate(acme.id);

    const northwind = await uploadAndWait(buildColumnarInvoicePdf(), 'northwind.pdf');
    await saveTemplate(northwind.id);

    const target = await uploadAndWait(secondAcmeInvoice(), 'acme-2.pdf');
    const response = await fetch(`${baseUrl}/api/documents/${target.id}/template-suggestions`);
    const body = (await response.json()) as ApiResponse<{ suggestions: TemplateSuggestion[] }>;

    const suggestions = body.data!.suggestions;
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0]!.template.id).toBe(acmeTemplate.id);
    expect(suggestions[0]!.matchedText).toContain('ACME');
  });

  it('offers nothing when no template resembles the document', async () => {
    const acme = await uploadAndWait(buildInvoicePdf(), 'acme.pdf');
    await saveTemplate(acme.id, { vendorIdentifier: 'Zzyzx Holdings' });

    const other = await uploadAndWait(buildColumnarInvoicePdf(), 'northwind.pdf');
    const response = await fetch(`${baseUrl}/api/documents/${other.id}/template-suggestions`);
    const body = (await response.json()) as ApiResponse<{ suggestions: TemplateSuggestion[] }>;

    expect(body.data?.suggestions).toEqual([]);
  });

  it('404s for a document that does not exist', async () => {
    const response = await fetch(
      `${baseUrl}/api/documents/00000000-0000-4000-8000-000000000000/template-suggestions`,
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Managing
// ---------------------------------------------------------------------------

describe('managing templates', () => {
  it('lists them newest first', async () => {
    const first = await uploadAndWait(buildInvoicePdf(), 'a.pdf');
    const a = await saveTemplate(first.id, { name: 'first' });
    const b = await saveTemplate(first.id, { name: 'second' });

    const response = await fetch(`${baseUrl}/api/templates`);
    const body = (await response.json()) as ApiResponse<{ templates: Template[] }>;

    expect(body.data!.templates.map((template) => template.id).slice(0, 2)).toEqual([b.id, a.id]);
  });

  it('renames one and changes the vendor it answers to', async () => {
    const document = await uploadAndWait(buildInvoicePdf(), 'a.pdf');
    const template = await saveTemplate(document.id);

    const response = await fetch(`${baseUrl}/api/templates/${template.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed', vendorIdentifier: 'Other Vendor Ltd' }),
    });
    const body = (await response.json()) as ApiResponse<{ template: Template }>;

    expect(response.status).toBe(200);
    expect(body.data?.template.name).toBe('Renamed');
    expect(body.data?.template.vendorIdentifier).toBe('Other Vendor Ltd');
  });

  it('rejects an update with nothing in it', async () => {
    const document = await uploadAndWait(buildInvoicePdf(), 'a.pdf');
    const template = await saveTemplate(document.id);

    const response = await fetch(`${baseUrl}/api/templates/${template.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(400);
  });

  it('deletes one, leaving the regions it already placed', async () => {
    const source = await uploadAndWait(buildInvoicePdf(), 'source.pdf');
    const template = await saveTemplate(source.id);
    const target = await uploadAndWait(secondAcmeInvoice(), 'target.pdf');
    const placed = await listRegions(target.id);
    expect(placed.length).toBeGreaterThan(0);

    const response = await fetch(`${baseUrl}/api/templates/${template.id}`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect((await fetch(`${baseUrl}/api/templates/${template.id}`)).status).toBe(404);
    // The work it did survives it; only the pattern is forgotten.
    expect(await listRegions(target.id)).toHaveLength(placed.length);
  });

  it('survives its source document being deleted', async () => {
    const source = await uploadAndWait(buildInvoicePdf(), 'source.pdf');
    const template = await saveTemplate(source.id);

    await fetch(`${baseUrl}/api/documents/${source.id}`, { method: 'DELETE' });

    const response = await fetch(`${baseUrl}/api/templates/${template.id}`);
    const body = (await response.json()) as ApiResponse<{ template: Template }>;

    expect(response.status).toBe(200);
    // Still usable: the rectangles were copied, not referenced.
    expect(body.data!.template.regions.length).toBeGreaterThan(0);
  });
});
