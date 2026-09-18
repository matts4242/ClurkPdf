import type { Request, Response } from 'express';
import * as batches from '../services/batchService.js';
import * as store from '../services/documentStore.js';
import type { ApiResponse, CreateBatchRequest } from '../types/index.js';
import { batchNotFound, invalidRequest } from '../utils/errors.js';
import { assertUuid } from '../utils/validation.js';

const ok = <T>(res: Response, data: T, status = 200): void => {
  const body: ApiResponse<T> = { success: true, data };
  res.status(status).json(body);
};

/**
 * POST /api/batches
 *
 * Opens a batch for the client to upload into. Created before the files are
 * sent rather than inferred from the first upload, so every document in a
 * drop lands in one batch even when they are uploaded in parallel.
 */
export async function createBatch(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as CreateBatchRequest;

  if (body.name !== undefined && typeof body.name !== 'string') {
    throw invalidRequest('`name` must be a string');
  }
  if (
    body.fileCount !== undefined &&
    (!Number.isInteger(body.fileCount) || body.fileCount < 0)
  ) {
    throw invalidRequest('`fileCount` must be a non-negative integer');
  }

  const name = body.name?.trim().slice(0, 120);
  const batch = await batches.createBatch(
    name || batches.defaultBatchName(body.fileCount ?? 0),
  );
  ok(res, { batch }, 201);
}

/** GET /api/batches */
export async function listBatches(_req: Request, res: Response): Promise<void> {
  ok(res, { batches: await batches.listBatches() });
}

/**
 * GET /api/batches/:id
 *
 * The batch, its pipeline counts, and every document in it. This is what a
 * client fetches on load and after a dropped WebSocket, so it has to be enough
 * to draw the whole grid on its own.
 */
export async function getBatch(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const batch = await batches.getBatchWithDocuments(id);
  if (!batch) throw batchNotFound(id);
  ok(res, { batch });
}

/**
 * DELETE /api/batches/:id
 *
 * Removes the batch and everything uploaded into it. The documents go first
 * and individually, because each one owns files on disk that the database
 * cascade knows nothing about.
 */
export async function deleteBatch(req: Request, res: Response): Promise<void> {
  const id = assertUuid(req.params.id);
  const batch = await batches.getBatch(id);
  if (!batch) throw batchNotFound(id);

  const documentIds = await batches.listDocumentIds(id);
  for (const documentId of documentIds) {
    await store.remove(documentId);
  }
  await batches.removeBatch(id);

  ok(res, { id, deleted: true, documentsDeleted: documentIds.length });
}
