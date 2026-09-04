import type { ErrorCode } from '../types/index.js';

/**
 * An error with a stable machine-readable code and an HTTP status.
 *
 * Anything thrown as an `AppError` is safe to show the user; everything else
 * is masked as INTERNAL_ERROR by the error handler.
 */
export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(code: ErrorCode, message: string, statusCode: number, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace?.(this, AppError);
  }
}

export const fileTooLarge = (maxBytes: number): AppError =>
  new AppError(
    'FILE_TOO_LARGE',
    `File exceeds the ${Math.round(maxBytes / (1024 * 1024))}MB limit`,
    413,
    { maxBytes },
  );

export const invalidFileType = (received?: string): AppError =>
  new AppError('INVALID_FILE_TYPE', 'Only PDF files are accepted', 415, { received });

export const noFileUploaded = (): AppError =>
  new AppError('NO_FILE_UPLOADED', 'No file was included in the request', 400);

export const invalidPdf = (details?: unknown): AppError =>
  new AppError('INVALID_PDF', 'Could not parse PDF file', 422, details);

export const invalidRequest = (message: string, details?: unknown): AppError =>
  new AppError('INVALID_REQUEST', message, 400, details);

export const documentNotFound = (id: string): AppError =>
  new AppError('DOCUMENT_NOT_FOUND', `No document with id ${id}`, 404, { id });

export const pageNotFound = (pageNumber: number, pageCount: number): AppError =>
  new AppError(
    'PAGE_NOT_FOUND',
    `Page ${pageNumber} is out of range; this document has ${pageCount} page(s)`,
    404,
    { pageNumber, pageCount },
  );

export const processingError = (message: string, details?: unknown): AppError =>
  new AppError('PROCESSING_ERROR', message, 500, details);

export const forbidden = (message: string): AppError =>
  new AppError('FORBIDDEN', message, 403);

export const regionNotFound = (id: string): AppError =>
  new AppError('REGION_NOT_FOUND', `No region with id ${id} on this document`, 404, { id });

export const regionOutOfBounds = (details?: unknown): AppError =>
  new AppError(
    'REGION_OUT_OF_BOUNDS',
    'Region coordinates must lie within the page (0 to 1 on both axes)',
    400,
    details,
  );

export const invalidDimensions = (details?: unknown): AppError =>
  new AppError('INVALID_DIMENSIONS', 'Region width and height must be greater than 0', 400, details);

export const invalidPage = (pageNumber: number, pageCount: number): AppError =>
  new AppError(
    'INVALID_PAGE',
    `Page ${pageNumber} is outside this document, which has ${pageCount} page(s)`,
    400,
    { pageNumber, pageCount },
  );

export const invalidFieldType = (received: unknown): AppError =>
  new AppError('INVALID_FIELD_TYPE', 'Unknown field type', 400, { received });
