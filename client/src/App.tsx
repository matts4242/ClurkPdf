import { useCallback, useEffect, useRef, useState } from 'react';
import { FileStack, Trash2 } from 'lucide-react';
import { DocumentViewer } from './components/DocumentViewer';
import { FileDropzone } from './components/FileDropzone';
import { UploadProgress, type UploadProgressStatus } from './components/UploadProgress';
import { deleteDocument, listDocuments } from './api/client';
import { useDocumentUpload } from './hooks/useDocumentUpload';
import type { Document } from './types';
import { formatBytes, formatPageCount } from './utils/format';

/** One entry in the upload queue, tracked until the server finishes with it. */
interface QueueItem {
  key: string;
  file: File;
  status: UploadProgressStatus;
  progress: number;
  errorMessage?: string;
}

const MAX_RETRIES = 3;

export default function App() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);

  const { upload, progress, status } = useDocumentUpload();
  const pendingRef = useRef<File[]>([]);
  const busyRef = useRef(false);
  const retriesRef = useRef(new Map<string, number>());

  // Documents already on the server survive a page reload, so list them once.
  useEffect(() => {
    const controller = new AbortController();
    listDocuments(controller.signal)
      .then((existing) => {
        setDocuments(existing);
        setSelectedId((current) => current ?? existing[0]?.id ?? null);
      })
      .catch(() => {
        // A cold server is expected on first run; the dropzone still works.
      });
    return () => controller.abort();
  }, []);

  const patchQueueItem = useCallback((key: string, changes: Partial<QueueItem>) => {
    setQueue((items) => items.map((item) => (item.key === key ? { ...item, ...changes } : item)));
  }, []);

  /**
   * Upload queued files one at a time.
   *
   * Serialising keeps the progress bar meaningful and stops a 50-file batch
   * from opening 50 sockets at once. Week 5 replaces this with a real queue.
   */
  const drainQueue = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;

    try {
      for (;;) {
        const next = pendingRef.current.shift();
        if (!next) break;

        const key = queueKey(next);
        patchQueueItem(key, { status: 'uploading', progress: 0 });

        try {
          const document = await upload(next);
          patchQueueItem(key, { status: 'complete', progress: 100 });
          retriesRef.current.delete(key);

          setDocuments((current) => [document, ...current.filter((d) => d.id !== document.id)]);
          setSelectedId(document.id);

          // Clear the finished row after a beat so the list stays readable.
          window.setTimeout(() => {
            setQueue((items) => items.filter((item) => item.key !== key));
          }, 2500);
        } catch (error) {
          const attempts = (retriesRef.current.get(key) ?? 0) + 1;
          retriesRef.current.set(key, attempts);
          const message = error instanceof Error ? error.message : 'Upload failed';

          if (attempts < MAX_RETRIES && isRetryable(error)) {
            patchQueueItem(key, {
              status: 'error',
              errorMessage: `${message} Retrying (${attempts}/${MAX_RETRIES})...`,
            });
            // Exponential backoff before the file rejoins the queue.
            await sleep(500 * 2 ** (attempts - 1));
            pendingRef.current.push(next);
          } else {
            patchQueueItem(key, { status: 'error', errorMessage: message });
          }
        }
      }
    } finally {
      busyRef.current = false;
    }
  }, [patchQueueItem, upload]);

  const handleFilesSelected = useCallback(
    (files: File[]) => {
      const items = files.map<QueueItem>((file) => ({
        key: queueKey(file),
        file,
        status: 'uploading',
        progress: 0,
      }));

      setQueue((current) => {
        const known = new Set(current.map((item) => item.key));
        return [...current, ...items.filter((item) => !known.has(item.key))];
      });
      pendingRef.current.push(...files);
      void drainQueue();
    },
    [drainQueue],
  );

  const retryItem = useCallback(
    (item: QueueItem) => {
      retriesRef.current.set(item.key, 0);
      patchQueueItem(item.key, { status: 'uploading', progress: 0, errorMessage: undefined });
      pendingRef.current.push(item.file);
      void drainQueue();
    },
    [drainQueue, patchQueueItem],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      await deleteDocument(id).catch(() => undefined);
      setDocuments((current) => {
        const remaining = current.filter((document) => document.id !== id);
        setSelectedId((selected) => (selected === id ? (remaining[0]?.id ?? null) : selected));
        return remaining;
      });
    },
    [],
  );

  // The active row mirrors the live hook state; finished rows keep their own.
  const activeKey = queue.find((item) => item.status === 'uploading')?.key;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-slate-200 bg-white px-5 py-3">
        <FileStack className="h-5 w-5 text-sky-600" aria-hidden="true" />
        <h1 className="text-sm font-semibold text-slate-800">Invoice Processor</h1>
        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
          Week 1 &middot; Upload &amp; Viewer
        </span>
        <span className="ml-auto text-xs text-slate-400">
          {documents.length} {documents.length === 1 ? 'document' : 'documents'}
        </span>
      </header>

      <main className="grid min-h-0 flex-1 gap-4 p-4 lg:grid-cols-[22rem_1fr]">
        <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
          <FileDropzone onFilesSelected={handleFilesSelected} disabled={status === 'uploading'} />

          {queue.length > 0 && (
            <div className="space-y-2">
              {queue.map((item) => (
                <UploadProgress
                  key={item.key}
                  fileName={item.file.name}
                  progress={item.key === activeKey ? progress : item.progress}
                  status={item.key === activeKey ? liveStatus(status, item.status) : item.status}
                  {...(item.errorMessage === undefined
                    ? {}
                    : { errorMessage: item.errorMessage })}
                  onRetry={() => retryItem(item)}
                />
              ))}
            </div>
          )}

          {documents.length > 0 && (
            <ul className="space-y-1.5">
              {documents.map((document) => (
                <li key={document.id}>
                  <div
                    className={`flex items-center gap-2 rounded-xl border px-3 py-2 transition-colors ${
                      document.id === selectedId
                        ? 'border-sky-400 bg-sky-50'
                        : 'border-slate-200 bg-white hover:border-slate-300'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(document.id)}
                      className="min-w-0 flex-1 text-left"
                      aria-current={document.id === selectedId}
                    >
                      <p className="truncate text-sm font-medium text-slate-700">
                        {document.originalName}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {formatPageCount(document.pageCount)} &middot;{' '}
                        {formatBytes(document.size)}
                      </p>
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleDelete(document.id)}
                      className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                      aria-label={`Delete ${document.originalName}`}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* min-w-0 keeps a zoomed page inside the viewer's own scroll area
            rather than widening the grid and scrolling the whole window. */}
        <div className="min-h-0 min-w-0">
          {selectedId === null ? (
            <div className="flex h-full min-h-96 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white text-center">
              <FileStack className="h-8 w-8 text-slate-300" aria-hidden="true" />
              <p className="text-sm text-slate-500">Upload a PDF to see it here.</p>
            </div>
          ) : (
            <DocumentViewer key={selectedId} documentId={selectedId} />
          )}
        </div>
      </main>
    </div>
  );
}

/** Stable identity for a queued file across retries. */
const queueKey = (file: File): string => `${file.name}-${file.size}-${file.lastModified}`;

/** Map the hook's state onto the row's four visual states. */
function liveStatus(
  hookStatus: ReturnType<typeof useDocumentUpload>['status'],
  fallback: UploadProgressStatus,
): UploadProgressStatus {
  switch (hookStatus) {
    case 'uploading':
      return 'uploading';
    case 'processing':
      return 'processing';
    case 'success':
      return 'complete';
    case 'error':
      return 'error';
    default:
      return fallback;
  }
}

function isRetryable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'isRetryable' in error &&
    Boolean((error as { isRetryable: unknown }).isRetryable)
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
