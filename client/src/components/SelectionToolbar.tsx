import { useEffect } from 'react';
import { FIELD_TYPE_META, type FieldType } from '../types';

/** Field types offered as one-key shortcuts, in order. */
export const QUICK_FIELD_TYPES: FieldType[] = [
  'INVOICE_NUMBER',
  'INVOICE_DATE',
  'VENDOR_NAME',
  'TOTAL',
  'SUBTOTAL',
  'TAX',
  'DUE_DATE',
  'PO_NUMBER',
  'LINE_ITEMS',
];

export interface SelectionToolbarProps {
  /** The text the user highlighted, shown so they can confirm the snap. */
  text: string;
  /** Position within the page overlay, in CSS pixels. */
  anchor: { x: number; y: number };
  onAssign: (fieldType: FieldType) => void;
  onDismiss: () => void;
}

/**
 * Floating field-type picker for a text selection.
 *
 * Number keys 1-9 assign the corresponding type without leaving the keyboard,
 * which is the difference between tagging an invoice in seconds and in minutes.
 */
export function SelectionToolbar({ text, anchor, onAssign, onDismiss }: SelectionToolbarProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal a digit from a field the user is typing in.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
        return;
      }

      const digit = Number.parseInt(event.key, 10);
      if (!Number.isInteger(digit) || digit < 1 || digit > QUICK_FIELD_TYPES.length) return;
      const fieldType = QUICK_FIELD_TYPES[digit - 1];
      if (!fieldType) return;

      event.preventDefault();
      onAssign(fieldType);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onAssign, onDismiss]);

  const preview = text.replace(/\s+/g, ' ').trim();

  return (
    <div
      // Sits above the selection, centred on it, and never swallows the caret.
      style={{
        position: 'absolute',
        left: `${anchor.x}px`,
        top: `${anchor.y}px`,
        transform: 'translate(-50%, calc(-100% - 10px))',
      }}
      className="z-20 w-max max-w-md rounded-xl border border-slate-200 bg-white p-2 shadow-xl"
      onMouseDown={(event) => event.preventDefault()}
      role="dialog"
      aria-label="Tag the selected text"
    >
      <p className="mb-1.5 max-w-sm truncate px-1 font-mono text-[11px] text-slate-500">
        &ldquo;{preview}&rdquo;
      </p>

      <div className="flex flex-wrap gap-1">
        {QUICK_FIELD_TYPES.map((fieldType, index) => (
          <button
            key={fieldType}
            type="button"
            onClick={() => onAssign(fieldType)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-50"
          >
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: FIELD_TYPE_META[fieldType].color }}
            />
            {FIELD_TYPE_META[fieldType].label}
            <kbd className="rounded bg-slate-100 px-1 font-sans text-[9px] text-slate-500">
              {index + 1}
            </kbd>
          </button>
        ))}
        <button
          type="button"
          onClick={() => onAssign('CUSTOM')}
          className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:border-slate-400 hover:bg-slate-50"
        >
          Custom
        </button>
      </div>
    </div>
  );
}
