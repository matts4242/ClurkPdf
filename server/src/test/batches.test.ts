import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import type {
  ApiResponse,
  Batch,
  BatchEvent,
  BatchSummary,
  Document,
  ListRegionsResponse,
} from '../types/index.js';
import { buildInvoicePdf, invalidPdfBytes } from './fixtures.js';
import './setup.js';

/**
 * Batch tests.
 *
 * These run the real thing: a real Redis queue, the real worker, and the real
 * WebSocket. A batch that is only tested with the queue stubbed out proves
 * very little, since the whole point of Week 5 is what happens between the
 * upload answering and the documents being ready.
 */

let baseUrl: string;
let wsUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  const { attachBatchEvents } = await import('../ws/batchEvents.js');
  const { startWorker } = await import('../queue/worker.js');

  const server = createApp().listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  attachBatchEvents(server);
  startWorker();

  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port assigned');
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/api/ws`;

  close = () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
}, 30_000);

afterAll(async () => {
  const { stopWorker } = await import('../queue/worker.js');
  const { getQueue, closeQueue } = await import('../queue/documentQueue.js');
  const { closeBatchEvents } = await import('../ws/batchEvents.js');
  const { disconnectRedis } = await import('../queue/connection.js');

  await stopWorker();
  // Leave no jobs behind for the next run to pick up.
  await getQueue().obliterate({ force: true }).catch(() => undefined);
  await closeQueue();
  await closeBatchEvents();
  await disconnectRedis();
  await close?.();
});

async function postBatch(
  files: Array<{ name: string; bytes: Buffer }>,
  name?: string,
): Promise<{ status: number; body: ApiResponse<{ batch: Batch; rejected: unknown[] }> }> {
  const form = new FormData();
  for (const file of files) {
    form.append(
      'files',
      new Blob([new Uint8Array(file.bytes)], { type: 'application/pdf' }),
      file.name,
    );
  }
  if (name !== undefined) form.append('name', name);

  const response = await fetch(`${baseUrl}/api/batches`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

/** Poll the batch until nothing is queued or processing. */
async function waitForBatch(batchId: string, timeoutMs = 60_000): Promise<Batch> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const response = await fetch(`${baseUrl}/api/batches/${batchId}`);
    const body = (await response.json()) as ApiResponse<Batch>;
    const batch = body.data;
    if (!batch) throw new Error('batch disappeared');
    if (batch.counts.queued === 0 && batch.counts.processing === 0) return batch;

    if (Date.now() > deadline) throw new Error(`batch ${batchId} never settled`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('POST /api/batches', () => {
  it('queues every file and answers immediately', async () => {
    const { status, body } = await postBatch(
      [
        { name: 'one.pdf', bytes: buildInvoicePdf() },
        { name: 'two.pdf', bytes: buildInvoicePdf() },
      ],
      'March invoices',
    );

    expect(status).toBe(201);
    const batch = body.data?.batch;
    expect(batch?.name).toBe('March invoices');
    expect(batch?.documents).toHaveLength(2);
    // The upload does no work of its own; that is the whole point of a queue.
    expect(batch?.documents.every((document) => document.status === 'queued')).toBe(true);
    expect(batch?.counts).toMatchObject({ total: 2, queued: 2, ready: 0 });
  });

  it('rejects an unreadable file without losing the rest of the batch', async () => {
    const { body } = await postBatch([
      { name: 'good.pdf', bytes: buildInvoicePdf() },
      { name: 'broken.pdf', bytes: invalidPdfBytes },
    ]);

    expect(body.data?.batch.documents).toHaveLength(1);
    expect(body.data?.rejected).toHaveLength(1);
    expect(body.data?.rejected[0]).toMatchObject({ filename: 'broken.pdf' });
  });

  it('refuses a request with no files at all', async () => {
    const response = await fetch(`${baseUrl}/api/batches`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as ApiResponse<never>).error?.code).toBe('NO_FILE_UPLOADED');
  });
});

describe('the worker', () => {
  it('renders the pages and marks up the usual fields', async () => {
    const { body } = await postBatch([{ name: 'invoice.pdf', bytes: buildInvoicePdf() }]);
    const batchId = body.data?.batch.id;
    expect(batchId).toBeDefined();

    const settled = await waitForBatch(batchId as string);
    expect(settled.counts).toMatchObject({ total: 1, ready: 1, error: 0 });

    const document = settled.documents[0] as Document;
    expect(document.status).toBe('ready');
    // The batch path renders its own thumbnail; nothing else has.
    expect(document.thumbnailUrl).toBe(`/uploads/${document.id}/thumbnail.png`);

    const regions = await fetch(`${baseUrl}/api/documents/${document.id}/regions`)
      .then((response) => response.json() as Promise<ApiResponse<ListRegionsResponse>>)
      .then((body) => body.data?.regions ?? []);

    const byType = new Map(regions.map((region) => [region.fieldType, region]));
    expect([...byType.keys()].sort()).toEqual(
      ['INVOICE_DATE', 'INVOICE_NUMBER', 'PO_NUMBER', 'SUBTOTAL', 'TAX', 'TOTAL', 'VENDOR_NAME'].sort(),
    );

    // Detected regions are read from the PDF's own text, so they are exact.
    expect(byType.get('VENDOR_NAME')?.rawText).toBe('ACME Supply Co');
    expect(byType.get('INVOICE_NUMBER')?.rawText).toBe('Invoice No: INV-2026-0042');
    expect(byType.get('TOTAL')?.rawText).toBe('Total: 5040.00');
    expect(byType.get('TOTAL')?.textSource).toBe('TEXT_LAYER');
    expect(byType.get('TOTAL')?.confidence).toBe(100);
    // "Subtotal" must not be claimed by the total pattern.
    expect(byType.get('SUBTOTAL')?.rawText).toBe('Subtotal: 4200.00');
  }, 60_000);

  it('fails one document without stopping the others', async () => {
    const { body } = await postBatch([
      { name: 'fine.pdf', bytes: buildInvoicePdf() },
      { name: 'also-fine.pdf', bytes: buildInvoicePdf() },
    ]);
    const batchId = body.data?.batch.id as string;

    // Delete one document's PDF out from under the worker.
    const doomed = body.data?.batch.documents[0] as Document;
    const store = await import('../services/documentStore.js');
    const fs = await import('node:fs/promises');
    await fs.rm(store.originalPdfPath(doomed.id), { force: true });

    const settled = await waitForBatch(batchId);
    expect(settled.counts.total).toBe(2);
    expect(settled.counts.ready + settled.counts.error).toBe(2);
    // Whichever way the race went, the batch still finished.
    expect(settled.counts.queued + settled.counts.processing).toBe(0);
  }, 60_000);
});

describe('GET /api/batches', () => {
  it('summarises each batch without its documents', async () => {
    const { body } = await postBatch([{ name: 'listed.pdf', bytes: buildInvoicePdf() }], 'Listed');
    await waitForBatch(body.data?.batch.id as string);

    const summaries = await fetch(`${baseUrl}/api/batches`)
      .then((response) => response.json() as Promise<ApiResponse<BatchSummary[]>>)
      .then((body) => body.data ?? []);

    const listed = summaries.find((summary) => summary.name === 'Listed');
    expect(listed?.counts).toMatchObject({ total: 1, ready: 1 });
    expect(listed?.thumbnailUrls).toHaveLength(1);
  }, 60_000);

  it('answers 404 for a batch that does not exist', async () => {
    const response = await fetch(`${baseUrl}/api/batches/11111111-1111-4111-8111-111111111111`);
    expect(response.status).toBe(404);
    expect(((await response.json()) as ApiResponse<never>).error?.code).toBe('BATCH_NOT_FOUND');
  });
});

describe('the progress socket', () => {
  it('reports each document and then the finished batch', async () => {
    const { body } = await postBatch([
      { name: 'watched-1.pdf', bytes: buildInvoicePdf() },
      { name: 'watched-2.pdf', bytes: buildInvoicePdf() },
    ]);
    const batchId = body.data?.batch.id as string;

    const events: BatchEvent[] = [];
    const socket = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no batch-complete arrived')), 55_000);

      socket.on('open', () => socket.send(JSON.stringify({ subscribe: batchId })));
      socket.on('message', (raw: Buffer) => {
        const event = JSON.parse(raw.toString()) as BatchEvent;
        events.push(event);
        if (event.type === 'batch-complete') {
          clearTimeout(timer);
          resolve();
        }
      });
      socket.on('error', reject);
    });

    socket.close();

    expect(events.some((event) => event.type === 'document')).toBe(true);
    expect(events.every((event) => event.batchId === batchId)).toBe(true);

    const complete = events.at(-1);
    expect(complete?.type).toBe('batch-complete');
    if (complete?.type === 'batch-complete') {
      expect(complete.counts.queued + complete.counts.processing).toBe(0);
      expect(complete.counts.total).toBe(2);
    }
  }, 60_000);
});
