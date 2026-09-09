import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { createBatch, getBatch, listBatches } from '../controllers/batchController.js';
import { uploadBatchDocuments } from '../middleware/upload.js';

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };

export const batchesRouter: Router = Router();

batchesRouter.post('/', uploadBatchDocuments, asyncHandler(createBatch));
batchesRouter.get('/', asyncHandler(listBatches));
batchesRouter.get('/:id', asyncHandler(getBatch));
