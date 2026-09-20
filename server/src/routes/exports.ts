import { Router } from 'express';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { exportDocuments } from '../controllers/exportController.js';

const asyncHandler =
  (handler: (req: Request, res: Response) => Promise<void>): RequestHandler =>
  (req, res, next: NextFunction) => {
    handler(req, res).catch(next);
  };

export const exportsRouter: Router = Router();

exportsRouter.get('/', asyncHandler(exportDocuments));
