import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  deleteDocument,
  getDocument,
  getDocumentPage,
  listDocuments,
  uploadDocument,
} from '../controllers/documentController.js';
import {
  createRegion,
  deleteRegion,
  listRegions,
  listRegionsForPage,
  updateRegion,
} from '../controllers/regionController.js';
import { runOcr } from '../controllers/ocrController.js';
import { uploadSingleDocument } from '../middleware/upload.js';

/**
 * Forward rejected promises to the error middleware.
 *
 * Express 5 does this on its own, but wrapping keeps the behaviour explicit
 * and independent of the major version.
 */
const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };

export const documentsRouter: Router = Router();

documentsRouter.post('/upload', uploadSingleDocument, asyncHandler(uploadDocument));
documentsRouter.get('/', asyncHandler(listDocuments));

// Region routes come before `/:id` so that neither shadows the other.
documentsRouter.get('/:id/regions', asyncHandler(listRegions));
documentsRouter.get('/:id/regions/page/:pageNumber', asyncHandler(listRegionsForPage));
documentsRouter.post('/:id/regions', asyncHandler(createRegion));
documentsRouter.put('/:id/regions/:regionId', asyncHandler(updateRegion));
documentsRouter.delete('/:id/regions/:regionId', asyncHandler(deleteRegion));

documentsRouter.post('/:id/ocr', asyncHandler(runOcr));

documentsRouter.get('/:id', asyncHandler(getDocument));
documentsRouter.get('/:id/pages/:pageNumber', asyncHandler(getDocumentPage));
documentsRouter.delete('/:id', asyncHandler(deleteDocument));
