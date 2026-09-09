import fs from 'node:fs/promises';
import { config } from '../config.js';
import * as store from '../services/documentStore.js';
import { getCounts, isSettled } from '../services/batchService.js';
import { detectFields } from '../services/fieldDetection.js';
import { convertPageToImage, renderPageToPng } from '../services/pdfService.js';
import { createRegion } from '../services/regionService.js';
import { publish } from '../ws/batchEvents.js';
import type { Document } from '../types/index.js';

/**
 * What a queued document goes through: render every page, guess the usual
 * fields, and report back.
 *
 * The single-file upload path renders page 1 and stops, because someone is
 * waiting to look at it. A batch is the opposite — nobody is watching a
 * particular document — so the work that makes the whole batch usable is done
 * up front: every page becomes an image, and the fields a normal invoice
 * carries are marked out before anyone opens it.
 */

export interface ExtractionResult {
  pagesRendered: number;
  regionsCreated: number;
}

export async function extractInvoice(
  documentId: string,
  batchId: string,
  { finalAttempt = true }: { finalAttempt?: boolean } = {},
): Promise<ExtractionResult> {
  const document = await store.get(documentId);
  // Deleted while it sat in the queue. Nothing to do and nothing to report.
  if (!document) return { pagesRendered: 0, regionsCreated: 0 };

  await announce(batchId, await store.setStatus(documentId, 'processing'));

  try {
    const pdfPath = store.originalPdfPath(documentId);
    for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber++) {
      await convertPageToImage(pdfPath, pageNumber, store.pagesDir(documentId), {
        dpi: config.pageDpi,
      });
    }

    const source = await fs.readFile(pdfPath);
    const thumbnail = await renderPageToPng(source, 1, { targetWidth: config.thumbnailWidth });
    await fs.writeFile(store.thumbnailPath(documentId), thumbnail);

    const regionsCreated = await markDetectedFields(documentId, document.pageCount);

    await announce(
      batchId,
      await store.setStatus(documentId, 'ready', {
        thumbnailUrl: store.thumbnailUrl(documentId),
      }),
    );

    return { pagesRendered: document.pageCount, regionsCreated };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[batch] document ${documentId} failed:`, reason);

    // Only the last attempt marks the document failed; before that it stays
    // `processing`, which is what it is — waiting to be tried again.
    if (finalAttempt) {
      await announce(
        batchId,
        await store.setStatus(documentId, 'error', {
          errorMessage: 'Failed to process this document',
        }),
      );
    }
    throw error;
  }
}

/**
 * Turn detected fields into ordinary regions.
 *
 * They go through `createRegion` with `TEXT_LAYER`, so each one reads its own
 * text from the rectangle and snaps onto it exactly as a hand-drawn highlight
 * does. A detection that lands on empty space simply produces an unread region
 * rather than a wrong value.
 */
async function markDetectedFields(documentId: string, pageCount: number): Promise<number> {
  const fields = await detectFields(documentId, pageCount);

  let created = 0;
  for (const field of fields) {
    try {
      await createRegion(documentId, {
        pageNumber: field.pageNumber,
        ...field.rect,
        fieldType: field.fieldType,
        textSource: 'TEXT_LAYER',
      });
      created += 1;
    } catch (error) {
      // One implausible rectangle should not cost the document its whole run.
      console.error(
        `[batch] could not mark ${field.fieldType} on ${documentId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return created;
}

/**
 * Tell anyone watching the batch that a document moved.
 *
 * With more than one worker two documents can settle at the same moment and
 * both see the batch as finished, so `batch-complete` can arrive twice. The
 * client treats it as a statement of fact rather than a transition, so a
 * repeat costs nothing.
 */
async function announce(batchId: string, document: Document | undefined): Promise<void> {
  if (!document) return;
  publish({ type: 'document', batchId, document });

  const counts = await getCounts(batchId);
  if (isSettled(counts)) publish({ type: 'batch-complete', batchId, counts });
}
