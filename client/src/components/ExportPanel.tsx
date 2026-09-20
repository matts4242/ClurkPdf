import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Download, Loader2, X } from 'lucide-react';
import { exportUrl, fetchExport, type ExportScope } from '../api/client';
import type { ExportPayload, ExportRow, IssueSeverity } from '../types';
import { DOWNLOAD_FORMATS, exportCell, worstSeverity } from '../types';

export interface ExportPanelProps {
  scope: ExportScope;
  onClose: () => void;
}

/**
 * The export: what is about to leave the building, and what is wrong with it.
 *
 * Shown before the download rather than after, because the point of the
 * checking is to be read while there is still something to do about it. A
 * fifty-invoice batch exports whether or not its numbers add up; the value is
 * knowing which three rows to open first, and the preview is where that is
 * said.
 *
 * The download itself is a plain link. Letting the browser fetch the file
 * means it never passes through JavaScript, so the Save dialog, the progress
 * and the filename all behave the way the user expects them to.
 */
export function ExportPanel({ scope, onClose }: ExportPanelProps) {
  const [payload, setPayload] = useState<ExportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [onlyProblems, setOnlyProblems] = useState(false);

  const key = `${scope.batchId ?? ''}|${(scope.documentIds ?? []).join(',')}`;

  const load = useCallback(
    (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      fetchExport(scope, signal)
        .then((fetched) => {
          setPayload(fetched);
          setLoading(false);
        })
        .catch((caught: unknown) => {
          if (signal?.aborted === true) return;
          setError(caught instanceof Error ? caught.message : 'Could not build the export');
          setLoading(false);
        });
    },
    // `scope` is rebuilt on every render by the caller; the key is its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  // Escape closes, which is what a panel over the page should do.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const rows = payload?.rows ?? [];
  const visible = onlyProblems ? rows.filter((row) => row.needsReview) : rows;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Export"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-full w-full max-w-6xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        <header className="flex items-center gap-3 border-b border-slate-200 px-5 py-3">
          <Download className="h-4 w-4 text-sky-600" aria-hidden="true" />
          <h2 className="text-sm font-semibold text-slate-800">
            Export{payload?.batchName === undefined ? '' : ` · ${payload.batchName}`}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close export"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        {loading && (
          <div className="flex items-center gap-2 px-5 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Building the export...
          </div>
        )}

        {error !== null && (
          <div className="px-5 py-8 text-sm text-rose-600">{error}</div>
        )}

        {payload !== null && !loading && error === null && (
          <>
            <Summary payload={payload} />

            <div className="flex items-center gap-3 border-b border-slate-200 px-5 py-2">
              <label className="flex items-center gap-1.5 text-[11px] text-slate-500">
                <input
                  type="checkbox"
                  checked={onlyProblems}
                  onChange={(event) => setOnlyProblems(event.target.checked)}
                  className="h-3 w-3"
                />
                Only rows needing review
              </label>
              <span className="text-[11px] text-slate-400">
                {visible.length} of {rows.length} shown
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {visible.length === 0 ? (
                <p className="px-5 py-8 text-sm text-slate-500">
                  {rows.length === 0
                    ? 'Nothing to export yet. Upload some invoices first.'
                    : 'Nothing needs review.'}
                </p>
              ) : (
                <Table payload={payload} rows={visible} />
              )}
            </div>

            <footer className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-5 py-3">
              <span className="text-[11px] text-slate-400">Download as</span>
              {DOWNLOAD_FORMATS.map(({ format, label, hint }) => (
                <a
                  key={format}
                  href={exportUrl(scope, format, { download: true })}
                  // The browser fetches it; nothing here touches the bytes.
                  download
                  title={hint}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium ${
                    rows.length === 0
                      ? 'pointer-events-none bg-slate-100 text-slate-400'
                      : 'bg-slate-800 text-white hover:bg-slate-700'
                  }`}
                >
                  <Download className="h-3 w-3" aria-hidden="true" />
                  {label}
                </a>
              ))}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function Summary({ payload }: { payload: ExportPayload }) {
  const { summary } = payload;
  const clean = summary.documents - summary.withErrors - summary.withWarnings;

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-b border-slate-200 bg-slate-50 px-5 py-2.5 text-xs">
      <Stat label="Documents" value={String(summary.documents)} />
      {summary.totalValue !== undefined && (
        <Stat
          label="Total"
          value={`${summary.currency ?? ''}${summary.totalValue.toFixed(2)}`}
        />
      )}
      {clean > 0 && (
        <span className="inline-flex items-center gap-1 text-emerald-700">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
          {clean} clean
        </span>
      )}
      {summary.withWarnings > 0 && (
        <span className="inline-flex items-center gap-1 text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          {summary.withWarnings} to check
        </span>
      )}
      {summary.withErrors > 0 && (
        <span className="inline-flex items-center gap-1 text-rose-700">
          <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
          {summary.withErrors} with errors
        </span>
      )}
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <span className="text-slate-500">
    {label} <span className="font-medium tabular-nums text-slate-800">{value}</span>
  </span>
);

function Table({ payload, rows }: { payload: ExportPayload; rows: ExportRow[] }) {
  // The issues column is rendered as badges instead of text, so it is dropped
  // from the plain columns and handled on its own at the end.
  const columns = payload.columns.filter(
    (column) => column !== 'issues' && column !== 'needs_review',
  );

  return (
    <table className="w-full border-collapse text-left text-xs">
      <thead className="sticky top-0 bg-white shadow-[0_1px_0_rgb(226_232_240)]">
        <tr>
          {columns.map((column) => (
            <th
              key={column}
              className="whitespace-nowrap px-3 py-2 font-medium text-slate-500"
            >
              {column.replace(/_/g, ' ')}
            </th>
          ))}
          <th className="px-3 py-2 font-medium text-slate-500">checks</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const severity = worstSeverity(row);
          return (
            <tr
              key={row.documentId}
              className={`border-t border-slate-100 ${rowTint(severity)}`}
            >
              {columns.map((column) => (
                <td
                  key={column}
                  className="max-w-56 truncate px-3 py-1.5 text-slate-700"
                  title={exportCell(row, column)}
                >
                  {exportCell(row, column)}
                </td>
              ))}
              <td className="px-3 py-1.5">
                {row.issues.length === 0 ? (
                  <CheckCircle2
                    className="h-3.5 w-3.5 text-emerald-500"
                    aria-label="No problems"
                  />
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {row.issues.map((issue, index) => (
                      <span
                        key={`${issue.code}-${index}`}
                        title={issue.message}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                          issue.severity === 'error'
                            ? 'bg-rose-100 text-rose-700'
                            : 'bg-amber-100 text-amber-700'
                        }`}
                      >
                        {issue.code.toLowerCase().replace(/_/g, ' ')}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const rowTint = (severity: IssueSeverity | null): string => {
  if (severity === 'error') return 'bg-rose-50/60';
  if (severity === 'warning') return 'bg-amber-50/50';
  return '';
};
