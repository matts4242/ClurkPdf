import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import type { JSX } from 'react';

export type UploadProgressStatus = 'uploading' | 'processing' | 'complete' | 'error';

export interface UploadProgressProps {
  fileName: string;
  /** 0-100. */
  progress: number;
  status: UploadProgressStatus;
  errorMessage?: string;
  onCancel?: () => void;
  onRetry?: () => void;
}

const STATUS_STYLES: Record<
  UploadProgressStatus,
  { label: string; badge: string; bar: string; icon: JSX.Element }
> = {
  uploading: {
    label: 'Uploading',
    badge: 'bg-sky-100 text-sky-700',
    bar: 'bg-sky-500',
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />,
  },
  processing: {
    label: 'Processing',
    badge: 'bg-amber-100 text-amber-700',
    bar: 'bg-amber-500',
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />,
  },
  complete: {
    label: 'Complete',
    badge: 'bg-emerald-100 text-emerald-700',
    bar: 'bg-emerald-500',
    icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />,
  },
  error: {
    label: 'Failed',
    badge: 'bg-rose-100 text-rose-700',
    bar: 'bg-rose-500',
    icon: <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />,
  },
};

/**
 * Progress bar and status badge for one in-flight upload.
 *
 * While the server renders page 1 there is no byte-level progress to report,
 * so the bar animates as an indeterminate stripe instead of sitting at 100%.
 */
export function UploadProgress({
  fileName,
  progress,
  status,
  errorMessage,
  onCancel,
  onRetry,
}: UploadProgressProps) {
  const style = STATUS_STYLES[status];
  const clamped = Math.min(100, Math.max(0, progress));
  const isIndeterminate = status === 'processing';

  return (
    <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-medium text-slate-700">{fileName}</span>
        <span
          className={`ml-auto inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${style.badge}`}
        >
          {style.icon}
          {style.label}
        </span>
        {status === 'uploading' && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="shrink-0 rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label={`Cancel upload of ${fileName}`}
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        )}
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuenow={isIndeterminate ? undefined : clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${style.label} ${fileName}`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${style.bar} ${
            isIndeterminate ? 'animate-pulse' : ''
          }`}
          style={{ width: `${isIndeterminate ? 100 : clamped}%` }}
        />
      </div>

      {status === 'error' && errorMessage !== undefined && (
        <div className="flex items-start gap-2 text-xs text-rose-700">
          <span className="flex-1">{errorMessage}</span>
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="shrink-0 rounded px-2 py-0.5 font-medium text-rose-700 underline underline-offset-2 hover:bg-rose-50"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {status === 'uploading' && (
        <p className="text-right text-[11px] tabular-nums text-slate-400">{clamped}%</p>
      )}
    </div>
  );
}
