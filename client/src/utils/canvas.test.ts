import { describe, expect, it } from 'vitest';
import {
  canvasToRegion,
  clampToPage,
  containsPoint,
  handleAtPoint,
  normalizedToScreen,
  rectFromPoints,
  regionAtPoint,
  regionToCanvas,
  resizeRect,
  roundRect,
  screenToNormalized,
} from './canvas';
import type { Region } from '../types';

const region = (over: Partial<Region> = {}): Region => ({
  id: 'r1',
  documentId: 'd1',
  pageNumber: 1,
  x: 0.1,
  y: 0.2,
  width: 0.3,
  height: 0.1,
  fieldType: 'TOTAL',
  ocrStatus: 'PENDING',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('coordinate conversion', () => {
  it('round-trips a point through normalisation', () => {
    const normalized = screenToNormalized(200, 150, 800, 600);
    expect(normalized).toEqual({ x: 0.25, y: 0.25 });

    const back = normalizedToScreen(normalized.x, normalized.y, 800, 600);
    expect(back).toEqual({ x: 200, y: 150 });
  });

  it('round-trips a rectangle through the canvas and back', () => {
    const original = region();
    const asPixels = regionToCanvas(original, 800, 1000);
    expect(asPixels).toEqual({ x: 80, y: 200, width: 240, height: 100 });

    const back = canvasToRegion(asPixels, 800, 1000);
    expect(back).toEqual({ x: 0.1, y: 0.2, width: 0.3, height: 0.1 });
  });

  /**
   * The reason regions are stored normalised: the same region must cover the
   * same part of the page at any zoom level.
   */
  it('keeps a region on the same content across zoom levels', () => {
    const stored = region();
    const baseWidth = 816;
    const baseHeight = 1056;

    for (const zoom of [0.5, 1, 1.5, 2, 4]) {
      const canvasWidth = baseWidth * zoom;
      const canvasHeight = baseHeight * zoom;
      const pixels = regionToCanvas(stored, canvasWidth, canvasHeight);

      // Position as a fraction of the page is invariant.
      expect(pixels.x / canvasWidth).toBeCloseTo(stored.x, 10);
      expect(pixels.y / canvasHeight).toBeCloseTo(stored.y, 10);
      expect(pixels.width / canvasWidth).toBeCloseTo(stored.width, 10);

      // And converting back recovers the stored rectangle exactly.
      const back = canvasToRegion(pixels, canvasWidth, canvasHeight);
      expect(back.x).toBeCloseTo(stored.x, 10);
      expect(back.width).toBeCloseTo(stored.width, 10);
    }
  });

  it('does not divide by zero before the page image has measured', () => {
    expect(screenToNormalized(10, 10, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(canvasToRegion({ x: 1, y: 1, width: 1, height: 1 }, 0, 0)).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});

describe('rectFromPoints', () => {
  it('normalises a drag in any direction to a positive rectangle', () => {
    const downRight = rectFromPoints(10, 20, 110, 70);
    const upLeft = rectFromPoints(110, 70, 10, 20);

    expect(downRight).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(upLeft).toEqual(downRight);
  });
});

describe('clampToPage', () => {
  it('pulls a rectangle back inside the page', () => {
    expect(clampToPage({ x: 0.9, y: 0.1, width: 0.3, height: 0.1 })).toEqual({
      x: 0.7,
      y: 0.1,
      width: 0.3,
      height: 0.1,
    });
    expect(clampToPage({ x: -0.2, y: -0.5, width: 0.2, height: 0.2 })).toEqual({
      x: 0,
      y: 0,
      width: 0.2,
      height: 0.2,
    });
  });

  it('leaves a rectangle that already fits alone', () => {
    const fits = { x: 0.2, y: 0.3, width: 0.4, height: 0.2 };
    expect(clampToPage(fits)).toEqual(fits);
  });

  it('produces a rectangle the server will accept', () => {
    // The server rejects anything where x + width exceeds 1.
    for (const candidate of [
      { x: 0.99, y: 0.99, width: 0.5, height: 0.5 },
      { x: -1, y: 2, width: 3, height: 0.1 },
    ]) {
      const clamped = clampToPage(candidate);
      expect(clamped.x).toBeGreaterThanOrEqual(0);
      expect(clamped.y).toBeGreaterThanOrEqual(0);
      expect(clamped.x + clamped.width).toBeLessThanOrEqual(1);
      expect(clamped.y + clamped.height).toBeLessThanOrEqual(1);
    }
  });
});

describe('roundRect', () => {
  it('rounds to the four decimals the server stores', () => {
    expect(roundRect({ x: 0.123456, y: 0.98765, width: 0.5, height: 0.333333 })).toEqual({
      x: 0.1235,
      y: 0.9877,
      width: 0.5,
      height: 0.3333,
    });
  });
});

describe('hit testing', () => {
  const rect = { x: 100, y: 100, width: 200, height: 50 };

  it('detects points inside and outside', () => {
    expect(containsPoint(rect, 150, 120)).toBe(true);
    expect(containsPoint(rect, 100, 100)).toBe(true);
    expect(containsPoint(rect, 99, 120)).toBe(false);
    expect(containsPoint(rect, 150, 151)).toBe(false);
  });

  it('picks the topmost region when they overlap', () => {
    const lower = region({ id: 'lower', x: 0, y: 0, width: 0.5, height: 0.5 });
    const upper = region({ id: 'upper', x: 0.1, y: 0.1, width: 0.2, height: 0.2 });

    const hit = regionAtPoint([lower, upper], 150, 150, 1000, 1000);
    expect(hit?.id).toBe('upper');
  });

  it('returns null when nothing is under the point', () => {
    expect(regionAtPoint([region()], 5, 5, 1000, 1000)).toBeNull();
  });

  it('finds resize handles at the corners', () => {
    expect(handleAtPoint(rect, 100, 100)).toBe('nw');
    expect(handleAtPoint(rect, 300, 100)).toBe('ne');
    expect(handleAtPoint(rect, 300, 150)).toBe('se');
    expect(handleAtPoint(rect, 100, 150)).toBe('sw');
    expect(handleAtPoint(rect, 200, 125)).toBeNull();
  });
});

describe('resizeRect', () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it('moves the dragged corner and leaves the opposite one fixed', () => {
    expect(resizeRect(rect, 'se', 400, 250)).toEqual({
      x: 100,
      y: 100,
      width: 300,
      height: 150,
    });
    expect(resizeRect(rect, 'nw', 50, 50)).toEqual({
      x: 50,
      y: 50,
      width: 250,
      height: 150,
    });
  });

  it('stays positive when a corner is dragged past its opposite', () => {
    const inverted = resizeRect(rect, 'se', 50, 40);
    expect(inverted.width).toBeGreaterThan(0);
    expect(inverted.height).toBeGreaterThan(0);
    expect(inverted).toEqual({ x: 50, y: 40, width: 50, height: 60 });
  });
});
