/**
 * Client-side mirror of the server's API contract.
 *
 * Kept in sync by hand for Week 1; Week 2 moves these into a shared package
 * alongside the Prisma models.
 */

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

export type DocumentStatus = 'uploaded' | 'processing' | 'ready' | 'error';

export interface Document {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number;
  uploadPath: string;
  createdAt: string;
  status: DocumentStatus;
  thumbnailUrl?: string;
  errorMessage?: string;
}

export type UploadStatus = 'idle' | 'uploading' | 'processing' | 'success' | 'error';
