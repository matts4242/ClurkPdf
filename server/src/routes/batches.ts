import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  createBatch,
  deleteBatch,
  getBatch,
  listBatches,
} from '../controllers/batchController.js';
import { exportBatch } from '../controllers/exportController.js';

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };

export const batchesRouter: Router = Router();

batchesRouter.post('/', asyncHandler(createBatch));
batchesRouter.get('/', asyncHandler(listBatches));
// Before `/:id`, so the two do not shadow each other.
batchesRouter.get('/:id/export', asyncHandler(exportBatch));

batchesRouter.get('/:id', asyncHandler(getBatch));
batchesRouter.delete('/:id', asyncHandler(deleteBatch));
