import fs from 'node:fs/promises';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { createScheduler, createWorker, type Scheduler } from 'tesseract.js';
import { config } from '../config.js';
import * as store from './documentStore.js';
import { renderPageToPng } from './pdfService.js';
import type { NormalizedRect } from '../types/index.js';
import { processingError } from '../utils/errors.js';

/**
 * Region OCR, backed by Tesseract.js.
 *
 * A region is a fraction of a page, so recognition means: get the page as a
 * bitmap, cut out the rectangle, and hand that crop to Tesseract. Cropping
 * first rather than reading the whole page keeps each call fast and stops text
 * from neighbouring fields bleeding into the result.
 */

export interface OcrResult {
  text: string;
  /** Tesseract's own confidence, 0-100. */
  confidence: number;
}

// --- Worker pool ---------------------------------------------------------

let scheduler: Scheduler | null = null;
let starting: Promise<Scheduler> | null = null;

/**
 * How long the pool has to come up. The first run downloads roughly 5MB of
 * language data, so this is far longer than recognising anything takes.
 */
const STARTUP_TIMEOUT_MS = 120_000;

/** Reject if `work` has not settled within `ms`. */
function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(processingError(`${message} after ${ms}ms`)), ms);
  });

  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Build the worker pool.
 *
 * Everything that can go wrong here happens on the first OCR request of a
 * fresh deployment, when Tesseract fetches its language data: an unreachable
 * network leaves `createWorker` pending indefinitely and reports the failure
 * through `errorHandler` instead of rejecting. So the startup watches for both
 * — a reported worker error and its own deadline — and tears the half-built
 * pool down rather than leaving a request waiting on it.
 */
async function startScheduler(): Promise<Scheduler> {
  await fs.mkdir(config.ocrCacheDir, { recursive: true });
  const created = createScheduler();

  let failStartup: ((error: unknown) => void) | null = null;
  const workerFailed = new Promise<never>((_resolve, reject) => {
    failStartup = (error: unknown) =>
      reject(
        processingError('An OCR worker failed to start', {
          reason: error instanceof Error ? error.message : String(error),
        }),
      );
  });

  const build = (async () => {
    for (let i = 0; i < config.ocrConcurrency; i++) {
      const worker = await createWorker(config.ocrLanguage, undefined, {
        // Without an explicit cache path Tesseract writes its 5MB language
        // file into the current working directory.
        cachePath: config.ocrCacheDir,
        // The default logger prints a progress line per frame.
        logger: () => undefined,
        errorHandler: (error: unknown) => {
          console.error('[ocr] worker error:', error);
          failStartup?.(error);
        },
      });
      created.addWorker(worker);
    }
    return created;
  })();

  try {
    const pool = await withDeadline(
      Promise.race([build, workerFailed]),
      STARTUP_TIMEOUT_MS,
      'OCR workers did not start',
    );
    // Past this point a worker error belongs to whichever job caused it.
    failStartup = null;
    return pool;
  } catch (error) {
    failStartup = null;
    await created.terminate().catch(() => undefined);
    throw error;
  }
}

/**
 * Start the worker pool once, on first use.
 *
 * Workers are expensive to create and hold a WASM instance each, so they are
 * shared across requests rather than built per call. `starting` collapses
 * concurrent first calls onto one initialisation.
 */
async function getScheduler(): Promise<Scheduler> {
  if (scheduler) return scheduler;
  if (starting) return starting;

  starting = startScheduler()
    .then((pool) => {
      scheduler = pool;
      return pool;
    })
    // A failed start is not remembered. The usual cause is the one-off
    // language download failing, and the next request should try again rather
    // than await an attempt that is never going to succeed.
    .finally(() => {
      starting = null;
    });

  return starting;
}

/** Shut the pool down. Called from the server's shutdown handler. */
export async function terminateOcr(): Promise<void> {
  const running = scheduler;
  scheduler = null;
  starting = null;
  if (running) await running.terminate();
}

// --- Cropping ------------------------------------------------------------

/**
 * Cut a normalised rectangle out of a page image and return it as PNG bytes.
 *
 * The page image is rendered on demand if it has not been produced yet, so OCR
 * works on a page the user has never opened.
 */
export async function cropRegionToPng(
  documentId: string,
  pageNumber: number,
  rect: NormalizedRect,
): Promise<Buffer> {
  const imagePath = store.pageImagePath(documentId, pageNumber);

  let pageBytes: Buffer;
  try {
    pageBytes = await fs.readFile(imagePath);
  } catch {
    const pdf = await fs.readFile(store.originalPdfPath(documentId));
    pageBytes = await renderPageToPng(pdf, pageNumber, { dpi: config.pageDpi });
    await fs.mkdir(store.pagesDir(documentId), { recursive: true });
    await fs.writeFile(imagePath, pageBytes);
  }

  const page = await loadImage(pageBytes);

  // Clamp to the page so a rectangle on the boundary cannot ask for pixels
  // outside the bitmap, which would produce a transparent strip.
  const sx = Math.max(0, Math.min(page.width, Math.round(rect.x * page.width)));
  const sy = Math.max(0, Math.min(page.height, Math.round(rect.y * page.height)));
  const sw = Math.max(1, Math.min(page.width - sx, Math.round(rect.width * page.width)));
  const sh = Math.max(1, Math.min(page.height - sy, Math.round(rect.height * page.height)));

  // Upscale narrow crops: pages render at 150dpi but Tesseract expects ~300.
  const scale = sw < config.ocrMinCropWidth ? Math.min(4, config.ocrMinCropWidth / sw) : 1;
  const targetWidth = Math.round(sw * scale);
  const targetHeight = Math.round(sh * scale);

  const canvas = createCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');
  // Paint white first: a transparent background reads as black to Tesseract.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, targetWidth, targetHeight);
  ctx.drawImage(page, sx, sy, sw, sh, 0, 0, targetWidth, targetHeight);

  return canvas.encode('png');
}

// --- Recognition ---------------------------------------------------------

/**
 * Recognise the text inside one region.
 *
 * Throws PROCESSING_ERROR when recognition fails or overruns; the caller
 * records that against the region and carries on with the others.
 */
export async function processRegion(
  documentId: string,
  pageNumber: number,
  rect: NormalizedRect,
): Promise<OcrResult> {
  const crop = await cropRegionToPng(documentId, pageNumber, rect);
  const pool = await getScheduler();

  try {
    const result = await withDeadline(
      pool.addJob('recognize', crop),
      config.ocrTimeoutMs,
      'OCR timed out',
    );
    const data = (result as { data: { text: string; confidence: number } }).data;

    return {
      // Tesseract pads single lines with trailing newlines and spaces.
      text: data.text.trim(),
      confidence: Math.round(data.confidence * 10) / 10,
    };
  } catch (error) {
    if (error instanceof Error && error.name === 'AppError') throw error;
    throw processingError('OCR failed for this region', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
