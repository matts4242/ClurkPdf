import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  applyTemplate,
  createTemplate,
  deleteTemplate,
  getTemplate,
  listTemplates,
  updateTemplate,
} from '../controllers/templateController.js';

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };

export const templatesRouter: Router = Router();

templatesRouter.post('/', asyncHandler(createTemplate));
templatesRouter.get('/', asyncHandler(listTemplates));

// Before `/:id`, so the two do not shadow each other.
templatesRouter.post('/:id/apply', asyncHandler(applyTemplate));

templatesRouter.get('/:id', asyncHandler(getTemplate));
templatesRouter.put('/:id', asyncHandler(updateTemplate));
templatesRouter.delete('/:id', asyncHandler(deleteTemplate));
