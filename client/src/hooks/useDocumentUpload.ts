import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, fetchDocument, uploadDocument } from '../api/client';
import type { Document, UploadStatus } from '../types';

const POLL_INITIAL_MS = 500;
const POLL_MAX_MS = 5_000;
const POLL_TIMEOUT_MS = 120_000;

export interface UseDocumentUploadReturn {
  /** Upload a file and resolve once the server reports it ready. */
  upload: (file: File) => Promise<Document>;
  /** Upload progress, 0-100. */
  progress: number;
  status: UploadStatus;
  error: string | null;
  /** Abort an upload in flight. */
  cancel: () => void;
  reset: () => void;
}

/**
 * Drive one upload: transfer, then poll until the server finishes rendering.
 *
 * The server answers the upload immediately with `status: 'processing'` and
 * renders page 1 in the background, so this hook polls the document with
 * exponential backoff until it reaches `ready` or `error`. Every timer and
 * request is cancelled on unmount.
 */
export function useDocumentUpload(): UseDocumentUploadReturn {
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState<UploadStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    };
  }, []);

  /** Resolve when the document leaves `processing`. */
  const pollUntilSettled = useCallback(
    async (id: string, signal: AbortSignal): Promise<Document> => {
      const deadline = Date.now() + POLL_TIMEOUT_MS;
      let delay = POLL_INITIAL_MS;

      for (;;) {
        const document = await fetchDocument(id, signal);
        if (document.status === 'ready' || document.status === 'error') return document;

        if (Date.now() > deadline) {
          throw new ApiRequestError({
            code: 'PROCESSING_TIMEOUT',
            message: 'The server is taking unusually long to process this file.',
          });
        }

        await new Promise<void>((resolve, reject) => {
          timeoutRef.current = setTimeout(resolve, delay);
          signal.addEventListener(
            'abort',
            () => {
              if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
              reject(new ApiRequestError({ code: 'CANCELLED', message: 'Upload cancelled' }));
            },
            { once: true },
          );
        });

        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
    },
    [],
  );

  const upload = useCallback(
    async (file: File): Promise<Document> => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setProgress(0);
      setError(null);
      setStatus('uploading');

      try {
        const created = await uploadDocument(file, {
          signal: controller.signal,
          onProgress: (percent) => {
            if (mountedRef.current) setProgress(percent);
          },
        });

        if (mountedRef.current) {
          setProgress(100);
          setStatus('processing');
        }

        const settled = await pollUntilSettled(created.id, controller.signal);

        if (settled.status === 'error') {
          throw new ApiRequestError({
            code: 'PROCESSING_ERROR',
            message: settled.errorMessage ?? 'The server could not process this file.',
          });
        }

        if (mountedRef.current) setStatus('success');
        return settled;
      } catch (caught) {
        const message =
          caught instanceof ApiRequestError ? caught.message : 'Upload failed unexpectedly';
        if (mountedRef.current) {
          setStatus('error');
          setError(message);
        }
        throw caught;
      }
    },
    [pollUntilSettled],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
    if (timeoutRef.current !== null) clearTimeout(timeoutRef.current);
    setStatus('idle');
    setProgress(0);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setProgress(0);
    setError(null);
  }, []);

  return { upload, progress, status, error, cancel, reset };
}
