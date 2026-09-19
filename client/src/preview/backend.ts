/**
 * The whole server, in a tab.
 *
 * Holds the documents, regions and batches the preview build works on, runs
 * the processing pipeline on timers instead of a queue, and publishes the same
 * `ProcessingEvent` frames the real `/ws` endpoint does. Nothing here persists:
 * a reload is a fresh database with the seed documents back in it, which is
 * what you want from a preview and not what you want from a server.
 *
 * `fake-api.ts` is the only thing that should import this — it is the module
 * the components actually see.
 */

import type {
  Batch,
  BatchStatus,
  BatchWithDocuments,
  BatchWithProgress,
  Document,
  DocumentStatus,
  ProcessingEvent,
  Region,
} from '../types';
import { detectedFields, invoiceFacts, pageImageDataUrl } from './invoice';

// ---------------------------------------------------------------------------
// Options, from the query string
// ---------------------------------------------------------------------------

export interface PreviewOptions {
  /** Stretch every simulated delay, to watch a transition properly. */
  slow: boolean;
  /** Fail every nth uploaded document, to exercise the error states. 0 = none. */
  failEvery: number;
}

function readOptions(): PreviewOptions {
  const params = new URLSearchParams(window.location.search);
  const fail = params.get('fail');
  return {
    slow: params.has('slow'),
    failEvery: fail === null ? 0 : Math.max(0, Number.parseInt(fail, 10) || 4),
  };
}

export const options: PreviewOptions = readOptions();

const pace = (ms: number): number => (options.slow ? ms * 3 : ms);

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, pace(ms));
  });

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const documents = new Map<string, Document>();
const regionsByDocument = new Map<string, Region[]>();
const batches = new Map<string, Batch>();
/** Content hash -> the first document that had those bytes. */
const seenContent = new Map<string, string>();

let counter = 0;
const nextId = (prefix: string): string => {
  counter += 1;
  return `${prefix}_${counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
};

export const getDocument = (id: string): Document | undefined => documents.get(id);

/** Newest first, the order the grid draws in. */
export const listStoredDocuments = (): Document[] =>
  [...documents.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt));

export const getRegions = (documentId: string): Region[] => regionsByDocument.get(documentId) ?? [];

export function setRegions(documentId: string, regions: Region[]): void {
  regionsByDocument.set(documentId, regions);
}

export function putDocument(document: Document): void {
  documents.set(document.id, document);
}

export function removeDocument(id: string): boolean {
  regionsByDocument.delete(id);
  return documents.delete(id);
}

export const getBatch = (id: string): Batch | undefined => batches.get(id);

export function putBatch(batch: Batch): void {
  batches.set(batch.id, batch);
}

export function removeBatch(id: string): number {
  const owned = [...documents.values()].filter((document) => document.batchId === id);
  for (const document of owned) removeDocument(document.id);
  batches.delete(id);
  return owned.length;
}

export function openBatch(name: string): Batch {
  const now = new Date().toISOString();
  const batch: Batch = { id: nextId('batch'), name, status: 'queued', createdAt: now, updatedAt: now };
  batches.set(batch.id, batch);
  return batch;
}

// ---------------------------------------------------------------------------
// Derived batch views
// ---------------------------------------------------------------------------

const documentsInBatch = (batchId: string): Document[] =>
  [...documents.values()].filter((document) => document.batchId === batchId);

export function batchProgress(batchId: string): BatchWithProgress | undefined {
  const batch = batches.get(batchId);
  if (batch === undefined) return undefined;

  const owned = documentsInBatch(batchId);
  const counts: Record<DocumentStatus, number> = { queued: 0, processing: 0, ready: 0, error: 0 };
  for (const document of owned) counts[document.status] += 1;

  const detected = owned.reduce(
    (sum, document) => sum + getRegions(document.id).filter((region) => region.autoDetected).length,
    0,
  );

  return {
    ...batch,
    documentCount: owned.length,
    counts,
    progress:
      owned.length === 0
        ? 0
        : Math.round(owned.reduce((sum, document) => sum + document.progress, 0) / owned.length),
    detectedFieldCount: detected,
  };
}

export function batchWithDocuments(batchId: string): BatchWithDocuments | undefined {
  const progress = batchProgress(batchId);
  if (progress === undefined) return undefined;
  return {
    ...progress,
    documents: documentsInBatch(batchId).sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    ),
  };
}

function setBatchStatus(batchId: string, status: BatchStatus): void {
  const batch = batches.get(batchId);
  if (batch === undefined || batch.status === status) return;
  batches.set(batchId, { ...batch, status, updatedAt: new Date().toISOString() });
}

// ---------------------------------------------------------------------------
// The event bus
// ---------------------------------------------------------------------------

interface Subscriber {
  /** Undefined means "everything", which is what the document list listens to. */
  batchId: string | undefined;
  deliver: (event: ProcessingEvent) => void;
}

const subscribers = new Set<Subscriber>();

export function subscribe(subscriber: Subscriber): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function publish(event: ProcessingEvent): void {
  for (const subscriber of [...subscribers]) {
    if (subscriber.batchId === undefined || subscriber.batchId === event.batchId) {
      subscriber.deliver(event);
    }
  }
}

/** Announce a batch's state, and say so when it has nothing left to do. */
function publishBatch(batchId: string): void {
  const progress = batchProgress(batchId);
  if (progress === undefined) return;

  const settled = progress.counts.ready + progress.counts.error;
  const done = progress.documentCount > 0 && settled === progress.documentCount;
  const started = progress.counts.processing > 0 || settled > 0;

  setBatchStatus(batchId, done ? 'complete' : started ? 'processing' : 'queued');

  // Re-read: the status is part of the frame, and it has just changed.
  const current = batchProgress(batchId);
  if (current === undefined) return;
  publish(
    done
      ? { type: 'batch.complete', batchId, batch: current }
      : { type: 'batch.progress', batchId, batch: current },
  );
}

/**
 * The batch's current state, as the events that would have produced it.
 *
 * Sent to a socket the moment it subscribes. The real server does not do this
 * — it has a database the client can refetch from instead — but here the tab
 * is the database, and a client that connects mid-batch would otherwise sit on
 * whatever it last heard. The fold in `state/processing.ts` is built to take
 * repeats, so replaying costs nothing.
 */
export function snapshotEvents(batchId: string): ProcessingEvent[] {
  const progress = batchProgress(batchId);
  if (progress === undefined) return [];

  const events: ProcessingEvent[] = documentsInBatch(batchId).map((document): ProcessingEvent =>
    document.status === 'ready'
      ? {
          type: 'document.ready',
          batchId,
          document,
          detectedFields: getRegions(document.id).length,
        }
      : { type: 'document.queued', batchId, document },
  );

  events.push(
    progress.status === 'complete'
      ? { type: 'batch.complete', batchId, batch: progress }
      : { type: 'batch.progress', batchId, batch: progress },
  );
  return events;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** Where the bar stops on the way up. The real job reports about this often. */
const PROGRESS_STEPS = [6, 23, 44, 67, 88];
const STEP_MS = 420;
/** Long enough for the app to move its socket onto the new batch first. */
const PICKUP_MS = 1100;
const STAGGER_MS = 260;

/** Fill in a document the way the processing job leaves it. */
function finishDocument(document: Document): Document {
  const fields = detectedFields(document.id);
  const now = new Date().toISOString();

  setRegions(
    document.id,
    fields.map((field): Region => ({
      id: nextId('rgn'),
      documentId: document.id,
      pageNumber: field.pageNumber,
      fieldType: field.fieldType,
      ...field.rect,
      textSource: 'TEXT_LAYER',
      ocrStatus: 'DONE',
      rawText: field.text,
      autoDetected: true,
      createdAt: now,
      updatedAt: now,
    })),
  );

  return {
    ...document,
    status: 'ready',
    progress: 100,
    thumbnailUrl: pageImageDataUrl(document.id, 1),
  };
}

/**
 * Walk one document through the queue.
 *
 * Timers rather than a job runner: the point is the sequence of frames the UI
 * has to cope with, not the scheduling.
 */
export function processDocument(document: Document, slot: number): void {
  const batchId = document.batchId ?? null;
  const shouldFail = options.failEvery > 0 && (slot + 1) % options.failEvery === 0;

  let at = PICKUP_MS + slot * STAGGER_MS;

  for (const progress of PROGRESS_STEPS) {
    window.setTimeout(() => {
      const current = documents.get(document.id);
      if (current === undefined || current.status === 'ready' || current.status === 'error') return;

      documents.set(document.id, { ...current, status: 'processing', progress });
      publish({ type: 'document.progress', batchId, documentId: document.id, progress });
      if (batchId !== null) publishBatch(batchId);
    }, pace(at));
    at += STEP_MS;
  }

  window.setTimeout(() => {
    const current = documents.get(document.id);
    if (current === undefined) return;

    if (shouldFail) {
      const message = 'Rendering failed: the file is not a readable PDF.';
      documents.set(document.id, { ...current, status: 'error', progress: 100, errorMessage: message });
      publish({ type: 'document.error', batchId, documentId: document.id, message });
    } else {
      const finished = finishDocument(current);
      documents.set(finished.id, finished);
      publish({
        type: 'document.ready',
        batchId,
        document: finished,
        detectedFields: getRegions(finished.id).length,
      });
    }

    if (batchId !== null) publishBatch(batchId);
  }, pace(at));
}

/** Accept a file and hand it to the queue, as `POST /api/documents/upload` does. */
export function acceptUpload(file: File, batchId: string | undefined): Document {
  const id = nextId('doc');
  // Position in the batch, so a drop of ten files is worked through in order
  // rather than all ten finishing on the same tick.
  const slot = batchId === undefined ? 0 : documentsInBatch(batchId).length;
  // The server hashes the bytes; name and size identify a re-drop just as well
  // and do not need the file read.
  const fingerprint = `${file.name}:${file.size}`;
  const duplicateOf = seenContent.get(fingerprint);
  if (duplicateOf === undefined) seenContent.set(fingerprint, id);

  const document: Document = {
    id,
    ...(batchId === undefined ? {} : { batchId }),
    filename: `${id}.pdf`,
    originalName: file.name,
    mimeType: file.type === '' ? 'application/pdf' : file.type,
    size: file.size,
    // The real server reads this from the PDF; here it only has to be plausible.
    pageCount: 1 + (file.size % 3),
    uploadPath: `/uploads/${id}.pdf`,
    createdAt: new Date().toISOString(),
    status: 'queued',
    progress: 0,
    contentHash: fingerprint,
    ...(duplicateOf === undefined ? {} : { duplicateOf }),
  };

  documents.set(id, document);
  publish({ type: 'document.queued', batchId: batchId ?? null, document });
  if (batchId !== undefined) publishBatch(batchId);

  processDocument(document, slot);
  return document;
}

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

/**
 * The ids are load-bearing: everything about a document is derived from its
 * id, and these three happen to land on three different vendors. Renaming them
 * still works, it just makes the grid less interesting to look at.
 */
const SEEDS: { id: string; size: number; pageCount: number }[] = [
  { id: 'doc_seed_1', size: 184_320, pageCount: 2 },
  { id: 'doc_seed_2', size: 96_512, pageCount: 1 },
  { id: 'doc_seed_3', size: 241_664, pageCount: 2 },
];

/** `Beacon Paper & Print` + `INV-2026-8364` -> `beacon-paper-print-8364.pdf`. */
function seedFilename(id: string): string {
  const facts = invoiceFacts(id);
  const vendor = facts.vendor.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${vendor}-${facts.number.slice(facts.number.lastIndexOf('-') + 1)}.pdf`;
}

/**
 * Put a few processed documents on the server before anyone uploads anything.
 *
 * An empty preview is a preview of the empty state, which is the one screen
 * nobody needs help imagining.
 */
function seed(): void {
  const start = Date.UTC(2026, 2, 14, 9, 0, 0);
  SEEDS.forEach((entry, index) => {
    putDocument(
      finishDocument({
        id: entry.id,
        filename: `${entry.id}.pdf`,
        // Named after the invoice it actually contains, so the grid's captions
        // match the pages behind them.
        originalName: seedFilename(entry.id),
        mimeType: 'application/pdf',
        size: entry.size,
        pageCount: entry.pageCount,
        uploadPath: `/uploads/${entry.id}.pdf`,
        createdAt: new Date(start + index * 11 * 60_000).toISOString(),
        status: 'ready',
        progress: 100,
      }),
    );
  });
}

seed();

// ---------------------------------------------------------------------------
// The WebSocket stand-in
// ---------------------------------------------------------------------------

export const PREVIEW_SOCKET_ORIGIN = 'ws://clurkpdf.preview';

const NativeWebSocket = window.WebSocket;

/**
 * A `WebSocket` for the progress channel that never leaves the tab.
 *
 * Only the surface `useProcessingEvents` touches is implemented, plus enough
 * of the rest that nothing else trips over it. Sockets to any other URL — the
 * dev server's own HMR channel, notably — are handed straight to the real
 * implementation.
 */
class PreviewSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  // Annotated: inferred from the static it starts at, this would be the
  // literal type 0 and could never be moved on to OPEN.
  readyState: number = PreviewSocket.CONNECTING;

  onopen: ((event: Event) => unknown) | null = null;
  onmessage: ((event: MessageEvent<string>) => unknown) | null = null;
  onerror: ((event: Event) => unknown) | null = null;
  onclose: ((event: CloseEvent) => unknown) | null = null;

  private unsubscribe: (() => void) | null = null;

  constructor(url: string | URL, protocols?: string | string[]) {
    const href = typeof url === 'string' ? url : url.href;
    this.url = href;

    if (!href.startsWith(PREVIEW_SOCKET_ORIGIN)) {
      return new NativeWebSocket(href, protocols) as unknown as PreviewSocket;
    }

    const batchId = new URL(href).searchParams.get('batchId') ?? undefined;

    window.setTimeout(() => {
      if (this.readyState !== PreviewSocket.CONNECTING) return;
      this.readyState = PreviewSocket.OPEN;

      this.unsubscribe = subscribe({
        batchId,
        deliver: (event) => this.frame(event),
      });

      this.onopen?.(new Event('open'));
      // The server greets a new connection before any events; the hook is
      // expected to ignore it, so the preview sends it too.
      this.onmessage?.(new MessageEvent('message', { data: JSON.stringify({ type: 'connected' }) }));

      // Catch the new subscriber up. See `snapshotEvents`.
      if (batchId !== undefined) for (const event of snapshotEvents(batchId)) this.frame(event);
    }, pace(120));
  }

  private frame(event: ProcessingEvent): void {
    if (this.readyState !== PreviewSocket.OPEN) return;
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(event) }));
  }

  /** The progress channel is one-way; the real client never sends either. */
  send(): void {}

  close(): void {
    if (this.readyState === PreviewSocket.CLOSED) return;
    this.readyState = PreviewSocket.CLOSED;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.onclose?.(new CloseEvent('close', { code: 1000, wasClean: true }));
  }

  addEventListener(): void {}
  removeEventListener(): void {}
}

let installed = false;

/** Swap the global `WebSocket` for the stand-in. Safe to call more than once. */
export function installPreviewSocket(): void {
  if (installed) return;
  installed = true;
  window.WebSocket = PreviewSocket as unknown as typeof WebSocket;
}
