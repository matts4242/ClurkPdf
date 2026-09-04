/**
 * Shared API and domain types for the invoice processor server.
 *
 * The client mirrors these in `client/src/types/index.ts`. Keep the two in
 * sync; Week 2 introduces a shared package once Prisma models land.
 */

/** Every endpoint responds with this envelope, success or failure. */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export const ERROR_CODES = [
  'FILE_TOO_LARGE',
  'INVALID_FILE_TYPE',
  'NO_FILE_UPLOADED',
  'UPLOAD_FAILED',
  'INVALID_PDF',
  'INVALID_REQUEST',
  'DOCUMENT_NOT_FOUND',
  'PAGE_NOT_FOUND',
  'PROCESSING_ERROR',
  'FORBIDDEN',
  'ROUTE_NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type DocumentStatus = 'uploaded' | 'processing' | 'ready' | 'error';

export interface Document {
  /** UUID v4. */
  id: string;
  /** Sanitized name as stored on disk. */
  filename: string;
  /** Name exactly as the browser reported it. */
  originalName: string;
  mimeType: string;
  /** Size in bytes. */
  size: number;
  pageCount: number;
  /** Path to the original PDF, relative to the uploads root. */
  uploadPath: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  status: DocumentStatus;
  /** URL of the page-1 preview image. Present once the page has rendered. */
  thumbnailUrl?: string;
  /** Populated when `status` is `error`. */
  errorMessage?: string;
}
