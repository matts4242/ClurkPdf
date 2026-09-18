import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { queueDocument } from '../queue/documentQueue.js';
import { assertBatchExists } from '../services/batchService.js';
import * as store from '../services/documentStore.js';
import { getPageCount, renderPageToPng } from '../services/pdfService.js';
import type { ApiResponse, Document } from '../types/index.js';
import {
  documentNotFound,
  noFileUploaded,
  pageNotFound,
  processingError,
  queueUnavailable,
} from '../utils/errors.js';
import { assertUuid, parsePageNumber, sanitizeFilename } from '../utils/validation.js';

const ok = <T>(res: Response, data: T, status = 200): void => {
  const body: ApiResponse<T> = { success: true, data };
  res.status(status).json(body);
};

/**
 * POST /api/documents/upload
 *
 * Validates and stores the PDF, then hands it to the processing queue and
 * answers immediately with the document in `queued` state. Rendering happens
 * on a worker; progress arrives over the WebSocket. Parse failures are
 * synchronous (422) because there is nothing worth storing; render failures
 * surface later as `status: 'error'` on the document, since by then the upload
 * itself succeeded.
 *
 * `batchId` on the form attaches the upload to a batch opened beforehand. Sent
 * without one, the document is processed just the same and simply belongs to
 * no batch.
 */
export async function uploadDocument(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) throw noFileUploaded();

  const batchId = readBatchId(req);
  if (batchId !== undefined) await assertBatchExists(batchId);

  const id = randomUUID();
  const filename = sanitizeFilename(file.originalname);

  // Reject unparseable PDFs before anything is written to disk.
  const pageCount = await getPageCount(file.buffer);

  const contentHash = createHash('sha256').update(file.buffer).digest('hex');
  const duplicateOf = await store.findDuplicate(contentHash);

  try {
    await fs.mkdir(store.pagesDir(id), { recursive: true });
    await fs.writeFile(store.originalPdfPath(id), file.buffer);
  } catch (error) {
    // Nothing is in the database yet, so only the partial files need clearing.
    await store.removeFilesOnly(id);
    throw processingError('Failed to store the uploaded file', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const document: Document = {
    id,
    filename,
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    pageCount,
    uploadPath: `${id}/original.pdf`,
    createdAt: new Date().toISOString(),
    status: 'queued',
    progress: 0,
    ...(batchId === undefined ? {} : { batchId }),
    contentHash,
  };

  const created = await store.create(document, {
    ...(batchId === undefined ? {} : { batchId }),
    contentHash,
  });

  try {
    await queueDocument(created);
  } catch (error) {
    // The bytes are stored and the row exists, but nothing will pick it up.
    // Say so now rather than leaving a document queued forever.
    await store.setStatus(id, 'error', {
      errorMessage: 'Could not reach the processing queue',
      progress: 100,
    });
    throw queueUnavailable({ reason: error instanceof Error ? error.message : String(error) });
  }

  ok(res, { ...created, ...(duplicateOf === undefined ? {} : { duplicateOf }) }, 201);
}

/** `batchId` arrives as a multipart field beside the file. */
function readBatchId(req: Request): string | undefined {
  const raw = (req.body as { batchId?: unknown } | undefined)?.batchId;
  if (raw === undefined || raw === '') return undefined;
  return assertUuid(typeof raw === 'string' ? raw : String(raw));
}

/**
 * GET /api/documents/:id
 *
 * Includes the region counts Week 2 added, so the client can show which pages
 * already have work on them without a second request.
 */
export async function getDocument(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const document = await store.getWithStats(id);
  if (!document) throw documentNotFound(id);
  ok(res, document);
}

/** GET /api/documents */
export async function listDocuments(_req: Request, res: Response): Promise<void> {
  ok(res, await store.list());
}

/**
 * GET /api/documents/:id/pages/:pageNumber
 *
 * Streams the page as PNG, rendering it on demand the first time it is asked
 * for. Only rendered images are ever served; the original PDF is not exposed.
 */
export async function getDocumentPage(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const pageNumber = parsePageNumber(req.params.pageNumber);

  const document = await store.get(id);
  if (!document) throw documentNotFound(id);
  if (pageNumber > document.pageCount) throw pageNotFound(pageNumber, document.pageCount);

  const imagePath = store.pageImagePath(id, pageNumber);
  let png: Buffer;
  try {
    png = await fs.readFile(imagePath);
  } catch {
    const source = await fs.readFile(store.originalPdfPath(id)).catch(() => {
      throw documentNotFound(id);
    });
    png = await renderPageToPng(source, pageNumber, { dpi: config.pageDpi });
    await fs.mkdir(store.pagesDir(id), { recursive: true });
    await fs.writeFile(imagePath, png);
  }

  res.type('image/png');
  res.setHeader('Cache-Control', `public, max-age=${config.imageCacheSeconds}, immutable`);
  res.setHeader('Content-Disposition', 'inline');
  res.send(png);
}

/** DELETE /api/documents/:id */
export async function deleteDocument(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const document = await store.get(id);
  if (!document) throw documentNotFound(id);
  await store.remove(id);
  ok(res, { id, deleted: true });
}
