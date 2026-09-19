/**
 * The preview build's stand-in for `src/api/client.ts`.
 *
 * `vite.preview.config.ts` aliases every `../api/client` import to this file,
 * so the components, hooks and state above it are the real ones — this is the
 * only seam. Keeping the seam at the API boundary rather than somewhere more
 * convenient is the point: everything the preview shows is the behaviour the
 * app actually has, minus the network.
 *
 * `contract.ts` fails the build if this module stops matching the real one.
 */

import type { GenericAbortSignal } from 'axios';
import type {
  ApiError,
  Batch,
  BatchWithDocuments,
  BatchWithProgress,
  CreateRegionInput,
  Document,
  DocumentWithStats,
  FieldType,
  OcrRegionResult,
  Region,
  RunOcrResponse,
  TextLayerData,
  UpdateRegionInput,
} from '../types';
import * as backend from './backend';
import { confidenceFor, pageImageDataUrl, pageTextLayer, textInRect } from './invoice';

backend.installPreviewSocket();

/** There is no server. Kept for parity, and for the text in error messages. */
export const SERVER_ORIGIN = 'preview://in-browser';

/**
 * The same error type the real client throws.
 *
 * Redefined rather than re-exported: importing the real module here would pull
 * axios into the preview bundle and, because the alias rewrites that specifier
 * too, would import this file back into itself.
 */
export class ApiRequestError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = 'ApiRequestError';
    this.code = apiError.code;
    this.details = apiError.details;
  }

  get isRetryable(): boolean {
    return ['NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_ERROR', 'PROCESSING_ERROR'].includes(this.code);
  }
}

const notFound = (what: string): ApiRequestError =>
  new ApiRequestError({ code: 'NOT_FOUND', message: `${what} was not found.` });

/** Run `work` after a short pause, so loading states are actually reachable. */
async function respond<T>(work: () => T, ms = 140): Promise<T> {
  await backend.delay(ms);
  return work();
}

/** Bridge an axios-shaped signal to a callback, tolerating a partial one. */
function whenAborted(signal: GenericAbortSignal | undefined, onAbort: () => void): () => void {
  if (signal === undefined) return () => {};
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  const listener = (): void => onAbort();
  signal.addEventListener?.('abort', listener);
  return () => signal.removeEventListener?.('abort', listener);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

export interface UploadOptions {
  onProgress?: (percent: number) => void;
  signal?: GenericAbortSignal;
  batchId?: string;
}

/** How many progress frames a transfer reports on its way up. */
const UPLOAD_FRAMES = 12;

const cancelled = (what: string): ApiRequestError =>
  new ApiRequestError({ code: 'CANCELLED', message: `${what} cancelled` });

export function uploadDocument(file: File, options: UploadOptions = {}): Promise<Document> {
  if (options.signal?.aborted === true) return Promise.reject(cancelled('Upload'));

  return new Promise<Document>((resolve, reject) => {
    let timer = 0;
    let done = false;

    const release = whenAborted(options.signal, () => {
      if (done) return;
      done = true;
      window.clearInterval(timer);
      reject(cancelled('Upload'));
    });

    let frame = 0;
    timer = window.setInterval(
      () => {
        frame += 1;
        options.onProgress?.(Math.round((frame / UPLOAD_FRAMES) * 100));
        if (frame < UPLOAD_FRAMES) return;

        window.clearInterval(timer);
        release();
        if (done) return;
        done = true;
        resolve(backend.acceptUpload(file, options.batchId));
      },
      backend.options.slow ? 180 : 60,
    );
  });
}

export function fetchDocument(
  id: string,
  signal?: GenericAbortSignal,
): Promise<DocumentWithStats> {
  return abortable(signal, () =>
    respond(() => {
      const document = backend.getDocument(id);
      if (document === undefined) throw notFound('That document');

      const regions = backend.getRegions(id);
      return {
        ...document,
        regionCount: regions.length,
        pagesWithRegions: [...new Set(regions.map((region) => region.pageNumber))].sort(
          (left, right) => left - right,
        ),
      };
    }),
  );
}

export function listDocuments(signal?: GenericAbortSignal): Promise<Document[]> {
  return abortable(signal, () => respond(() => backend.listStoredDocuments()));
}

export function deleteDocument(id: string): Promise<{ id: string; deleted: boolean }> {
  return respond(() => ({ id, deleted: backend.removeDocument(id) }));
}

// ---------------------------------------------------------------------------
// Regions
// ---------------------------------------------------------------------------

let regionCounter = 0;
const newRegionId = (): string => {
  regionCounter += 1;
  return `rgn_live_${regionCounter.toString(36)}`;
};

export function listRegions(
  documentId: string,
  pageNumber?: number,
  signal?: GenericAbortSignal,
): Promise<Region[]> {
  return abortable(signal, () =>
    respond(() => {
      const regions = backend.getRegions(documentId);
      return pageNumber === undefined
        ? regions
        : regions.filter((region) => region.pageNumber === pageNumber);
    }),
  );
}

export function createRegion(documentId: string, input: CreateRegionInput): Promise<Region> {
  return respond(() => {
    if (backend.getDocument(documentId) === undefined) throw notFound('That document');

    const now = new Date().toISOString();
    // `TEXT_LAYER` asks the server to read the PDF's own text under the box,
    // which is exactly what the synthetic page can answer.
    const fromTextLayer =
      input.textSource === 'TEXT_LAYER' ? textInRect(documentId, input.pageNumber, input) : '';

    const region: Region = {
      id: newRegionId(),
      documentId,
      pageNumber: input.pageNumber,
      fieldType: input.fieldType,
      ...(input.fieldLabel === undefined ? {} : { fieldLabel: input.fieldLabel }),
      x: input.x,
      y: input.y,
      width: input.width,
      height: input.height,
      textSource: fromTextLayer === '' ? 'NONE' : 'TEXT_LAYER',
      ocrStatus: fromTextLayer === '' ? 'PENDING' : 'DONE',
      ...(fromTextLayer === '' ? {} : { rawText: fromTextLayer }),
      autoDetected: false,
      createdAt: now,
      updatedAt: now,
    };

    backend.setRegions(documentId, [...backend.getRegions(documentId), region]);
    return region;
  });
}

export function updateRegion(
  documentId: string,
  regionId: string,
  updates: UpdateRegionInput,
): Promise<Region> {
  // Quicker than the rest: this one runs behind a drag, and the canvas has
  // already moved the rectangle optimistically.
  return respond(() => {
    const regions = backend.getRegions(documentId);
    const current = regions.find((region) => region.id === regionId);
    if (current === undefined) throw notFound('That region');

    const updated: Region = { ...current, ...updates, updatedAt: new Date().toISOString() };
    backend.setRegions(
      documentId,
      regions.map((region) => (region.id === regionId ? updated : region)),
    );
    return updated;
  }, 90);
}

export function deleteRegion(documentId: string, regionId: string): Promise<void> {
  return respond(() => {
    const regions = backend.getRegions(documentId);
    if (!regions.some((region) => region.id === regionId)) throw notFound('That region');
    backend.setRegions(
      documentId,
      regions.filter((region) => region.id !== regionId),
    );
  });
}

export interface RunOcrOptions {
  regionIds?: string[];
  onlyPending?: boolean;
}

/**
 * "Recognise" text in a document's regions.
 *
 * Reads the same positioned runs the page image was drawn from, so the answer
 * matches what is visibly inside the box. A box drawn over blank paper comes
 * back as a failure, which is what a real run does with it too.
 */
export function runOcr(documentId: string, options: RunOcrOptions = {}): Promise<RunOcrResponse> {
  return respond(
    () => {
      if (backend.getDocument(documentId) === undefined) throw notFound('That document');

      const regions = backend.getRegions(documentId);
      const targeted = regions.filter((region) => {
        if (options.regionIds !== undefined && !options.regionIds.includes(region.id)) return false;
        if (options.onlyPending === true && region.rawText !== undefined) return false;
        return true;
      });

      const now = new Date().toISOString();
      const results: OcrRegionResult[] = [];
      const updated = new Map<string, Region>();

      for (const region of targeted) {
        const text = textInRect(documentId, region.pageNumber, region);
        if (text === '') {
          results.push({
            regionId: region.id,
            status: 'ERROR',
            error: 'No legible text in this region.',
          });
          updated.set(region.id, {
            ...region,
            ocrStatus: 'ERROR',
            ocrError: 'No legible text in this region.',
            ocrAt: now,
            updatedAt: now,
          });
          continue;
        }

        const confidence = confidenceFor(text);
        results.push({ regionId: region.id, status: 'DONE', text, confidence });
        updated.set(region.id, {
          ...region,
          textSource: 'OCR',
          ocrStatus: 'DONE',
          rawText: text,
          confidence,
          ocrAt: now,
          updatedAt: now,
        });
      }

      backend.setRegions(
        documentId,
        regions.map((region) => updated.get(region.id) ?? region),
      );

      return {
        results,
        succeeded: results.filter((result) => result.status === 'DONE').length,
        failed: results.filter((result) => result.status === 'ERROR').length,
      };
    },
    // Recognition is the slow call in the real app; the preview should feel
    // like it costs something too.
    620,
  );
}

export function fetchTextLayer(
  documentId: string,
  pageNumber: number,
  signal?: GenericAbortSignal,
): Promise<TextLayerData> {
  return abortable(signal, () =>
    respond(() => {
      if (backend.getDocument(documentId) === undefined) throw notFound('That document');
      return pageTextLayer(documentId, pageNumber);
    }),
  );
}

// ---------------------------------------------------------------------------
// Batches
// ---------------------------------------------------------------------------

export interface CreateBatchOptions {
  name?: string;
  fileCount?: number;
}

export function createBatch(options: CreateBatchOptions = {}): Promise<Batch> {
  return respond(() => {
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const counted =
      options.fileCount === undefined
        ? time
        : `${options.fileCount} ${options.fileCount === 1 ? 'file' : 'files'} · ${time}`;
    return backend.openBatch(options.name ?? counted);
  }, 90);
}

export function fetchBatch(id: string, signal?: GenericAbortSignal): Promise<BatchWithDocuments> {
  return abortable(signal, () =>
    respond(() => {
      const batch = backend.batchWithDocuments(id);
      if (batch === undefined) throw notFound('That batch');
      return batch;
    }),
  );
}

export function listBatches(signal?: GenericAbortSignal): Promise<BatchWithProgress[]> {
  return abortable(signal, () =>
    respond(() =>
      backend
        .listStoredDocuments()
        .reduce<string[]>(
          (ids, document) =>
            document.batchId === undefined || ids.includes(document.batchId)
              ? ids
              : [...ids, document.batchId],
          [],
        )
        .flatMap((batchId) => {
          const batch = backend.batchProgress(batchId);
          return batch === undefined ? [] : [batch];
        }),
    ),
  );
}

export function deleteBatch(id: string): Promise<{ documentsDeleted: number }> {
  return respond(() => {
    if (backend.getBatch(id) === undefined) throw notFound('That batch');
    return { documentsDeleted: backend.removeBatch(id) };
  });
}

export function progressSocketUrl(batchId?: string): string {
  const url = new URL('/ws', backend.PREVIEW_SOCKET_ORIGIN);
  if (batchId !== undefined) url.searchParams.set('batchId', batchId);
  return url.toString();
}

export type { FieldType };

export const pageImageUrl = (id: string, pageNumber: number): string =>
  pageImageDataUrl(id, pageNumber);

/** Paths the preview hands out are already data URLs; leave those alone. */
export const absoluteUrl = (relativePath: string): string =>
  relativePath.startsWith('data:') ? relativePath : `${SERVER_ORIGIN}${relativePath}`;

// ---------------------------------------------------------------------------

/**
 * Reject with the client's `CANCELLED` error if the caller aborts first.
 *
 * The hooks tell a cancellation from a failure by that code — `useRegions`
 * swallows it on unmount, `useBatchUpload` declines to retry it — so a mock
 * that resolved anyway would quietly hide the bug where a stale response
 * overwrites a fresh one.
 */
function abortable<T>(signal: GenericAbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  if (signal === undefined) return work();
  if (signal.aborted) return Promise.reject(cancelled('Request'));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const release = whenAborted(signal, () => {
      if (settled) return;
      settled = true;
      reject(cancelled('Request'));
    });

    work().then(
      (value) => {
        release();
        if (!settled) {
          settled = true;
          resolve(value);
        }
      },
      (error: unknown) => {
        release();
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    );
  });
}
