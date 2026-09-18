import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  ApiResponse,
  Batch,
  BatchWithDocuments,
  BatchWithProgress,
  Document,
  ProcessingEvent,
  Region,
} from '../types/index.js';
import {
  buildColumnarInvoicePdf,
  buildInvoicePdf,
  buildPdf,
  buildProsePdf,
} from './fixtures.js';
import { TEST_UPLOADS_DIR } from './setup.js';

/**
 * Week 5, end to end: upload into a batch, let a real worker drain a real
 * Redis queue, and check what comes out the other side.
 *
 * Nothing is stubbed. The worker started here is the same one `npm run dev`
 * runs, against the same BullMQ queue, so a job that would deadlock or never
 * report progress in production does so here too.
 */

let baseUrl: string;
let wsUrl: string;
let close: () => Promise<void>;
const uploadsDir = TEST_UPLOADS_DIR;

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  const { attachWebSocketServer } = await import('../events/wsServer.js');
  const { startWorker } = await import('../queue/documentQueue.js');

  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  attachWebSocketServer(server);
  startWorker();

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;

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

async function createBatch(name?: string, fileCount?: number): Promise<Batch> {
  const response = await fetch(`${baseUrl}/api/batches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...(name === undefined ? {} : { name }),
      ...(fileCount === undefined ? {} : { fileCount }),
    }),
  });
  const body = (await response.json()) as ApiResponse<{ batch: Batch }>;
  if (!body.data) throw new Error(`batch not created: ${JSON.stringify(body.error)}`);
  return body.data.batch;
}

async function upload(
  bytes: Buffer,
  options: { filename?: string; batchId?: string } = {},
): Promise<Document> {
  const form = new FormData();
  // Multer only exposes fields that arrive before the file, so batchId is
  // appended first. The client does the same.
  if (options.batchId !== undefined) form.append('batchId', options.batchId);
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }),
    options.filename ?? 'invoice.pdf',
  );

  const response = await fetch(`${baseUrl}/api/documents/upload`, { method: 'POST', body: form });
  const body = (await response.json()) as ApiResponse<Document>;
  if (!body.data) throw new Error(`upload failed: ${JSON.stringify(body.error)}`);
  return body.data;
}

async function fetchBatch(id: string): Promise<BatchWithDocuments> {
  const response = await fetch(`${baseUrl}/api/batches/${id}`);
  const body = (await response.json()) as ApiResponse<{ batch: BatchWithDocuments }>;
  if (!body.data) throw new Error(`batch not found: ${JSON.stringify(body.error)}`);
  return body.data.batch;
}

async function fetchDocument(id: string): Promise<Document> {
  const response = await fetch(`${baseUrl}/api/documents/${id}`);
  const body = (await response.json()) as ApiResponse<Document>;
  if (!body.data) throw new Error(`document not found: ${JSON.stringify(body.error)}`);
  return body.data;
}

async function listRegions(documentId: string): Promise<Region[]> {
  const response = await fetch(`${baseUrl}/api/documents/${documentId}/regions`);
  const body = (await response.json()) as ApiResponse<{ regions: Region[] }>;
  return body.data?.regions ?? [];
}

/** Wait until the queue has finished with a document, either way. */
async function waitForDocument(id: string, attempts = 150): Promise<Document> {
  for (let i = 0; i < attempts; i += 1) {
    const document = await fetchDocument(id);
    if (document.status === 'ready' || document.status === 'error') return document;
    await sleep(100);
  }
  throw new Error(`document ${id} was never processed`);
}

/** Wait until every document in a batch has settled. */
async function waitForBatch(id: string, attempts = 300): Promise<BatchWithDocuments> {
  for (let i = 0; i < attempts; i += 1) {
    const batch = await fetchBatch(id);
    if (batch.status === 'complete' && batch.documentCount > 0) return batch;
    await sleep(100);
  }
  throw new Error(`batch ${id} never completed`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const textOf = (region: Region): string => region.correctedText ?? region.rawText ?? '';

const regionFor = (regions: Region[], fieldType: string): Region | undefined =>
  regions.find((region) => region.fieldType === fieldType);

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

describe('POST /api/batches', () => {
  it('creates a named batch', async () => {
    const batch = await createBatch('March invoices');

    expect(batch.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch.name).toBe('March invoices');
    expect(batch.status).toBe('queued');
  });

  it('names a batch after the files it is told to expect', async () => {
    expect((await createBatch(undefined, 3)).name).toMatch(/^3 files · \d{2}:\d{2}$/);
    expect((await createBatch(undefined, 1)).name).toMatch(/^1 file · \d{2}:\d{2}$/);
  });

  it('does not claim "0 files" when no count was given', async () => {
    const batch = await createBatch();

    expect(batch.name).not.toContain('0 files');
    expect(batch.name).toMatch(/^Upload · \d{2}:\d{2}$/);
  });

  it('rejects a negative file count', async () => {
    const response = await fetch(`${baseUrl}/api/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileCount: -1 }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects a non-string name', async () => {
    const response = await fetch(`${baseUrl}/api/batches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 42 }),
    });
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(400);
    expect(body.error?.code).toBe('INVALID_REQUEST');
  });
});

describe('GET /api/batches/:id', () => {
  it('returns 404 for an unknown batch', async () => {
    const response = await fetch(
      `${baseUrl}/api/batches/00000000-0000-4000-8000-000000000000`,
    );
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe('BATCH_NOT_FOUND');
  });

  it('returns 400 for a malformed id', async () => {
    const response = await fetch(`${baseUrl}/api/batches/not-a-uuid`);
    expect(response.status).toBe(400);
  });
});

describe('uploading into a batch', () => {
  it('rejects an upload naming a batch that does not exist', async () => {
    const form = new FormData();
    form.append('batchId', '00000000-0000-4000-8000-000000000000');
    form.append(
      'file',
      new Blob([new Uint8Array(buildPdf(['x']))], { type: 'application/pdf' }),
      'x.pdf',
    );

    const response = await fetch(`${baseUrl}/api/documents/upload`, {
      method: 'POST',
      body: form,
    });
    const body = (await response.json()) as ApiResponse<never>;

    expect(response.status).toBe(404);
    expect(body.error?.code).toBe('BATCH_NOT_FOUND');
  });

  it('processes every document in a batch and reports it complete', async () => {
    const batch = await createBatch('three files');

    const uploaded = await Promise.all([
      upload(buildPdf(['One']), { filename: 'a.pdf', batchId: batch.id }),
      upload(buildPdf(['Two']), { filename: 'b.pdf', batchId: batch.id }),
      upload(buildPdf(['Three']), { filename: 'c.pdf', batchId: batch.id }),
    ]);

    // Every upload comes back queued, immediately, without rendering.
    for (const document of uploaded) {
      expect(document.status).toBe('queued');
      expect(document.batchId).toBe(batch.id);
    }

    const settled = await waitForBatch(batch.id);

    expect(settled.documentCount).toBe(3);
    expect(settled.counts.ready).toBe(3);
    expect(settled.counts.error).toBe(0);
    expect(settled.progress).toBe(100);
    expect(settled.documents.every((document) => document.status === 'ready')).toBe(true);
  });

  it('counts a failed document as finished rather than stuck', async () => {
    const batch = await createBatch('one good one broken');

    const good = await upload(buildPdf(['Fine']), { filename: 'good.pdf', batchId: batch.id });
    const doomed = await upload(buildPdf(['Also fine']), {
      filename: 'doomed.pdf',
      batchId: batch.id,
    });

    // Remove the stored PDF before the worker reaches it, which is what a
    // disk failure looks like from inside the job.
    await fs.rm(path.join(uploadsDir, doomed.id, 'original.pdf'), { force: true });

    const settled = await waitForBatch(batch.id);

    expect(settled.status).toBe('complete');
    expect(settled.documentCount).toBe(2);
    // The good one must not be held up by the broken one.
    expect(settled.documents.find((d) => d.id === good.id)?.status).toBe('ready');

    const failed = settled.documents.find((d) => d.id === doomed.id);
    expect(failed?.status).toBe('error');
    expect(failed?.errorMessage).toBeTruthy();
    // A document that failed is 100% done, not stalled at 40%.
    expect(failed?.progress).toBe(100);
  });

  it('still processes a document uploaded without a batch', async () => {
    const document = await upload(buildPdf(['No batch']), { filename: 'loose.pdf' });

    expect(document.batchId).toBeUndefined();
    expect((await waitForDocument(document.id)).status).toBe('ready');
  });
});

describe('DELETE /api/batches/:id', () => {
  it('removes the batch, its documents and their files', async () => {
    const batch = await createBatch('to delete');
    const document = await upload(buildPdf(['Bye']), { batchId: batch.id });
    await waitForBatch(batch.id);

    const response = await fetch(`${baseUrl}/api/batches/${batch.id}`, { method: 'DELETE' });
    const body = (await response.json()) as ApiResponse<{ documentsDeleted: number }>;

    expect(response.status).toBe(200);
    expect(body.data?.documentsDeleted).toBe(1);

    expect((await fetch(`${baseUrl}/api/batches/${batch.id}`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/documents/${document.id}`)).status).toBe(404);
    await expect(fs.stat(path.join(uploadsDir, document.id))).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Automatic field detection
// ---------------------------------------------------------------------------

describe('automatic field detection', () => {
  it('pre-fills the fields an invoice declares', async () => {
    const document = await upload(buildInvoicePdf(), { filename: 'acme.pdf' });
    await waitForDocument(document.id);

    const regions = await listRegions(document.id);
    const byType = Object.fromEntries(
      regions.map((region) => [region.fieldType, textOf(region)]),
    );

    expect(byType.INVOICE_NUMBER).toBe('INV-2026-0042');
    expect(byType.INVOICE_DATE).toBe('14 March 2026');
    expect(byType.PO_NUMBER).toBe('PO-88123');
    expect(byType.SUBTOTAL).toBe('4200.00');
    expect(byType.TAX).toBe('840.00');
    expect(byType.TOTAL).toBe('5040.00');
    expect(byType.VENDOR_NAME).toBe('ACME Supply Co');
  });

  it('handles a two-column layout where the value is its own run', async () => {
    const document = await upload(buildColumnarInvoicePdf(), { filename: 'northwind.pdf' });
    await waitForDocument(document.id);

    const regions = await listRegions(document.id);
    const byType = Object.fromEntries(
      regions.map((region) => [region.fieldType, textOf(region)]),
    );

    expect(byType.INVOICE_NUMBER).toBe('NW-99120');
    expect(byType.INVOICE_DATE).toBe('2026-03-14');
    expect(byType.DUE_DATE).toBe('2026-04-13');
    expect(byType.TOTAL).toBe('1,500.00');
    expect(byType.VENDOR_NAME).toBe('Northwind Traders Ltd');
  });

  it('marks detected regions for review and reads them from the text layer', async () => {
    const document = await upload(buildInvoicePdf());
    await waitForDocument(document.id);

    for (const region of await listRegions(document.id)) {
      expect(region.autoDetected).toBe(true);
      expect(region.textSource).toBe('TEXT_LAYER');
      expect(region.ocrStatus).toBe('DONE');
      expect(region.confidence).toBeGreaterThan(0);
    }
  });

  it('draws every detected region inside its page', async () => {
    const document = await upload(buildInvoicePdf());
    await waitForDocument(document.id);

    for (const region of await listRegions(document.id)) {
      expect(region.x).toBeGreaterThanOrEqual(0);
      expect(region.y).toBeGreaterThanOrEqual(0);
      expect(region.x + region.width).toBeLessThanOrEqual(1);
      expect(region.y + region.height).toBeLessThanOrEqual(1);
    }
  });

  it('stops flagging a detected region once a person edits it', async () => {
    const document = await upload(buildInvoicePdf());
    await waitForDocument(document.id);

    const total = regionFor(await listRegions(document.id), 'TOTAL');
    expect(total?.autoDetected).toBe(true);

    const response = await fetch(
      `${baseUrl}/api/documents/${document.id}/regions/${total!.id}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ correctedText: '5040.00' }),
      },
    );
    const body = (await response.json()) as ApiResponse<{ region: Region }>;

    expect(response.status).toBe(200);
    expect(body.data?.region.autoDetected).toBe(false);
  });

  it('detects nothing on a page with no invoice fields', async () => {
    const document = await upload(buildProsePdf(), { filename: 'letter.pdf' });
    await waitForDocument(document.id);

    const regions = await listRegions(document.id);
    // The vendor guess is positional and may still fire; no labelled field should.
    expect(regions.filter((region) => region.fieldType !== 'VENDOR_NAME')).toEqual([]);
  });

  it('reports the detected count on the batch', async () => {
    const batch = await createBatch('detection count');
    await upload(buildInvoicePdf(), { batchId: batch.id });
    const settled = await waitForBatch(batch.id);

    expect(settled.detectedFieldCount).toBeGreaterThanOrEqual(6);
  });
});

// ---------------------------------------------------------------------------
// Duplicates
// ---------------------------------------------------------------------------

describe('duplicate detection', () => {
  it('flags a second upload of the same bytes without refusing it', async () => {
    const bytes = buildPdf(['Same file']);

    const first = await upload(bytes, { filename: 'first.pdf' });
    const second = await upload(bytes, { filename: 'second.pdf' });

    expect(first.duplicateOf).toBeUndefined();
    expect(second.duplicateOf).toBe(first.id);
    // Flagged, not blocked: it is still processed like any other upload.
    expect((await waitForDocument(second.id)).status).toBe('ready');
  });

  it('does not flag different files', async () => {
    const first = await upload(buildPdf(['One']), { filename: 'one.pdf' });
    const second = await upload(buildPdf(['Two']), { filename: 'two.pdf' });

    expect(second.duplicateOf).toBeUndefined();
    expect(first.contentHash).not.toBe(second.contentHash);
  });
});

// ---------------------------------------------------------------------------
// Live progress
// ---------------------------------------------------------------------------

describe('WebSocket progress', () => {
  /** Collect events until `done` says enough, or the timeout expires. */
  async function collect(
    query: string,
    trigger: () => Promise<void>,
    done: (events: ProcessingEvent[]) => boolean,
    timeoutMs = 20_000,
  ): Promise<ProcessingEvent[]> {
    const { WebSocket } = await import('ws');
    const socket = new WebSocket(`${wsUrl}${query}`);
    const events: ProcessingEvent[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });

    const finished = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      socket.on('message', (raw: Buffer) => {
        const message = JSON.parse(raw.toString()) as ProcessingEvent | { type: 'connected' };
        if (message.type === 'connected') return;
        events.push(message as ProcessingEvent);
        if (done(events)) {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await trigger();
    await finished;
    socket.close();
    return events;
  }

  it('pushes a document from queued through progress to ready', async () => {
    const batch = await createBatch('ws progress');

    const events = await collect(
      `?batchId=${batch.id}`,
      async () => {
        await upload(buildPdf(['Watch me']), { batchId: batch.id });
      },
      (collected) => collected.some((event) => event.type === 'batch.complete'),
    );

    const types = events.map((event) => event.type);
    expect(types).toContain('document.queued');
    expect(types).toContain('document.progress');
    expect(types).toContain('document.ready');
    expect(types).toContain('batch.complete');

    // Progress only ever moves forwards.
    const percentages = events
      .filter((event): event is Extract<ProcessingEvent, { type: 'document.progress' }> =>
        event.type === 'document.progress',
      )
      .map((event) => event.progress);
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b));

    const ready = events.find(
      (event): event is Extract<ProcessingEvent, { type: 'document.ready' }> =>
        event.type === 'document.ready',
    );
    expect(ready?.document.status).toBe('ready');
    expect(ready?.document.progress).toBe(100);
  });

  it('delivers only the batch a client asked for', async () => {
    const watched = await createBatch('watched');
    const other = await createBatch('other');

    const events = await collect(
      `?batchId=${watched.id}`,
      async () => {
        await upload(buildPdf(['Other batch']), { batchId: other.id });
        await upload(buildPdf(['Watched batch']), { batchId: watched.id });
      },
      (collected) => collected.some((event) => event.type === 'batch.complete'),
    );

    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.batchId).toBe(watched.id);
    }
  });

  it('reports a failure rather than going quiet', async () => {
    const batch = await createBatch('ws failure');

    const events = await collect(
      `?batchId=${batch.id}`,
      async () => {
        const document = await upload(buildPdf(['Doomed']), { batchId: batch.id });
        await fs.rm(path.join(uploadsDir, document.id, 'original.pdf'), { force: true });
      },
      (collected) => collected.some((event) => event.type === 'document.error'),
    );

    expect(events.map((event) => event.type)).toContain('document.error');
  });

  it('refuses an upgrade on any other path', async () => {
    const { WebSocket } = await import('ws');
    const socket = new WebSocket(`${wsUrl.replace('/ws', '/not-ws')}`);

    await expect(
      new Promise<void>((resolve, reject) => {
        socket.once('open', () => resolve());
        socket.once('error', reject);
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Restart recovery
// ---------------------------------------------------------------------------

describe('recovery after a restart', () => {
  it('returns a document stranded mid-render to the queue', async () => {
    const { getPrisma } = await import('../db/client.js');
    const { resetInterruptedProcessing } = await import('../services/documentStore.js');

    const document = await upload(buildPdf(['Interrupted']));
    await waitForDocument(document.id);

    // Put it back the way a crash during rendering would leave it.
    await getPrisma().document.update({
      where: { id: document.id },
      data: { status: 'processing', progress: 40 },
    });

    const recovered = await resetInterruptedProcessing();

    expect(recovered).toContain(document.id);
    // Week 1-4 marked these failed; the queue can simply run them again.
    const reset = await fetchDocument(document.id);
    expect(reset.status).toBe('queued');
    expect(reset.progress).toBe(0);
  });

  it('re-queues everything still waiting', async () => {
    const { getPrisma } = await import('../db/client.js');
    const { enqueuePending } = await import('../queue/documentQueue.js');

    const document = await upload(buildPdf(['Waiting']));
    await waitForDocument(document.id);
    await getPrisma().document.update({
      where: { id: document.id },
      data: { status: 'queued', progress: 0 },
    });

    expect(await enqueuePending()).toBeGreaterThanOrEqual(1);
    expect((await waitForDocument(document.id)).status).toBe('ready');
  });
});
