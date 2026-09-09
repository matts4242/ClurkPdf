import { useCallback, useEffect, useRef, useState } from 'react';
import type { NormalizedRect, TextItem } from '../types';

export interface TextSelection {
  text: string;
  /** Bounding box of the selection, normalised against the page. */
  rect: NormalizedRect;
  /** Where to anchor the toolbar, in layer pixels. */
  anchor: { x: number; y: number };
}

export interface TextLayerProps {
  textItems: TextItem[];
  /** Displayed size of the page image, in CSS pixels. */
  width: number;
  height: number;
  onSelect: (selection: TextSelection | null) => void;
}

/**
 * Invisible, selectable copy of the page's own text, laid over the image.
 *
 * Each run is positioned where pdf.js says it sits and made transparent, so the
 * user selects real text with the native caret — which brings double-click for
 * a word and triple-click for a line along for free, rather than needing
 * bespoke snapping. Selection geometry is read back from the browser's own
 * client rects, so it stays exact regardless of how the glyphs are rendered.
 */
export function TextLayer({ textItems, width, height, onSelect }: TextLayerProps) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const readSelection = useCallback(() => {
    const layer = layerRef.current;
    if (!layer) return;

    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? '';
    if (!selection || selection.rangeCount === 0 || text === '') {
      onSelect(null);
      return;
    }

    const range = selection.getRangeAt(0);
    // Ignore selections that began outside this layer.
    if (!layer.contains(range.commonAncestorContainer)) {
      onSelect(null);
      return;
    }

    const layerBox = layer.getBoundingClientRect();
    const rects = [...range.getClientRects()].filter(
      (rect) => rect.width > 0 && rect.height > 0,
    );
    if (rects.length === 0) {
      onSelect(null);
      return;
    }

    const left = Math.min(...rects.map((rect) => rect.left)) - layerBox.left;
    const top = Math.min(...rects.map((rect) => rect.top)) - layerBox.top;
    const right = Math.max(...rects.map((rect) => rect.right)) - layerBox.left;
    const bottom = Math.max(...rects.map((rect) => rect.bottom)) - layerBox.top;

    // A couple of pixels of padding keeps descenders and the last glyph inside
    // the box, which matters because the server re-reads the text from it.
    const pad = 2;
    const x = clamp((left - pad) / width);
    const y = clamp((top - pad) / height);

    onSelect({
      text,
      rect: {
        x,
        y,
        width: clamp((right - left + pad * 2) / width, 1 - x),
        height: clamp((bottom - top + pad * 2) / height, 1 - y),
      },
      anchor: { x: (left + right) / 2, y: top },
    });
  }, [width, height, onSelect]);

  // Clear the toolbar when the selection is dropped elsewhere on the page.
  useEffect(() => {
    const onSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) onSelect(null);
    };
    document.addEventListener('selectionchange', onSelectionChange);
    return () => document.removeEventListener('selectionchange', onSelectionChange);
  }, [onSelect]);

  return (
    <div
      ref={layerRef}
      onMouseUp={readSelection}
      onKeyUp={readSelection}
      style={{ width: `${width}px`, height: `${height}px` }}
      className="absolute inset-0 cursor-text select-text"
      // The overlay is decorative scaffolding for selection; the real content
      // is the page image beneath it.
      aria-hidden="true"
    >
      {textItems.map((item, index) => (
        <span
          key={`${index}-${item.x}-${item.y}`}
          onMouseEnter={() => setActiveIndex(index)}
          onMouseLeave={() => setActiveIndex(null)}
          style={{
            position: 'absolute',
            left: `${item.x * width}px`,
            top: `${item.y * height}px`,
            width: `${item.width * width}px`,
            height: `${item.height * height}px`,
            // Size the glyphs to the run's own box so the invisible text lands
            // under the visible ink and selection rects line up with it.
            fontSize: `${item.height * height}px`,
            lineHeight: `${item.height * height}px`,
            fontFamily: 'sans-serif',
            whiteSpace: 'pre',
            transformOrigin: '0 0',
            color: 'transparent',
            // A faint tint on hover shows the text layer is live without
            // obscuring the page.
            backgroundColor: activeIndex === index ? 'rgba(14,165,233,0.10)' : 'transparent',
          }}
        >
          {item.text}
        </span>
      ))}
    </div>
  );
}

/** Keep a normalised value inside the page, optionally below a ceiling. */
function clamp(value: number, max = 1): number {
  return Math.max(0, Math.min(value, max));
}
