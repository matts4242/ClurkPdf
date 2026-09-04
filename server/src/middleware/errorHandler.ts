import type { NextFunction, Request, Response } from 'express';
import { MulterError } from 'multer';
import { config } from '../config.js';
import type { ApiResponse } from '../types/index.js';
import { AppError, fileTooLarge } from '../utils/errors.js';

/** Terminal 404 for unmatched routes. Mounted after every real route. */
export function notFoundHandler(req: Request, res: Response): void {
  const body: ApiResponse<never> = {
    success: false,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `Cannot ${req.method} ${req.path}`,
    },
  };
  res.status(404).json(body);
}

/**
 * Convert anything thrown in the request pipeline into the API envelope.
 *
 * Only `AppError` messages reach the client. Everything else is logged in full
 * and reported as INTERNAL_ERROR, so stack traces and file paths stay server
 * side.
 */
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const appError = toAppError(error);

  if (appError.statusCode >= 500) {
    console.error(
      `[error] ${req.method} ${req.originalUrl} -> ${appError.code}`,
      error instanceof Error ? error.stack : error,
    );
  } else {
    console.warn(`[warn] ${req.method} ${req.originalUrl} -> ${appError.code}: ${appError.message}`);
  }

  const body: ApiResponse<never> = {
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details === undefined ? {} : { details: appError.details }),
    },
  };
  res.status(appError.statusCode).json(body);
}

function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return fileTooLarge(config.maxFileSize);
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return new AppError(
        'INVALID_REQUEST',
        'Unexpected file field; upload a single file under the field name "file"',
        400,
        { field: error.field },
      );
    }
    return new AppError('UPLOAD_FAILED', 'Upload failed', 400, { code: error.code });
  }

  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred', 500);
}
