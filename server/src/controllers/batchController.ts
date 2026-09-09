import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { Request, Response } from 'express';
import { enqueueExtraction } from '../queue/documentQueue.js';
import * as batches from '../services/batchService.js';
import * as store from '../services/documentStore.js';
import { getPageCount } from '../services/pdfService.js';
import type { ApiResponse, Document } from '../types/index.js';
import { noFileUploaded, processingError } from '../utils/errors.js';
import { assertUuid, sanitizeFilename } from '../utils/validation.js';

const ok = <T>(res: Response, data: T, status = 200): void => {
  const body: ApiResponse<T> = { success: true, data };
  res.status(status).json(body);
};

/**
 * POST /api/batches
 *
 * Takes many PDFs at once, stores them, and answers immediately with every
 * document in `queued`. The work happens in the queue; the client follows it
 * over the WebSocket, or by polling this batch.
 *
 * A file that is not a readable PDF is rejected on its own and the rest of the
 * batch still goes through — losing forty-nine good invoices because the
 * fiftieth was a Word document would be a poor trade.
 */
export async function createBatch(req: Request, res: Response): Promise<void> {
  const files = Array.isArray(req.files) ? req.files : [];
  if (files.length === 0) throw noFileUploaded();

  const name = typeof req.body?.name === 'string' ? req.body.name.slice(0, 200) : undefined;
  const batch = await batches.createBatch(name);

  const documents: Document[] = [];
  const rejected: Array<{ filename: string; reason: string }> = [];

  for (const file of files) {
    try {
      documents.push(await storeQueuedDocument(file, batch.id));
    } catch (error) {
      rejected.push({
        filename: file.originalname,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const document of documents) {
    await enqueueExtraction({ documentId: document.id, batchId: batch.id });
  }

  ok(
    res,
    {
      batch: {
        id: batch.id,
        ...(name === undefined ? {} : { name }),
        createdAt: batch.createdAt.toISOString(),
        documents,
        counts: batches.countByStatus(documents),
      },
      rejected,
    },
    201,
  );
}

/** Write one uploaded file to disk and record it as queued. */
async function storeQueuedDocument(
  file: Express.Multer.File,
  batchId: string,
): Promise<Document> {
  const id = randomUUID();
  // Rejects an unreadable PDF before anything is written.
  const pageCount = await getPageCount(file.buffer);

  try {
    await fs.mkdir(store.pagesDir(id), { recursive: true });
    await fs.writeFile(store.originalPdfPath(id), file.buffer);
  } catch (error) {
    await store.removeFilesOnly(id);
    throw processingError('Failed to store the uploaded file', {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  return store.create({
    id,
    filename: sanitizeFilename(file.originalname),
    originalName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    pageCount,
    uploadPath: `${id}/original.pdf`,
    createdAt: new Date().toISOString(),
    status: 'queued',
    batchId,
  });
}

/** GET /api/batches */
export async function listBatches(_req: Request, res: Response): Promise<void> {
  ok(res, await batches.listBatches());
}

/** GET /api/batches/:id */
export async function getBatch(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  ok(res, await batches.getBatch(id));
}
