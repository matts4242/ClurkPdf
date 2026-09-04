import axios, { AxiosError, type AxiosInstance, type GenericAbortSignal } from 'axios';
import type { ApiError, ApiResponse, Document } from '../types';

/** Origin of the API server. Override with VITE_SERVER_ORIGIN. */
export const SERVER_ORIGIN: string =
  import.meta.env.VITE_SERVER_ORIGIN ?? 'http://localhost:3001';

const http: AxiosInstance = axios.create({
  baseURL: `${SERVER_ORIGIN}/api`,
  timeout: 30_000,
});

/**
 * Turn any axios failure into the same `{ code, message }` shape the server
 * sends, so callers never have to tell transport errors from API errors.
 */
function toApiError(error: unknown): ApiError {
  if (error instanceof AxiosError) {
    const payload = error.response?.data as ApiResponse<unknown> | undefined;
    if (payload?.error) return payload.error;

    if (error.code === 'ECONNABORTED') {
      return { code: 'TIMEOUT', message: 'The request timed out. Please try again.' };
    }
    if (error.code === 'ERR_CANCELED') {
      return { code: 'CANCELLED', message: 'Upload cancelled' };
    }
    if (error.response === undefined) {
      return {
        code: 'NETWORK_ERROR',
        message: 'Could not reach the server. Check that it is running on ' + SERVER_ORIGIN,
      };
    }
    return { code: 'HTTP_ERROR', message: error.message };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: error instanceof Error ? error.message : 'An unexpected error occurred',
  };
}

/** Thrown by every function below when a request fails. */
export class ApiRequestError extends Error {
  public readonly code: string;
  public readonly details?: unknown;

  constructor(apiError: ApiError) {
    super(apiError.message);
    this.name = 'ApiRequestError';
    this.code = apiError.code;
    this.details = apiError.details;
  }

  /** True when retrying the same request could plausibly succeed. */
  get isRetryable(): boolean {
    return ['NETWORK_ERROR', 'TIMEOUT', 'INTERNAL_ERROR', 'PROCESSING_ERROR'].includes(this.code);
  }
}

async function unwrap<T>(request: Promise<{ data: ApiResponse<T> }>): Promise<T> {
  try {
    const { data } = await request;
    if (!data.success || data.data === undefined) {
      throw new ApiRequestError(
        data.error ?? { code: 'UNKNOWN_ERROR', message: 'Malformed server response' },
      );
    }
    return data.data;
  } catch (error) {
    if (error instanceof ApiRequestError) throw error;
    throw new ApiRequestError(toApiError(error));
  }
}

export interface UploadOptions {
  onProgress?: (percent: number) => void;
  signal?: GenericAbortSignal;
}

export function uploadDocument(file: File, options: UploadOptions = {}): Promise<Document> {
  const form = new FormData();
  form.append('file', file);

  return unwrap<Document>(
    http.post('/documents/upload', form, {
      ...(options.signal ? { signal: options.signal } : {}),
      onUploadProgress: (event) => {
        if (!options.onProgress) return;
        // `total` is absent on some proxies; fall back to indeterminate.
        const total = event.total ?? 0;
        if (total > 0) {
          options.onProgress(Math.min(100, Math.round((event.loaded / total) * 100)));
        }
      },
    }),
  );
}

export function fetchDocument(id: string, signal?: GenericAbortSignal): Promise<Document> {
  return unwrap<Document>(http.get(`/documents/${id}`, signal ? { signal } : {}));
}

export function listDocuments(signal?: GenericAbortSignal): Promise<Document[]> {
  return unwrap<Document[]>(http.get('/documents', signal ? { signal } : {}));
}

export function deleteDocument(id: string): Promise<{ id: string; deleted: boolean }> {
  return unwrap<{ id: string; deleted: boolean }>(http.delete(`/documents/${id}`));
}

/** Absolute URL of a rendered page image. */
export const pageImageUrl = (id: string, pageNumber: number): string =>
  `${SERVER_ORIGIN}/api/documents/${id}/pages/${pageNumber}`;

/** Absolute URL for a path the server returned, such as `thumbnailUrl`. */
export const absoluteUrl = (relativePath: string): string => `${SERVER_ORIGIN}${relativePath}`;
