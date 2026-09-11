import { AlertCircle, Copy, FileText, Loader2, Sparkles, Trash2 } from 'lucide-react';
import { absoluteUrl } from '../api/client';
import type { Document } from '../types';
import { STATUS_META } from '../types';
import { formatBytes, formatPageCount } from '../utils/format';

export interface BatchGridProps {
  documents: Document[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  /** How many fields the processing job found, by document id. */
  detectedFields?: Record<string, number>;
}

/**
 * The thumbnail grid: every document in the batch, with what stage it is at.
 *
 * Each card draws the page-1 preview the processing job wrote, which is why
 * that thumbnail is written as soon as page 1 exists rather than at the end of
 * the job — a card can show its document while the rest of it is still
 * rendering.
 */
export function BatchGrid({
  documents,
  selectedId,
  onSelect,
  onDelete,
  detectedFields = {},
}: BatchGridProps) {
  if (documents.length === 0) return null;

  return (
    <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
      {documents.map((document) => (
        <li key={document.id}>
          <DocumentCard
            document={document}
            selected={document.id === selectedId}
            detected={detectedFields[document.id] ?? 0}
            onSelect={() => onSelect(document.id)}
            onDelete={() => onDelete(document.id)}
          />
        </li>
      ))}
    </ul>
  );
}

interface DocumentCardProps {
  document: Document;
  selected: boolean;
  detected: number;
  onSelect: () => void;
  onDelete: () => void;
}

function DocumentCard({ document, selected, detected, onSelect, onDelete }: DocumentCardProps) {
  const status = STATUS_META[document.status];
  const ready = document.status === 'ready';
  const failed = document.status === 'error';

  return (
    <div
      className={`group relative overflow-hidden rounded-xl border transition-colors ${
        selected ? 'border-sky-400 ring-1 ring-sky-300' : 'border-slate-200 hover:border-slate-300'
      } bg-white`}
    >
      <button
        type="button"
        onClick={onSelect}
        // Only a processed document has anything to open.
        disabled={!ready}
        aria-current={selected}
        className="block w-full text-left disabled:cursor-default"
      >
        <div className="relative flex aspect-[3/4] items-center justify-center overflow-hidden bg-slate-100">
          {document.thumbnailUrl !== undefined && !failed ? (
            <img
              src={absoluteUrl(document.thumbnailUrl)}
              alt=""
              loading="lazy"
              className="h-full w-full object-cover object-top"
            />
          ) : (
            <Placeholder failed={failed} />
          )}

          {/* Progress sits over the thumbnail so a card never changes height
              as its document moves through the pipeline. */}
          {!ready && !failed && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-slate-900/10">
              <div
                className="h-full bg-sky-500 transition-[width] duration-500 ease-out"
                style={{ width: `${document.progress}%` }}
              />
            </div>
          )}
        </div>

        <div className="space-y-1 p-2">
          <p className="truncate text-xs font-medium text-slate-700" title={document.originalName}>
            {document.originalName}
          </p>

          <div className="flex flex-wrap items-center gap-1">
            <span
              className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${status.className}`}
            >
              {!ready && !failed && (
                <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />
              )}
              {failed && <AlertCircle className="h-2.5 w-2.5" aria-hidden="true" />}
              {status.label}
            </span>

            {detected > 0 && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
                title={`${detected} field${detected === 1 ? '' : 's'} found automatically`}
              >
                <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
                {detected}
              </span>
            )}

            {document.duplicateOf !== undefined && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
                title="An earlier upload holds the same bytes"
              >
                <Copy className="h-2.5 w-2.5" aria-hidden="true" />
                Duplicate
              </span>
            )}
          </div>

          <p className="truncate text-[10px] text-slate-400">
            {formatPageCount(document.pageCount)} · {formatBytes(document.size)}
          </p>

          {failed && document.errorMessage !== undefined && (
            <p className="line-clamp-2 text-[10px] text-rose-600">{document.errorMessage}</p>
          )}
        </div>
      </button>

      <button
        type="button"
        onClick={onDelete}
        className="absolute right-1.5 top-1.5 rounded-lg bg-white/90 p-1.5 text-slate-500 opacity-0 shadow-sm transition-opacity hover:bg-rose-50 hover:text-rose-600 focus:opacity-100 group-hover:opacity-100"
        aria-label={`Delete ${document.originalName}`}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

function Placeholder({ failed }: { failed: boolean }) {
  return failed ? (
    <AlertCircle className="h-7 w-7 text-rose-300" aria-hidden="true" />
  ) : (
    <FileText className="h-7 w-7 animate-pulse text-slate-300" aria-hidden="true" />
  );
}
