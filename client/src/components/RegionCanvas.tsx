import { useCallback, useEffect, useRef, useState } from 'react';
import {
  HANDLE_SIZE,
  MIN_DRAW_SIZE,
  canvasToRegion,
  clampToPage,
  handleAtPoint,
  handleCenter,
  rectFromPoints,
  regionAtPoint,
  regionToCanvas,
  resizeRect,
  roundRect,
  RESIZE_HANDLES,
  type PixelRect,
  type ResizeHandle,
} from '../utils/canvas';
import {
  FIELD_TYPE_META,
  regionLabel,
  type FieldType,
  type NormalizedRect,
  type Region,
  type ViewerMode,
} from '../types';

export interface RegionCanvasProps {
  pageNumber: number;
  /** Displayed size of the page image, in CSS pixels. */
  width: number;
  height: number;
  regions: Region[];
  mode: ViewerMode;
  selectedRegionId: string | null;
  /** Field type applied to newly drawn regions. */
  activeFieldType: FieldType;
  onRegionCreate: (rect: NormalizedRect) => void;
  onRegionUpdate: (regionId: string, updates: NormalizedRect) => void;
  onRegionSelect: (regionId: string | null) => void;
  onRegionDelete: (regionId: string) => void;
}

/** What the pointer is currently doing. */
type Interaction =
  | { kind: 'idle' }
  | { kind: 'drawing'; startX: number; startY: number; rect: PixelRect }
  | { kind: 'moving'; regionId: string; grabDx: number; grabDy: number; rect: PixelRect }
  | { kind: 'resizing'; regionId: string; handle: ResizeHandle; rect: PixelRect };

/**
 * Interactive overlay for drawing and editing extraction regions.
 *
 * Sits absolutely over the page image at exactly its displayed size, so canvas
 * pixels map to page fractions by simple division. Everything is drawn with the
 * 2D canvas API — no drawing library.
 */
export function RegionCanvas({
  pageNumber,
  width,
  height,
  regions,
  mode,
  selectedRegionId,
  activeFieldType,
  onRegionCreate,
  onRegionUpdate,
  onRegionSelect,
  onRegionDelete,
}: RegionCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [interaction, setInteraction] = useState<Interaction>({ kind: 'idle' });

  const pageRegions = regions.filter((region) => region.pageNumber === pageNumber);

  // ---------------------------------------------------------------------
  // Painting
  // ---------------------------------------------------------------------

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Back the canvas with real device pixels so strokes and text stay sharp.
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    for (const region of pageRegions) {
      const rect = liveRectFor(region);
      const isSelected = region.id === selectedRegionId;
      paintRegion(ctx, rect, FIELD_TYPE_META[region.fieldType].color, regionLabel(region), isSelected);
    }

    if (interaction.kind === 'drawing') {
      const color = FIELD_TYPE_META[activeFieldType].color;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.fillStyle = withAlpha(color, 0.12);
      ctx.fillRect(
        interaction.rect.x,
        interaction.rect.y,
        interaction.rect.width,
        interaction.rect.height,
      );
      ctx.strokeRect(
        interaction.rect.x,
        interaction.rect.y,
        interaction.rect.width,
        interaction.rect.height,
      );
      ctx.restore();
    }

    /** Use the in-flight rectangle while a region is being dragged. */
    function liveRectFor(region: Region): PixelRect {
      if (
        (interaction.kind === 'moving' || interaction.kind === 'resizing') &&
        interaction.regionId === region.id
      ) {
        return interaction.rect;
      }
      return regionToCanvas(region, width, height);
    }
  }, [pageRegions, width, height, selectedRegionId, interaction, activeFieldType]);

  useEffect(() => {
    draw();
  }, [draw]);

  // ---------------------------------------------------------------------
  // Pointer handling
  // ---------------------------------------------------------------------

  const pointFromEvent = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { px: event.clientX - bounds.left, py: event.clientY - bounds.top };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (mode === 'pan' || event.button !== 0) return;
    const { px, py } = pointFromEvent(event);
    event.currentTarget.setPointerCapture(event.pointerId);

    if (mode === 'draw') {
      setInteraction({
        kind: 'drawing',
        startX: px,
        startY: py,
        rect: { x: px, y: py, width: 0, height: 0 },
      });
      return;
    }

    // Select mode: a handle on the selected region wins over the regions
    // themselves, so a corner grab resizes rather than starting a move.
    const selected = pageRegions.find((region) => region.id === selectedRegionId);
    if (selected) {
      const rect = regionToCanvas(selected, width, height);
      const handle = handleAtPoint(rect, px, py);
      if (handle) {
        setInteraction({ kind: 'resizing', regionId: selected.id, handle, rect });
        return;
      }
    }

    const hit = regionAtPoint(pageRegions, px, py, width, height);
    onRegionSelect(hit ? hit.id : null);
    if (hit) {
      const rect = regionToCanvas(hit, width, height);
      setInteraction({
        kind: 'moving',
        regionId: hit.id,
        grabDx: px - rect.x,
        grabDy: py - rect.y,
        rect,
      });
    }
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (interaction.kind === 'idle') return;
    const { px, py } = pointFromEvent(event);

    if (interaction.kind === 'drawing') {
      setInteraction({
        ...interaction,
        rect: rectFromPoints(interaction.startX, interaction.startY, px, py),
      });
      return;
    }

    if (interaction.kind === 'moving') {
      setInteraction({
        ...interaction,
        rect: {
          ...interaction.rect,
          x: px - interaction.grabDx,
          y: py - interaction.grabDy,
        },
      });
      return;
    }

    setInteraction({
      ...interaction,
      rect: resizeRect(interaction.rect, interaction.handle, px, py),
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (interaction.kind === 'idle') return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    const current = interaction;
    setInteraction({ kind: 'idle' });

    if (current.kind === 'drawing') {
      // Ignore stray clicks that were never really a drag.
      if (current.rect.width < MIN_DRAW_SIZE || current.rect.height < MIN_DRAW_SIZE) return;
      onRegionCreate(roundRect(clampToPage(canvasToRegion(current.rect, width, height))));
      return;
    }

    if (current.rect.width < MIN_DRAW_SIZE || current.rect.height < MIN_DRAW_SIZE) {
      // A resize collapsed the region; leave it as it was.
      return;
    }
    onRegionUpdate(
      current.regionId,
      roundRect(clampToPage(canvasToRegion(current.rect, width, height))),
    );
  };

  // Delete or Backspace removes the selected region.
  useEffect(() => {
    if (!selectedRegionId || mode !== 'select') return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return;
      const target = event.target as HTMLElement | null;
      // Never steal the key from a field the user is typing in.
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      onRegionDelete(selectedRegionId);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedRegionId, mode, onRegionDelete]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width: `${width}px`, height: `${height}px` }}
      className={`absolute inset-0 ${
        mode === 'draw' ? 'cursor-crosshair' : mode === 'select' ? 'cursor-default' : 'cursor-grab'
      } ${mode === 'pan' ? 'pointer-events-none' : ''}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  );
}

/** Draw one region: translucent fill, solid border, name tag, handles if selected. */
function paintRegion(
  ctx: CanvasRenderingContext2D,
  rect: PixelRect,
  color: string,
  label: string,
  isSelected: boolean,
): void {
  ctx.save();

  ctx.fillStyle = withAlpha(color, isSelected ? 0.22 : 0.12);
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);

  ctx.strokeStyle = color;
  ctx.lineWidth = isSelected ? 2 : 1.25;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

  // Name tag, placed above the box unless that would leave the page.
  ctx.font = '500 11px ui-sans-serif, system-ui, sans-serif';
  const textWidth = ctx.measureText(label).width;
  const tagHeight = 16;
  const tagY = rect.y >= tagHeight + 2 ? rect.y - tagHeight - 2 : rect.y + 2;

  ctx.fillStyle = color;
  ctx.fillRect(rect.x, tagY, textWidth + 10, tagHeight);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(label, rect.x + 5, tagY + 11.5);

  if (isSelected) {
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    for (const handle of RESIZE_HANDLES) {
      const center = handleCenter(rect, handle);
      const half = HANDLE_SIZE / 2;
      ctx.fillRect(center.x - half, center.y - half, HANDLE_SIZE, HANDLE_SIZE);
      ctx.strokeRect(center.x - half, center.y - half, HANDLE_SIZE, HANDLE_SIZE);
    }
  }

  ctx.restore();
}

/** `#rrggbb` plus an alpha channel. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace('#', '');
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
