import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { FileStack, Trash2, WifiOff } from 'lucide-react';
import { BatchGrid } from './components/BatchGrid';
import { BatchProgress } from './components/BatchProgress';
import { DocumentViewer } from './components/DocumentViewer';
import { FileDropzone } from './components/FileDropzone';
import { UploadProgress } from './components/UploadProgress';
import { deleteBatch, deleteDocument, fetchBatch, listDocuments } from './api/client';
import { useBatchUpload, type Transfer } from './hooks/useBatchUpload';
import { useProcessingEvents } from './hooks/useProcessingEvents';
import {
  applyProcessingEvent,
  firstReady,
  initialState,
  type ProcessingState,
} from './state/processing';
import type { BatchWithDocuments, Document, ProcessingEvent } from './types';

/**
 * Week 5: upload a batch, watch the queue work through it, open any document
 * that is ready.
 *
 * The state here is deliberately one-way. Uploading only puts bytes on the
 * server; everything after that — a document starting, its progress, its
 * fields being found, the batch finishing — arrives as a `ProcessingEvent` and
 * is folded into the same `ProcessingState` the initial fetch fills. There is
 * no polling and no second reconciliation path: a dropped socket reconnects
 * and refetches.
 *
 * The fold itself lives in `state/processing.ts`, as a pure function, because
 * that is the part with edge cases worth testing — out-of-order frames, a
 * reconnect replaying events, news about a document this client never saw.
 */

/** Everything the view needs beyond one event: a fetch, or the user's doing. */
type Action =
  | { type: 'event'; event: ProcessingEvent }
  | { type: 'documents.loaded'; documents: Document[] }
  | { type: 'batch.loaded'; batch: BatchWithDocuments }
  | { type: 'document.removed'; id: string }
  | { type: 'batch.cleared' };

function reduce(state: ProcessingState, action: Action): ProcessingState {
  switch (action.type) {
    case 'event':
      return applyProcessingEvent(state, action.event);

    case 'documents.loaded':
      return { ...state, documents: action.documents };

    case 'batch.loaded': {
      const { documents, ...batch } = action.batch;
      // Fold the batch's documents in rather than replacing the list: it holds
      // only this upload, and the grid shows everything on the server.
      return documents.reduce<ProcessingState>(
        (current, document) =>
          applyProcessingEvent(current, {
            type: 'document.queued',
            batchId: batch.id,
            document,
          }),
        { ...state, batch },
      );
    }

    case 'document.removed':
      return {
        ...state,
        documents: state.documents.filter((document) => document.id !== action.id),
      };

    case 'batch.cleared':
      return { ...state, batch: null };

    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reduce, initialState);
  const { documents, batch, detectedFields } = state;
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { send, retry, dismiss, cancelAll, transfers, isSending } = useBatchUpload();

  // The batch currently being watched. Undefined outside an upload, when the
  // socket listens to everything instead.
  const [watchedBatchId, setWatchedBatchId] = useState<string | undefined>(undefined);

  // Documents already on the server survive a reload, so list them once.
  useEffect(() => {
    const controller = new AbortController();
    listDocuments(controller.signal)
      .then((existing) => {
        dispatch({ type: 'documents.loaded', documents: existing });
        setSelectedId((current) => current ?? firstReady(existing));
      })
      .catch(() => {
        // A cold server is expected on first run; the dropzone still works.
      });
    return () => controller.abort();
  }, []);

  const handleEvent = useCallback((event: ProcessingEvent) => {
    dispatch({ type: 'event', event });
    // Open the first document to finish, so the viewer is not left empty
    // while the rest of the batch is still being worked through.
    if (event.type === 'document.ready') {
      setSelectedId((current) => current ?? event.document.id);
    }
  }, []);

  /** Refetch after a reconnect: the socket is live state, not the record. */
  const resync = useCallback(() => {
    void listDocuments()
      .then((existing) => dispatch({ type: 'documents.loaded', documents: existing }))
      .catch(() => undefined);
    if (watchedBatchId !== undefined) {
      void fetchBatch(watchedBatchId)
        .then((fetched) => dispatch({ type: 'batch.loaded', batch: fetched }))
        .catch(() => undefined);
    }
  }, [watchedBatchId]);

  const connection = useProcessingEvents({
    ...(watchedBatchId === undefined ? {} : { batchId: watchedBatchId }),
    onEvent: handleEvent,
    onResync: resync,
  });

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      void send(files).then(async (batchId) => {
        if (batchId === undefined) return;
        setWatchedBatchId(batchId);
        // Draw the batch straight away rather than waiting for the first
        // event, so the bar appears as soon as the files are accepted.
        await fetchBatch(batchId)
          .then((fetched) => dispatch({ type: 'batch.loaded', batch: fetched }))
          .catch(() => undefined);
      });
    },
    [send],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteDocument(id).catch(() => undefined);
      dispatch({ type: 'document.removed', id });
      if (selectedId === id) {
        setSelectedId(firstReady(documents.filter((document) => document.id !== id)));
      }
    },
    [documents, selectedId],
  );

  const handleClearBatch = useCallback(async () => {
    if (!batch) return;
    await deleteBatch(batch.id).catch(() => undefined);
    dispatch({ type: 'batch.cleared' });
    setWatchedBatchId(undefined);
    cancelAll();
    await listDocuments()
      .then((existing) => {
        dispatch({ type: 'documents.loaded', documents: existing });
        setSelectedId(firstReady(existing));
      })
      .catch(() => undefined);
  }, [batch, cancelAll]);

  // A transfer stops being worth a row once the server has the file: from
  // there on the document's own card carries its progress.
  const visibleTransfers = useMemo(
    () => transfers.filter((transfer) => transfer.status !== 'sent'),
    [transfers],
  );

  useDismissSentTransfers(transfers, dismiss);

  const selected = documents.find((document) => document.id === selectedId);
  const canOpen = selected?.status === 'ready';

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-5 py-3">
        <FileStack className="h-5 w-5 text-sky-600" aria-hidden="true" />
        <h1 className="text-sm font-semibold text-slate-800">Invoice Processor</h1>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
          Week 5 &middot; Batch queue
        </span>

        {connection !== 'open' && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700"
            title="Live progress is unavailable; reconnecting"
          >
            <WifiOff className="h-3 w-3" aria-hidden="true" />
            Offline
          </span>
        )}

        <span className="ml-auto text-xs text-slate-400">
          {documents.length} {documents.length === 1 ? 'document' : 'documents'}
        </span>
      </header>

      <main className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[24rem_1fr]">
        <div className="flex min-h-0 min-w-0 flex-col gap-3 overflow-y-auto">
          <FileDropzone onFilesSelected={handleFilesSelected} disabled={isSending} />

          {batch !== null && batch.documentCount > 0 && (
            <div className="space-y-2">
              <BatchProgress batch={batch} live={connection === 'open'} />
              <button
                type="button"
                onClick={() => void handleClearBatch()}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] text-slate-500 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-600"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" />
                Discard this batch
              </button>
            </div>
          )}

          {visibleTransfers.length > 0 && (
            <div className="space-y-2">
              {visibleTransfers.map((transfer) => (
                <UploadProgress
                  key={transfer.key}
                  fileName={transfer.file.name}
                  progress={transfer.progress}
                  status={transfer.status === 'error' ? 'error' : 'uploading'}
                  {...(transfer.errorMessage === undefined
                    ? {}
                    : { errorMessage: transfer.errorMessage })}
                  onRetry={() => retry(transfer.key)}
                  onCancel={() => dismiss(transfer.key)}
                />
              ))}
            </div>
          )}

          <BatchGrid
            documents={documents}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onDelete={(id) => void handleDelete(id)}
            detectedFields={detectedFields}
          />
        </div>

        {/* min-w-0 keeps a zoomed page inside the viewer's own scroll area
            rather than widening the grid and scrolling the whole window. */}
        <div className="min-h-0 min-w-0">
          {selectedId === null || !canOpen ? (
            <EmptyViewer waiting={selectedId !== null} />
          ) : (
            <DocumentViewer key={selectedId} documentId={selectedId} />
          )}
        </div>
      </main>
    </div>
  );
}

function EmptyViewer({ waiting }: { waiting: boolean }) {
  return (
    <div className="flex h-full min-h-96 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white text-center">
      <FileStack className="h-8 w-8 text-slate-300" aria-hidden="true" />
      <p className="text-sm text-slate-500">
        {waiting
          ? 'This document is still being processed.'
          : 'Upload some PDFs to see them here.'}
      </p>
    </div>
  );
}

/**
 * Drop a transfer row once its file is on the server.
 *
 * The row and the document card would otherwise both be on screen saying
 * different things about the same file, because one tracks the upload and the
 * other tracks the processing.
 */
function useDismissSentTransfers(
  transfers: Transfer[],
  dismiss: (key: string) => void,
): void {
  const dismissRef = useRef(dismiss);
  dismissRef.current = dismiss;

  useEffect(() => {
    const sent = transfers.filter((transfer) => transfer.status === 'sent');
    if (sent.length === 0) return;

    const timer = window.setTimeout(() => {
      for (const transfer of sent) dismissRef.current(transfer.key);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [transfers]);
}
