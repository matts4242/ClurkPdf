import { useEffect, useRef, useState } from 'react';
import { AlertCircle, Check, Loader2, RotateCw, Undo2 } from 'lucide-react';
import { confidenceBand, type Region } from '../types';

export interface RegionTextPanelProps {
  region: Region;
  onSave: (correctedText: string) => void;
  onRerun: () => void;
  disabled?: boolean;
}

/**
 * OCR result for one region, with the extracted text editable in place.
 *
 * The raw reading is never overwritten: an edit is stored separately as a
 * correction, so the original is still there to compare against and to revert
 * to. Confidence is banded green / amber / red per the specification.
 */
export function RegionTextPanel({ region, onSave, onRerun, disabled = false }: RegionTextPanelProps) {
  const stored = region.correctedText ?? region.rawText ?? '';
  const [draft, setDraft] = useState(stored);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Follow the server when the region changes underneath the editor, for
  // example after a re-run, but never clobber an edit in progress.
  useEffect(() => {
    setDraft(stored);
  }, [stored, region.id, region.ocrAt]);

  useEffect(
    () => () => {
      if (savedTimer.current !== null) clearTimeout(savedTimer.current);
    },
    [],
  );

  const dirty = draft !== stored;
  const band = confidenceBand(region.confidence);

  const save = () => {
    if (!dirty) return;
    onSave(draft);
    setJustSaved(true);
    if (savedTimer.current !== null) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setJustSaved(false), 1800);
  };

  if (region.ocrStatus === 'PENDING') {
    return (
      <p className="mt-2 text-[11px] text-slate-400">
        Not read yet. Run OCR to extract the text.
      </p>
    );
  }

  if (region.ocrStatus === 'PROCESSING') {
    return (
      <p className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        Reading...
      </p>
    );
  }

  if (region.ocrStatus === 'ERROR') {
    return (
      <div className="mt-2 space-y-1.5">
        <p className="flex items-start gap-1.5 text-[11px] text-rose-700">
          <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{region.ocrError ?? 'OCR failed for this region.'}</span>
        </p>
        <button
          type="button"
          onClick={onRerun}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-100 disabled:opacity-50"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex items-center gap-1.5">
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${band.className}`}
          title="OCR confidence"
        >
          {band.label}
        </span>
        {region.correctedText !== undefined && (
          <span className="rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-medium text-sky-700">
            edited
          </span>
        )}
        <button
          type="button"
          onClick={onRerun}
          disabled={disabled}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-slate-500 hover:bg-slate-100 disabled:opacity-50"
          title="Read this region again"
        >
          <RotateCw className="h-3 w-3" aria-hidden="true" />
          Re-read
        </button>
      </div>

      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          // Enter commits; Shift+Enter still inserts a newline.
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
          }
          if (event.key === 'Escape') setDraft(stored);
        }}
        rows={Math.min(4, Math.max(1, draft.split('\n').length))}
        spellCheck={false}
        aria-label="Extracted text"
        className="w-full resize-y rounded-md border border-slate-300 bg-white px-2 py-1 font-mono text-[11px] text-slate-800"
      />

      <div className="flex items-center gap-2 text-[10px]">
        {dirty ? (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={save}
            className="rounded bg-slate-900 px-2 py-0.5 font-medium text-white hover:bg-slate-700"
          >
            Save
          </button>
        ) : justSaved ? (
          <span className="inline-flex items-center gap-1 text-emerald-600">
            <Check className="h-3 w-3" aria-hidden="true" />
            Saved
          </span>
        ) : null}

        {region.correctedText !== undefined && region.rawText !== undefined && (
          <button
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setDraft(region.rawText ?? '');
              onSave('');
            }}
            className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800"
            title={`Original reading: ${region.rawText}`}
          >
            <Undo2 className="h-3 w-3" aria-hidden="true" />
            Revert to OCR
          </button>
        )}
      </div>
    </div>
  );
}
