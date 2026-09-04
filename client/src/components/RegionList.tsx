import { SquareDashed, Trash2 } from 'lucide-react';
import { FieldTypeSelector } from './FieldTypeSelector';
import {
  FIELD_TYPE_META,
  type FieldType,
  type Region,
  type UpdateRegionInput,
} from '../types';

export interface RegionListProps {
  regions: Region[];
  selectedRegionId: string | null;
  /** When set, regions on other pages are shown but dimmed. */
  currentPage?: number;
  onRegionSelect: (regionId: string) => void;
  onRegionDelete: (regionId: string) => void;
  onRegionUpdate: (regionId: string, updates: UpdateRegionInput) => void;
}

/**
 * Sidebar list of the regions drawn on a document.
 *
 * Each row selects its region on the canvas and lets its field type be changed
 * in place, which is the quickest way to fix a mis-tagged box.
 */
export function RegionList({
  regions,
  selectedRegionId,
  currentPage,
  onRegionSelect,
  onRegionDelete,
  onRegionUpdate,
}: RegionListProps) {
  if (regions.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center">
        <SquareDashed className="h-6 w-6 text-slate-300" aria-hidden="true" />
        <p className="text-xs text-slate-500">
          No regions yet. Switch to Draw and drag a box over a field.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-1.5">
      {regions.map((region) => {
        const isSelected = region.id === selectedRegionId;
        const onAnotherPage = currentPage !== undefined && region.pageNumber !== currentPage;

        return (
          <li key={region.id}>
            <div
              className={`rounded-lg border px-2.5 py-2 transition-colors ${
                isSelected ? 'border-sky-400 bg-sky-50' : 'border-slate-200 bg-white'
              } ${onAnotherPage ? 'opacity-60' : ''}`}
            >
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onRegionSelect(region.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  aria-current={isSelected}
                >
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: FIELD_TYPE_META[region.fieldType].color }}
                  />
                  <span className="truncate text-xs font-medium text-slate-700">
                    {region.fieldType === 'CUSTOM' && region.fieldLabel
                      ? region.fieldLabel
                      : FIELD_TYPE_META[region.fieldType].label}
                  </span>
                  <span className="ml-auto shrink-0 text-[11px] text-slate-400">
                    p{region.pageNumber}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onRegionDelete(region.id)}
                  className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                  aria-label="Delete region"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>

              {isSelected && (
                <div className="mt-2 space-y-1.5">
                  <FieldTypeSelector
                    compact
                    value={region.fieldType}
                    {...(region.fieldLabel === undefined ? {} : { label: region.fieldLabel })}
                    onChange={(fieldType: FieldType, label?: string) =>
                      onRegionUpdate(region.id, {
                        fieldType,
                        ...(label === undefined ? {} : { fieldLabel: label }),
                      })
                    }
                  />
                  <p className="font-mono text-[10px] text-slate-400 tabular-nums">
                    {region.x.toFixed(3)}, {region.y.toFixed(3)} &middot;{' '}
                    {region.width.toFixed(3)} &times; {region.height.toFixed(3)}
                  </p>
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
