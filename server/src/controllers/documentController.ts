import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import * as store from '../services/documentStore.js';
import { convertPageToImage, getPageCount, renderPageToPng } from '../services/pdfService.js';
import type { ApiResponse, Document } from '../types/index.js';
import {
  documentNotFound,
  noFileUploaded,
  pageNotFound,
  processingError,
} from '../utils/errors.js';
import { assertUuid, parsePageNumber, sanitizeFilename } from '../utils/validation.js';

const ok = <T>(res: Response, data: T, status = 200): void => {
  const body: ApiResponse<T> = { success: true, data };
  res.status(status).json(body);
};

/**
 * POST /api/documents/upload
 *
 * Validates and stores the PDF, then answers immediately with the document in
 * `processing` state. Page 1 renders in the background and flips the status to
 * `ready`, which is what the client polls for. Parse failures are synchronous
 * (422) because there is nothing worth storing; render failures surface as
 * `status: 'error'` on the document, since by then the upload itself succeeded.
 */
export async function uploadDocument(req: Request, res: Response): Promise<void> {
  const file = req.file;
  if (!file) throw noFileUploaded();

  const id = randomUUID();
  const filename = sanitizeFilename(file.originalname);

  // Reject unparseable PDFs before anything is written to disk.
  const pageCount = await getPageCount(file.buffer);

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
    status: 'processing',
  };

  await store.create(document);
  void renderPreview(id);

  ok(res, document, 201);
}

/**
 * Render page 1 at full resolution plus a small thumbnail, then mark the
 * document ready or failed. The thumbnail keeps the batch grid Week 5 adds
 * from pulling a full-size PNG for every document.
 */
async function renderPreview(id: string): Promise<void> {
  try {
    const pdfPath = store.originalPdfPath(id);
    await convertPageToImage(pdfPath, 1, store.pagesDir(id), { dpi: config.pageDpi });

    const source = await fs.readFile(pdfPath);
    const thumbnail = await renderPageToPng(source, 1, { targetWidth: config.thumbnailWidth });
    await fs.writeFile(store.thumbnailPath(id), thumbnail);

    await store.update(id, { status: 'ready', thumbnailUrl: store.thumbnailUrl(id) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[preview] document ${id} failed to render:`, reason);
    await store.setStatus(id, 'error', 'Failed to convert PDF to image');
  }
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
