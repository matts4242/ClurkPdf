import { useCallback, useEffect, useState } from 'react';
import { BookmarkPlus, Loader2, Sparkles, Trash2, Wand2 } from 'lucide-react';
import {
  applyTemplate,
  createTemplate,
  deleteTemplate,
  fetchTemplateSuggestions,
  listTemplates,
} from '../api/client';
import type { Template, TemplateSuggestion } from '../types';

export interface TemplatePanelProps {
  /** The document on screen: what a new template is saved from. */
  documentId: string;
  /** Disables saving when there is nothing marked up yet. */
  regionCount: number;
  /** The template that already filled this document in, if any. */
  appliedTemplateId?: string;
  /** The batch it belongs to, for "apply to the whole batch". */
  batchId?: string;
  /** Called after anything that changes the document's regions. */
  onRegionsChanged: () => void;
}

/**
 * Saving and applying templates, from inside the viewer.
 *
 * Two halves. The top saves what is on screen as a template for this vendor —
 * the spec's "Save as Template", offered once a document has been marked up.
 * The bottom lists templates that look like this document and applies them,
 * which is the spec's "Apply to Similar Documents".
 *
 * A template that matched strongly has already been applied by the processing
 * job, so this panel is what handles the weaker matches and the ones a person
 * wants to force.
 */
export function TemplatePanel({
  documentId,
  regionCount,
  appliedTemplateId,
  batchId,
  onRegionsChanged,
}: TemplatePanelProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [suggestions, setSuggestions] = useState<TemplateSuggestion[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');

  const refresh = useCallback(
    (signal?: AbortSignal) => {
      void listTemplates(signal)
        .then(setTemplates)
        .catch(() => undefined);
      void fetchTemplateSuggestions(documentId, signal)
        .then(setSuggestions)
        .catch(() => undefined);
    },
    [documentId],
  );

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      const template = await createTemplate({
        documentId,
        ...(name.trim() === '' ? {} : { name: name.trim() }),
      });
      setName('');
      setMessage(`Saved "${template.name}" for ${template.vendorIdentifier}`);
      refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not save the template');
    } finally {
      setSaving(false);
    }
  }, [documentId, name, refresh]);

  const handleApply = useCallback(
    async (template: Template, scope: 'document' | 'batch') => {
      setBusy(template.id);
      setMessage(null);
      try {
        const result = await applyTemplate(
          template.id,
          scope === 'batch' && batchId !== undefined
            ? { batchId }
            : { documentIds: [documentId] },
        );
        setMessage(
          result.regionsCreated === 0
            ? 'Nothing to add — those fields are already filled in'
            : `Added ${result.regionsCreated} field${result.regionsCreated === 1 ? '' : 's'}` +
                (scope === 'batch' ? ` across ${result.applications.length} documents` : ''),
        );
        onRegionsChanged();
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not apply the template');
      } finally {
        setBusy(null);
      }
    },
    [batchId, documentId, onRegionsChanged, refresh],
  );

  const handleDelete = useCallback(
    async (template: Template) => {
      setBusy(template.id);
      try {
        await deleteTemplate(template.id);
        setMessage(`Deleted "${template.name}"`);
        refresh();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : 'Could not delete the template');
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  // Suggestions first, then anything else held, so the list is ordered by how
  // likely it is to be wanted.
  const suggested = new Set(suggestions.map((suggestion) => suggestion.template.id));
  const others = templates.filter((template) => !suggested.has(template.id));

  return (
    <section className="space-y-3">
      <div>
        <h3 className="mb-2 text-[11px] font-medium tracking-wide text-slate-400 uppercase">
          Templates
        </h3>

        <div className="flex gap-1.5">
          <input
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Name (optional)"
            className="min-w-0 flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-xs placeholder:text-slate-400 focus:border-sky-400 focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || regionCount === 0}
            title={
              regionCount === 0
                ? 'Mark up a field first, then save it as a template'
                : "Save this document's regions as a template for its vendor"
            }
            className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-slate-800 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {saving ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <BookmarkPlus className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            Save
          </button>
        </div>
      </div>

      {message !== null && (
        <p className="rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] text-slate-600">{message}</p>
      )}

      {suggestions.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[11px] text-slate-400">Matches this document</p>
          {suggestions.map((suggestion) => (
            <TemplateRow
              key={suggestion.template.id}
              template={suggestion.template}
              score={suggestion.score}
              matchedText={suggestion.matchedText}
              applied={suggestion.template.id === appliedTemplateId}
              busy={busy === suggestion.template.id}
              canApplyToBatch={batchId !== undefined}
              onApply={(scope) => void handleApply(suggestion.template, scope)}
              onDelete={() => void handleDelete(suggestion.template)}
            />
          ))}
        </div>
      )}

      {others.length > 0 && (
        <details className="space-y-1.5">
          <summary className="cursor-pointer text-[11px] text-slate-400">
            All templates ({others.length})
          </summary>
          <div className="mt-1.5 space-y-1.5">
            {others.map((template) => (
              <TemplateRow
                key={template.id}
                template={template}
                applied={template.id === appliedTemplateId}
                busy={busy === template.id}
                canApplyToBatch={batchId !== undefined}
                onApply={(scope) => void handleApply(template, scope)}
                onDelete={() => void handleDelete(template)}
              />
            ))}
          </div>
        </details>
      )}

      {templates.length === 0 && (
        <p className="text-[11px] text-slate-400">
          No templates yet. Mark up one invoice from a vendor and save it — the next one
          arrives already filled in.
        </p>
      )}
    </section>
  );
}

interface TemplateRowProps {
  template: Template;
  score?: number;
  matchedText?: string;
  applied: boolean;
  busy: boolean;
  canApplyToBatch: boolean;
  onApply: (scope: 'document' | 'batch') => void;
  onDelete: () => void;
}

function TemplateRow({
  template,
  score,
  matchedText,
  applied,
  busy,
  canApplyToBatch,
  onApply,
  onDelete,
}: TemplateRowProps) {
  return (
    <div className="rounded-lg border border-slate-200 px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-slate-700">
          {template.name}
        </span>
        {applied && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-medium text-violet-700"
            title="This template filled in the fields on screen"
          >
            <Sparkles className="h-2.5 w-2.5" aria-hidden="true" />
            Applied
          </span>
        )}
        {score !== undefined && !applied && (
          <span className="shrink-0 rounded bg-slate-100 px-1 py-0.5 text-[10px] tabular-nums text-slate-500">
            {Math.round(score * 100)}%
          </span>
        )}
        <button
          type="button"
          onClick={onDelete}
          disabled={busy}
          className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
          aria-label={`Delete template ${template.name}`}
        >
          <Trash2 className="h-3 w-3" aria-hidden="true" />
        </button>
      </div>

      <p className="mt-0.5 truncate text-[10px] text-slate-400">
        {template.regions.length} field{template.regions.length === 1 ? '' : 's'} ·{' '}
        {template.useCount === 0 ? 'never used' : `used ${template.useCount}×`}
        {matchedText !== undefined && matchedText !== '' && ` · matched "${matchedText}"`}
      </p>

      <div className="mt-1.5 flex gap-1.5">
        <button
          type="button"
          onClick={() => onApply('document')}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded border border-slate-200 px-1.5 py-1 text-[10px] font-medium text-slate-600 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden="true" />
          ) : (
            <Wand2 className="h-2.5 w-2.5" aria-hidden="true" />
          )}
          Apply
        </button>
        {canApplyToBatch && (
          <button
            type="button"
            onClick={() => onApply('batch')}
            disabled={busy}
            className="rounded border border-slate-200 px-1.5 py-1 text-[10px] font-medium text-slate-600 hover:border-sky-300 hover:bg-sky-50 hover:text-sky-700 disabled:opacity-50"
            title="Apply to every document in this batch"
          >
            Whole batch
          </button>
        )}
      </div>
    </div>
  );
}
