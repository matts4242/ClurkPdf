import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiRequestError, createBatch, uploadDocument } from '../api/client';
import type { Document } from '../types';

/**
 * Upload a drop of files as one batch.
 *
 * Week 1 sent files strictly one at a time, because each upload also waited
 * out the server's rendering. Now the server only stores and queues, so the
 * transfers themselves are the whole wait and a handful can run at once —
 * still bounded, so that fifty files do not open fifty sockets and make every
 * progress bar useless.
 *
 * The hook's job ends when the bytes are on the server. What happens to them
 * afterwards arrives over the WebSocket; see `useProcessingEvents`.
 */

/** How many files are in flight at once. */
const UPLOAD_CONCURRENCY = 3;
const MAX_ATTEMPTS = 3;

export type TransferStatus = 'waiting' | 'uploading' | 'sent' | 'error';

/** One file's transfer, tracked until the server accepts it. */
export interface Transfer {
  key: string;
  file: File;
  status: TransferStatus;
  /** 0-100 for the transfer itself, not for processing. */
  progress: number;
  /** Set once the server has accepted the file. */
  documentId?: string;
  errorMessage?: string;
  /** Set when the server recognised the bytes as an earlier upload. */
  duplicateOf?: string;
}

export interface UseBatchUploadReturn {
  /** Upload files as a new batch, or into `batchId` when one is given. */
  send: (files: File[], batchId?: string) => Promise<string | undefined>;
  /** Retry one failed transfer. */
  retry: (key: string) => void;
  /** Forget a finished or failed row. */
  dismiss: (key: string) => void;
  /** Abort everything in flight and clear the queue. */
  cancelAll: () => void;
  transfers: Transfer[];
  /** True while any file is still being sent. */
  isSending: boolean;
}

export function useBatchUpload(): UseBatchUploadReturn {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [isSending, setIsSending] = useState(false);

  const controllersRef = useRef(new Map<string, AbortController>());
  const attemptsRef = useRef(new Map<string, number>());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const controller of controllersRef.current.values()) controller.abort();
      controllersRef.current.clear();
    };
  }, []);

  const patch = useCallback((key: string, changes: Partial<Transfer>) => {
    if (!mountedRef.current) return;
    setTransfers((rows) => rows.map((row) => (row.key === key ? { ...row, ...changes } : row)));
  }, []);

  /** Send one file, retrying transport failures with a backoff. */
  const sendOne = useCallback(
    async (transfer: Transfer, batchId: string): Promise<void> => {
      const { key, file } = transfer;

      for (;;) {
        const controller = new AbortController();
        controllersRef.current.set(key, controller);
        patch(key, { status: 'uploading', progress: 0, errorMessage: undefined });

        try {
          const document: Document = await uploadDocument(file, {
            batchId,
            signal: controller.signal,
            onProgress: (percent) => patch(key, { progress: percent }),
          });

          patch(key, {
            status: 'sent',
            progress: 100,
            documentId: document.id,
            ...(document.duplicateOf === undefined
              ? {}
              : { duplicateOf: document.duplicateOf }),
          });
          attemptsRef.current.delete(key);
          return;
        } catch (error) {
          const attempts = (attemptsRef.current.get(key) ?? 0) + 1;
          attemptsRef.current.set(key, attempts);
          const message = error instanceof Error ? error.message : 'Upload failed';

          const worthRetrying =
            attempts < MAX_ATTEMPTS &&
            error instanceof ApiRequestError &&
            error.isRetryable &&
            !controller.signal.aborted;

          if (!worthRetrying) {
            patch(key, { status: 'error', errorMessage: message });
            return;
          }

          patch(key, {
            status: 'waiting',
            errorMessage: `${message} Retrying (${attempts}/${MAX_ATTEMPTS})...`,
          });
          await sleep(500 * 2 ** (attempts - 1));
        } finally {
          controllersRef.current.delete(key);
        }
      }
    },
    [patch],
  );

  /**
   * Run `sendOne` over the queue with a fixed number of workers.
   *
   * A pool rather than `Promise.all`: the point is the ceiling on concurrent
   * transfers, which `Promise.all` over fifty files would not give.
   */
  const drain = useCallback(
    async (queued: Transfer[], batchId: string): Promise<void> => {
      const pending = [...queued];
      const workers = Array.from(
        { length: Math.min(UPLOAD_CONCURRENCY, pending.length) },
        async () => {
          for (;;) {
            const next = pending.shift();
            if (!next) return;
            await sendOne(next, batchId);
          }
        },
      );
      await Promise.all(workers);
    },
    [sendOne],
  );

  const send = useCallback(
    async (files: File[], batchId?: string): Promise<string | undefined> => {
      if (files.length === 0) return batchId;

      const rows = files.map<Transfer>((file) => ({
        key: transferKey(file),
        file,
        status: 'waiting',
        progress: 0,
      }));

      // A file already in the list is not queued twice; the user dropping the
      // same file again almost always means they lost track, not that they
      // want two copies.
      let queued: Transfer[] = [];
      setTransfers((current) => {
        const known = new Set(current.map((row) => row.key));
        queued = rows.filter((row) => !known.has(row.key));
        return [...current, ...queued];
      });
      if (queued.length === 0) return batchId;

      setIsSending(true);
      try {
        // Open the batch first so every file in this drop shares one, even
        // though they are uploaded in parallel. The count goes with it: the
        // server has nothing to count yet, and "3 files · 14:05" is a more
        // useful name than the time on its own.
        const targetBatch =
          batchId ?? (await createBatch({ fileCount: queued.length })).id;
        await drain(queued, targetBatch);
        return targetBatch;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Could not start the upload';
        for (const row of queued) patch(row.key, { status: 'error', errorMessage: message });
        return batchId;
      } finally {
        if (mountedRef.current) setIsSending(false);
      }
    },
    [drain, patch],
  );

  const retry = useCallback(
    (key: string) => {
      const transfer = transfers.find((row) => row.key === key);
      if (!transfer) return;
      attemptsRef.current.set(key, 0);
      setTransfers((rows) => rows.filter((row) => row.key !== key));
      void send([transfer.file]);
    },
    [send, transfers],
  );

  const dismiss = useCallback((key: string) => {
    controllersRef.current.get(key)?.abort();
    controllersRef.current.delete(key);
    attemptsRef.current.delete(key);
    setTransfers((rows) => rows.filter((row) => row.key !== key));
  }, []);

  const cancelAll = useCallback(() => {
    for (const controller of controllersRef.current.values()) controller.abort();
    controllersRef.current.clear();
    attemptsRef.current.clear();
    setTransfers([]);
    setIsSending(false);
  }, []);

  return { send, retry, dismiss, cancelAll, transfers, isSending };
}

/** Stable identity for a file across retries. */
export const transferKey = (file: File): string =>
  `${file.name}-${file.size}-${file.lastModified}`;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
