import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, FileStack, Layers, Loader2, Radio } from 'lucide-react';
import { FileDropzone } from './FileDropzone';
import { createBatch, listBatches, SERVER_ORIGIN } from '../api/client';
import { useBatch } from '../hooks/useBatch';
import {
  DOCUMENT_STATUS_META,
  type Batch,
  type BatchCounts,
  type BatchSummary,
  type Document,
  type RejectedFile,
} from '../types';
import { formatPageCount } from '../utils/format';

export interface BatchUploadProps {
  /** Open one document from the batch in the viewer. */
  onOpenDocument: (documentId: string) => void;
}

/**
 * Upload many invoices at once and watch them process.
 *
 * The server answers the upload as soon as the files are stored and does the
 * work in a queue, so this screen is a live view of that queue rather than a
 * progress bar for a request: documents arrive as `queued`, turn over one by
 * one, and each becomes clickable the moment it is ready.
 */
export function BatchUpload({ onOpenDocument }: BatchUploadProps) {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [rejected, setRejected] = useState<RejectedFile[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  /** The batch the upload just returned, shown while its own fetch is in flight. */
  const [created, setCreated] = useState<Batch | null>(null);

  const { batch, error: batchError, live, loading, refresh } = useBatch(selectedId, created);

  const loadBatches = useCallback(async () => {
    const loaded = await listBatches().catch(() => null);
    if (loaded) {
      setBatches(loaded);
      setSelectedId((current) => current ?? loaded[0]?.id ?? null);
    }
  }, []);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  // Keep the sidebar counts in step with the batch being watched.
  useEffect(() => {
    if (batch && batch.counts.queued === 0 && batch.counts.processing === 0) {
      void loadBatches();
    }
  }, [batch, loadBatches]);

  const handleFiles = useCallback(
    async (files: File[]) => {
      setUploading(true);
      setProgress(0);
      setUploadError(null);
      setRejected([]);

      try {
        const response = await createBatch(files, { onProgress: setProgress });
        setRejected(response.rejected);
        setCreated(response.batch);
        setSelectedId(response.batch.id);
        await loadBatches();
      } catch (error) {
        setUploadError(error instanceof Error ? error.message : 'The upload failed');
      } finally {
        setUploading(false);
      }
    },
    [loadBatches],
  );

  return (
    <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[22rem_1fr]">
      <div className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
        <FileDropzone onFilesSelected={(files) => void handleFiles(files)} disabled={uploading} />

        {uploading && (
          <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <p className="flex items-center gap-2 text-xs font-medium text-slate-600">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Uploading… {progress}%
            </p>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-sky-500 transition-[width]"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {uploadError !== null && <Problem>{uploadError}</Problem>}

        {rejected.length > 0 && (
          <Problem>
            {rejected.length} file{rejected.length === 1 ? '' : 's'} could not be read:{' '}
            {rejected.map((file) => file.filename).join(', ')}. The rest of the batch is
            processing.
          </Problem>
        )}

        {batches.length > 0 && (
          <ul className="space-y-1.5">
            {batches.map((summary) => (
              <li key={summary.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(summary.id)}
                  aria-current={summary.id === selectedId}
                  className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${
                    summary.id === selectedId
                      ? 'border-sky-400 bg-sky-50'
                      : 'border-slate-200 bg-white hover:border-slate-300'
                  }`}
                >
                  <p className="flex items-center gap-1.5 truncate text-sm font-medium text-slate-700">
                    <Layers className="h-3.5 w-3.5 text-slate-400" aria-hidden="true" />
                    {summary.name ?? `Batch of ${summary.counts.total}`}
                  </p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {new Date(summary.createdAt).toLocaleString()}
                  </p>
                  <CountsBar counts={summary.counts} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 min-w-0 overflow-y-auto rounded-xl border border-slate-200 bg-white">
        {batch === null ? (
          <div className="flex h-full min-h-96 flex-col items-center justify-center gap-2 text-center">
            {loading ? (
              <Loader2 className="h-6 w-6 animate-spin text-slate-300" aria-hidden="true" />
            ) : (
              <FileStack className="h-8 w-8 text-slate-300" aria-hidden="true" />
            )}
            <p className="text-sm text-slate-500">
              {batchError ??
                (loading ? 'Loading the batch…' : 'Drop a folder of invoices to start a batch.')}
            </p>
          </div>
        ) : (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-800">
                {batch.name ?? `Batch of ${batch.counts.total}`}
              </h2>
              <CountsBar counts={batch.counts} />
              <span className="ml-auto flex items-center gap-1.5 text-[11px] text-slate-400">
                <Radio
                  className={`h-3.5 w-3.5 ${live ? 'text-emerald-500' : 'text-slate-300'}`}
                  aria-hidden="true"
                />
                {live ? 'Live' : 'Reconnecting…'}
              </span>
              <button
                type="button"
                onClick={() => void refresh()}
                className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50"
              >
                Refresh
              </button>
            </div>

            <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 p-4">
              {batch.documents.map((document) => (
                <li key={document.id}>
                  <DocumentTile document={document} onOpen={onOpenDocument} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

/** One thumbnail with its status badge. Only a ready document opens. */
function DocumentTile({
  document,
  onOpen,
}: {
  document: Document;
  onOpen: (documentId: string) => void;
}) {
  const meta = DOCUMENT_STATUS_META[document.status];
  const ready = document.status === 'ready';

  return (
    <button
      type="button"
      disabled={!ready}
      onClick={() => onOpen(document.id)}
      title={document.errorMessage ?? document.originalName}
      className={`w-full overflow-hidden rounded-xl border text-left transition-colors ${
        ready
          ? 'border-slate-200 bg-white hover:border-sky-400 hover:shadow-sm'
          : 'cursor-default border-slate-200 bg-slate-50'
      }`}
    >
      <div className="flex h-32 items-center justify-center overflow-hidden border-b border-slate-100 bg-slate-100">
        {document.thumbnailUrl ? (
          <img
            src={`${SERVER_ORIGIN}${document.thumbnailUrl}`}
            alt=""
            className="h-full w-full object-contain"
          />
        ) : document.status === 'error' ? (
          <AlertCircle className="h-6 w-6 text-rose-400" aria-hidden="true" />
        ) : (
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" aria-hidden="true" />
        )}
      </div>

      <div className="space-y-1 p-2">
        <p className="truncate text-xs font-medium text-slate-700">{document.originalName}</p>
        <div className="flex items-center justify-between gap-1">
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${meta.badge}`}>
            {meta.label}
          </span>
          <span className="text-[10px] text-slate-400">
            {formatPageCount(document.pageCount)}
          </span>
        </div>
      </div>
    </button>
  );
}

/** Queued / processing / ready / failed, as a row of small counts. */
function CountsBar({ counts }: { counts: BatchCounts }) {
  const parts: Array<[keyof BatchCounts, string]> = [
    ['queued', 'text-slate-500'],
    ['processing', 'text-amber-600'],
    ['ready', 'text-emerald-600'],
    ['error', 'text-rose-600'],
  ];

  return (
    <p className="mt-1 flex flex-wrap gap-x-2 text-[11px]">
      {parts
        .filter(([key]) => counts[key] > 0)
        .map(([key, className]) => (
          <span key={key} className={className}>
            {counts[key]} {key === 'error' ? 'failed' : key}
          </span>
        ))}
      <span className="text-slate-400">{counts.total} total</span>
    </p>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700"
    >
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{children}</span>
    </p>
  );
}
