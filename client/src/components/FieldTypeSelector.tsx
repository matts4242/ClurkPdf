import { FIELD_TYPES, FIELD_TYPE_META, type FieldType } from '../types';

export interface FieldTypeSelectorProps {
  value: FieldType;
  onChange: (fieldType: FieldType, label?: string) => void;
  /** Custom label, shown as a second input when the type is CUSTOM. */
  label?: string;
  allowCustom?: boolean;
  id?: string;
  compact?: boolean;
}

/**
 * Dropdown of extraction field types.
 *
 * Choosing CUSTOM reveals a free-text label, since that is the only type where
 * the name is not already implied.
 */
export function FieldTypeSelector({
  value,
  onChange,
  label,
  allowCustom = true,
  id,
  compact = false,
}: FieldTypeSelectorProps) {
  const options = allowCustom ? FIELD_TYPES : FIELD_TYPES.filter((type) => type !== 'CUSTOM');
  const sizing = compact ? 'px-1.5 py-1 text-[11px]' : 'px-2 py-1.5 text-xs';

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: FIELD_TYPE_META[value].color }}
      />
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as FieldType, label)}
        className={`min-w-0 flex-1 rounded-md border border-slate-300 bg-white text-slate-700 ${sizing}`}
        aria-label="Field type"
      >
        {options.map((type) => (
          <option key={type} value={type}>
            {FIELD_TYPE_META[type].label}
          </option>
        ))}
      </select>

      {value === 'CUSTOM' && (
        <input
          type="text"
          value={label ?? ''}
          placeholder="Label"
          onChange={(event) => onChange('CUSTOM', event.target.value)}
          className={`min-w-0 flex-1 rounded-md border border-slate-300 bg-white text-slate-700 ${sizing}`}
          aria-label="Custom field label"
          maxLength={100}
        />
      )}
    </div>
  );
}
