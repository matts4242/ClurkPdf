import { CheckCircle2, Loader2, Sparkles } from 'lucide-react';
import type { BatchWithProgress } from '../types';
import { PIPELINE_STAGES, STATUS_META } from '../types';

export interface BatchProgressProps {
  batch: BatchWithProgress;
  /** False while the live connection is down, so the bar can say it is stale. */
  live?: boolean;
}

/**
 * The batch pipeline, as the spec's queue view: how many documents are in each
 * stage, and one bar for the whole upload.
 *
 * Stages with nothing in them are dropped rather than shown as zeroes. A row
 * of `Queued 0 · Processing 0 · Review 12 · Failed 0` reads as four facts to
 * check; `Review 12` reads as one.
 */
export function BatchProgress({ batch, live = true }: BatchProgressProps) {
  const done = batch.status === 'complete';
  const failed = batch.counts.error;
  const stages = PIPELINE_STAGES.filter((stage) => batch.counts[stage.status] > 0);

  return (
    <section
      className="space-y-2.5 rounded-xl border border-slate-200 bg-white p-3"
      aria-label={`Batch ${batch.name}`}
    >
      <div className="flex items-center gap-2">
        {done ? (
          <CheckCircle2
            className={`h-4 w-4 shrink-0 ${failed > 0 ? 'text-amber-500' : 'text-emerald-500'}`}
            aria-hidden="true"
          />
        ) : (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-sky-500" aria-hidden="true" />
        )}

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-700">{batch.name}</p>
          <p className="text-[11px] text-slate-400">
            {summarise(batch, done, failed)}
            {!live && ' · reconnecting'}
          </p>
        </div>

        <span className="shrink-0 text-xs font-medium tabular-nums text-slate-500">
          {batch.progress}%
        </span>
      </div>

      <div
        className="h-1.5 overflow-hidden rounded-full bg-slate-200"
        role="progressbar"
        aria-valuenow={batch.progress}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${batch.name} progress`}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            failed > 0 && done ? 'bg-amber-500' : done ? 'bg-emerald-500' : 'bg-sky-500'
          }`}
          style={{ width: `${batch.progress}%` }}
        />
      </div>

      {stages.length > 0 && (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
          {stages.map((stage) => (
            <li key={stage.status} className="flex items-center gap-1.5">
              <span
                className={`h-1.5 w-1.5 rounded-full ${STATUS_META[stage.status].dot}`}
                aria-hidden="true"
              />
              {stage.label}
              <span className="font-medium tabular-nums text-slate-700">
                {batch.counts[stage.status]}
              </span>
            </li>
          ))}

          {batch.detectedFieldCount > 0 && (
            <li className="flex items-center gap-1.5 text-violet-600">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {batch.detectedFieldCount} field
              {batch.detectedFieldCount === 1 ? '' : 's'} found
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function summarise(batch: BatchWithProgress, done: boolean, failed: number): string {
  const total = `${batch.documentCount} ${batch.documentCount === 1 ? 'document' : 'documents'}`;
  if (!done) return `${total} · ${batch.counts.ready} done`;
  if (failed > 0) return `${total} · ${failed} failed`;
  return `${total} · all ready`;
}
