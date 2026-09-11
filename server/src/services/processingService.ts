import fs from 'node:fs/promises';
import { config } from '../config.js';
import { getPrisma } from '../db/client.js';
import { publishEvent } from '../events/bus.js';
import type { DetectedField, Document } from '../types/index.js';
import { detectFields } from './fieldDetector.js';
import * as batches from './batchService.js';
import * as store from './documentStore.js';
import { convertPageToImage, renderPageToPng } from './pdfService.js';
import { getTextLayer } from './textLayerService.js';

/**
 * What the queue actually does to a document.
 *
 * Week 1 did this inline in the upload handler as `void renderPreview(id)`,
 * which meant fifty simultaneous uploads started fifty simultaneous renders
 * and a restart mid-render lost the work for good. The body is the same three
 * steps — render, preview, read — but it now runs under a bounded worker, it
 * reports progress as it goes, and a crash leaves a job to be retried rather
 * than a stranded row.
 *
 * Kept free of any BullMQ types so it can be called directly from a test.
 */

/** Progress milestones, as percentages of the whole job. */
const RENDER_SHARE = 80;
const DETECT_SHARE = 15;

export interface ProcessResult {
  documentId: string;
  pagesRendered: number;
  detectedFields: number;
}

/**
 * Render a document's first pages, then pre-fill the fields it declares.
 *
 * Throws if the document cannot be rendered at all, so the queue can retry it;
 * a failure to *detect* fields is not fatal, because a document with no
 * detected fields is still perfectly usable through the two manual modes.
 */
export async function processDocument(documentId: string): Promise<ProcessResult> {
  const document = await store.get(documentId);
  // Deleted between being queued and being picked up. Not an error.
  if (!document) return { documentId, pagesRendered: 0, detectedFields: 0 };

  await store.setStatus(documentId, 'processing', { progress: 0 });
  await announce(document.batchId ?? null, documentId, 0);

  const pagesRendered = await renderPages(document);
  const detected = await detectAndSaveFields(document).catch((error: unknown) => {
    // Detection is a convenience. Losing it must not fail the upload.
    console.error(
      `[process] field detection failed for ${documentId}:`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  });

  const ready = await store.setStatus(documentId, 'ready', {
    thumbnailUrl: store.thumbnailUrl(documentId),
    progress: 100,
  });

  if (ready) {
    publishEvent({
      type: 'document.ready',
      batchId: ready.batchId ?? null,
      document: ready,
      detectedFields: detected,
    });
  }
  await refreshBatch(document.batchId ?? null);

  return { documentId, pagesRendered, detectedFields: detected };
}

/** Mark a document failed and tell everyone watching. Used when a job gives up. */
export async function failDocument(documentId: string, message: string): Promise<void> {
  const document = await store.setStatus(documentId, 'error', {
    errorMessage: message.slice(0, 500),
    progress: 100,
  });
  if (!document) return;

  publishEvent({
    type: 'document.error',
    batchId: document.batchId ?? null,
    documentId,
    message,
  });
  await refreshBatch(document.batchId ?? null);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Render the first `EAGER_RENDER_PAGES` pages, plus the thumbnail.
 *
 * Not every page: a 200-page PDF would hold a worker for minutes while the
 * rest of a batch waited, and the viewer already renders any page it is asked
 * for on demand. The first few cover the case that matters — the user opens a
 * document straight after it lands and does not want to wait for page 1.
 */
async function renderPages(document: Document): Promise<number> {
  const { id, batchId, pageCount } = document;
  const target = Math.min(pageCount, config.eagerRenderPages);
  const pdfPath = store.originalPdfPath(id);

  await fs.mkdir(store.pagesDir(id), { recursive: true });

  for (let pageNumber = 1; pageNumber <= target; pageNumber += 1) {
    await convertPageToImage(pdfPath, pageNumber, store.pagesDir(id), { dpi: config.pageDpi });

    // Page 1 doubles as the grid thumbnail, so write it as soon as it exists
    // rather than at the end: the grid can then show the document immediately.
    if (pageNumber === 1) {
      const source = await fs.readFile(pdfPath);
      const thumbnail = await renderPageToPng(source, 1, { targetWidth: config.thumbnailWidth });
      await fs.writeFile(store.thumbnailPath(id), thumbnail);
    }

    const progress = Math.round((pageNumber / target) * RENDER_SHARE);
    await store.setProgress(id, progress);
    await announce(batchId ?? null, id, progress);
  }

  return target;
}

/**
 * Read the fields the document declares and save them as regions.
 *
 * Only page 1: invoice headers and totals live there, and scanning every page
 * of a long document for a second "Total" would produce worse guesses, not
 * more of them.
 */
async function detectAndSaveFields(document: Document): Promise<number> {
  const { id, batchId } = document;

  const layer = await getTextLayer(id, 1);
  // A scan has no text layer. Nothing to detect; OCR is the path for those.
  if (!layer.hasText) {
    await store.setProgress(id, RENDER_SHARE + DETECT_SHARE);
    await announce(batchId ?? null, id, RENDER_SHARE + DETECT_SHARE);
    return 0;
  }

  // Re-uploading over a document a user has already worked on must not
  // duplicate the fields they drew themselves.
  const existing = await getPrisma().region.findMany({
    where: { documentId: id },
    select: { fieldType: true },
  });

  const found = detectFields(layer, {
    exclude: existing.map((region) => region.fieldType),
  });

  if (found.length > 0) {
    await getPrisma().region.createMany({
      data: found.map((field) => toRegionRow(id, field)),
    });
  }

  await store.setProgress(id, RENDER_SHARE + DETECT_SHARE);
  await announce(batchId ?? null, id, RENDER_SHARE + DETECT_SHARE);
  return found.length;
}

/**
 * A detected field, as a region row.
 *
 * Written as `TEXT_LAYER`/`DONE` because that is exactly what it is — text
 * taken from the PDF's own layer, not a recognition guess — so the sidebar,
 * the correction panel and Week 7's export all treat it like any other region
 * without a second code path. `autoDetected` is what separates it: the UI
 * marks these for review, since the rectangle came from a regex.
 */
function toRegionRow(documentId: string, field: DetectedField) {
  return {
    documentId,
    pageNumber: field.pageNumber,
    x: field.rect.x,
    y: field.rect.y,
    width: field.rect.width,
    height: field.rect.height,
    fieldType: field.fieldType,
    textSource: 'TEXT_LAYER' as const,
    ocrStatus: 'DONE' as const,
    rawText: field.value,
    confidence: field.confidence,
    ocrAt: new Date(),
    autoDetected: true,
  };
}

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

async function announce(
  batchId: string | null,
  documentId: string,
  progress: number,
): Promise<void> {
  publishEvent({ type: 'document.progress', batchId, documentId, progress });
  if (batchId !== null) {
    const batch = await batches.getBatchWithProgress(batchId).catch(() => undefined);
    if (batch) publishEvent({ type: 'batch.progress', batchId, batch });
  }
}

/** Recompute the batch's own status and announce it, once a document settles. */
async function refreshBatch(batchId: string | null): Promise<void> {
  if (batchId === null) return;

  const batch = await batches.refreshBatchStatus(batchId).catch(() => undefined);
  if (!batch) return;

  publishEvent({
    type: batch.status === 'complete' ? 'batch.complete' : 'batch.progress',
    batchId,
    batch,
  });
}
