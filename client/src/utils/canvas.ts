import type { NormalizedRect, Region } from '../types';

/**
 * Coordinate helpers for the region canvas.
 *
 * Regions are stored normalised to 0-1 against the page, so they survive zoom
 * changes and re-renders at any resolution. The canvas works in device-
 * independent pixels. Everything that crosses between the two lives here.
 */

/** A rectangle in canvas pixels. */
export interface PixelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const screenToNormalized = (
  canvasX: number,
  canvasY: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } => ({
  x: canvasWidth === 0 ? 0 : canvasX / canvasWidth,
  y: canvasHeight === 0 ? 0 : canvasY / canvasHeight,
});

export const normalizedToScreen = (
  normX: number,
  normY: number,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number } => ({
  x: normX * canvasWidth,
  y: normY * canvasHeight,
});

export const regionToCanvas = (
  region: NormalizedRect,
  canvasWidth: number,
  canvasHeight: number,
): PixelRect => ({
  x: region.x * canvasWidth,
  y: region.y * canvasHeight,
  width: region.width * canvasWidth,
  height: region.height * canvasHeight,
});

export const canvasToRegion = (
  rect: PixelRect,
  canvasWidth: number,
  canvasHeight: number,
): NormalizedRect => ({
  x: canvasWidth === 0 ? 0 : rect.x / canvasWidth,
  y: canvasHeight === 0 ? 0 : rect.y / canvasHeight,
  width: canvasWidth === 0 ? 0 : rect.width / canvasWidth,
  height: canvasHeight === 0 ? 0 : rect.height / canvasHeight,
});

/**
 * Build a rectangle from two drag points.
 *
 * Dragging up or left produces a negative extent, which the rest of the system
 * rejects, so the corners are sorted here into a positive-extent rectangle.
 */
export function rectFromPoints(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): PixelRect {
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

/** Clamp a normalised rectangle so it lies entirely within the page. */
export function clampToPage(rect: NormalizedRect): NormalizedRect {
  const width = Math.min(Math.max(rect.width, 0), 1);
  const height = Math.min(Math.max(rect.height, 0), 1);
  return {
    x: Math.min(Math.max(rect.x, 0), 1 - width),
    y: Math.min(Math.max(rect.y, 0), 1 - height),
    width,
    height,
  };
}

/** Round a normalised rectangle to the precision the server stores. */
export const roundRect = (rect: NormalizedRect): NormalizedRect => ({
  x: Number(rect.x.toFixed(4)),
  y: Number(rect.y.toFixed(4)),
  width: Number(rect.width.toFixed(4)),
  height: Number(rect.height.toFixed(4)),
});

/** True when the point lies inside the rectangle. */
export const containsPoint = (rect: PixelRect, px: number, py: number): boolean =>
  px >= rect.x && px <= rect.x + rect.width && py >= rect.y && py <= rect.y + rect.height;

/**
 * Topmost region under the point.
 *
 * Later regions are drawn over earlier ones, so the search runs backwards to
 * match what the user sees.
 */
export function regionAtPoint(
  regions: Region[],
  px: number,
  py: number,
  canvasWidth: number,
  canvasHeight: number,
): Region | null {
  for (let i = regions.length - 1; i >= 0; i--) {
    const region = regions[i];
    if (region && containsPoint(regionToCanvas(region, canvasWidth, canvasHeight), px, py)) {
      return region;
    }
  }
  return null;
}

export const RESIZE_HANDLES = ['nw', 'ne', 'se', 'sw'] as const;
export type ResizeHandle = (typeof RESIZE_HANDLES)[number];

export const HANDLE_SIZE = 8;

/** Centre point of one resize handle, in canvas pixels. */
export function handleCenter(rect: PixelRect, handle: ResizeHandle): { x: number; y: number } {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  switch (handle) {
    case 'nw':
      return { x: rect.x, y: rect.y };
    case 'ne':
      return { x: right, y: rect.y };
    case 'se':
      return { x: right, y: bottom };
    case 'sw':
      return { x: rect.x, y: bottom };
  }
}

/** Which resize handle the point is on, if any. */
export function handleAtPoint(rect: PixelRect, px: number, py: number): ResizeHandle | null {
  // A slightly generous radius keeps the handles reachable with a mouse.
  const radius = HANDLE_SIZE;
  for (const handle of RESIZE_HANDLES) {
    const center = handleCenter(rect, handle);
    if (Math.abs(px - center.x) <= radius && Math.abs(py - center.y) <= radius) {
      return handle;
    }
  }
  return null;
}

/** Apply a resize drag to a rectangle by moving one corner. */
export function resizeRect(
  rect: PixelRect,
  handle: ResizeHandle,
  px: number,
  py: number,
): PixelRect {
  const left = rect.x;
  const top = rect.y;
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;

  switch (handle) {
    case 'nw':
      return rectFromPoints(px, py, right, bottom);
    case 'ne':
      return rectFromPoints(left, py, px, bottom);
    case 'se':
      return rectFromPoints(left, top, px, py);
    case 'sw':
      return rectFromPoints(px, top, right, py);
  }
}

/** Smallest rectangle worth keeping, in canvas pixels. */
export const MIN_DRAW_SIZE = 6;
