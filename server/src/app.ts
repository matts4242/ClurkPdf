import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { documentsRouter } from './routes/documents.js';
import { forbidden } from './utils/errors.js';

/**
 * Only rendered images may be fetched from the uploads tree: full page renders
 * and the page-1 thumbnail. The original PDF and the metadata sidecar sit in
 * the same directory and must stay unreachable.
 */
const UUID_SEGMENT = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const PUBLIC_UPLOAD_PATH = new RegExp(
  `^/${UUID_SEGMENT}/(pages/\\d+|thumbnail)\\.png$`,
  'i',
);

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    helmet({
      // Images are fetched cross-origin by the Vite dev server on :5173.
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin: config.allowedOrigins,
      // PUT is required for region edits. A missing method here fails only in
      // a browser, at the preflight, so it is invisible to curl.
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    }),
  );
  if (!config.isTest) {
    app.use(morgan(config.isProduction ? 'combined' : 'dev'));
  }
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req: Request, res: Response) => {
    res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
  });

  // Guard before the static handler: page renders are public, the uploaded
  // PDF and the metadata sidecar are not.
  app.use(
    '/uploads',
    (req: Request, _res: Response, next: NextFunction) => {
      if (!PUBLIC_UPLOAD_PATH.test(decodeURIComponent(req.path))) {
        next(forbidden('Only rendered page images are served from /uploads'));
        return;
      }
      next();
    },
    express.static(config.uploadsDir, {
      index: false,
      dotfiles: 'deny',
      maxAge: config.imageCacheSeconds * 1000,
      setHeaders: (res) => {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Disposition', 'inline');
      },
    }),
  );

  app.use('/api/documents', documentsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
