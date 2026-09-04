import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RotateCw,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { ApiRequestError, absoluteUrl, fetchDocument, pageImageUrl } from '../api/client';
import type { Document } from '../types';
import { formatBytes, formatPageCount, formatTimestamp } from '../utils/format';

export interface DocumentViewerProps {
  documentId: string;
  onError?: (error: Error) => void;
  onPageChange?: (pageNumber: number) => void;
}

const ZOOM_LEVELS = [0.5, 1, 1.5, 2, 3, 4] as const;
const DEFAULT_ZOOM_INDEX = 1;

/**
 * Resolution the server renders page images at, and the browser's own notion
 * of an inch. Dividing one by the other converts the bitmap to CSS pixels, so
 * 100% zoom shows the page at its true physical size instead of whatever the
 * bitmap's intrinsic width happens to be.
 *
 * This must match PAGE_DPI on the server; override both together via
 * VITE_PAGE_DPI if you change the server's setting.
 */
const SERVER_RENDER_DPI = Number(import.meta.env.VITE_PAGE_DPI ?? 150) || 150;
const CSS_DPI = 96;

/**
 * Renders one page of a document as an image, with zoom, drag-to-pan, and a
 * metadata sidebar.
 *
 * Week 2 mounts the region-drawing canvas over the same image, so the page
 * image is kept in a positioned wrapper sized to the rendered bitmap.
 */
export function DocumentViewer({ documentId, onError, onPageChange }: DocumentViewerProps) {
  const [document, setDocument] = useState<Document | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [zoomIndex, setZoomIndex] = useState<number>(DEFAULT_ZOOM_INDEX);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);
  const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  const panRef = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const zoom = ZOOM_LEVELS[zoomIndex] ?? 1;

  // Load metadata whenever the selected document changes.
  useEffect(() => {
    const controller = new AbortController();
    setDocument(null);
    setLoadError(null);
    setPageNumber(1);

    fetchDocument(documentId, controller.signal)
      .then(setDocument)
      .catch((error: unknown) => {
        if (error instanceof ApiRequestError && error.code === 'CANCELLED') return;
        const message =
          error instanceof Error ? error.message : 'Could not load this document.';
        setLoadError(message);
        onErrorRef.current?.(error instanceof Error ? error : new Error(message));
      });

    return () => controller.abort();
  }, [documentId, reloadToken]);

  useEffect(() => {
    setImageLoading(true);
    setImageError(false);
    setNaturalWidth(null);
  }, [documentId, pageNumber, reloadToken]);

  const goToPage = useCallback(
    (next: number) => {
      if (!document) return;
      const clamped = Math.min(Math.max(1, next), document.pageCount);
      setPageNumber(clamped);
      onPageChange?.(clamped);
    },
    [document, onPageChange],
  );

  // Drag to pan, but only when the image overflows its container.
  const startPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    if (!container) return;
    if (
      container.scrollWidth <= container.clientWidth &&
      container.scrollHeight <= container.clientHeight
    ) {
      return;
    }
    panRef.current = {
      x: event.clientX,
      y: event.clientY,
      left: container.scrollLeft,
      top: container.scrollTop,
    };
    container.setPointerCapture(event.pointerId);
  }, []);

  const movePan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const container = scrollRef.current;
    const origin = panRef.current;
    if (!container || !origin) return;
    container.scrollLeft = origin.left - (event.clientX - origin.x);
    container.scrollTop = origin.top - (event.clientY - origin.y);
  }, []);

  const endPan = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    panRef.current = null;
    scrollRef.current?.releasePointerCapture(event.pointerId);
  }, []);

  if (loadError !== null) {
    return (
      <Panel>
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <AlertCircle className="h-8 w-8 text-rose-500" aria-hidden="true" />
          <p className="text-sm text-slate-600">{loadError}</p>
          <button
            type="button"
            onClick={() => setReloadToken((token) => token + 1)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
          >
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" />
            Try again
          </button>
        </div>
      </Panel>
    );
  }

  if (!document) {
    return (
      <Panel>
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading document...
        </div>
      </Panel>
    );
  }

  return (
    <Panel>
      <header className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-800">
          {document.originalName}
        </h2>

        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
          <IconButton
            label="Previous page"
            onClick={() => goToPage(pageNumber - 1)}
            disabled={pageNumber <= 1}
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <span className="px-2 text-xs tabular-nums text-slate-600">
            {pageNumber} / {document.pageCount}
          </span>
          <IconButton
            label="Next page"
            onClick={() => goToPage(pageNumber + 1)}
            disabled={pageNumber >= document.pageCount}
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>

        <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-0.5">
          <IconButton
            label="Zoom out"
            onClick={() => setZoomIndex((index) => Math.max(0, index - 1))}
            disabled={zoomIndex === 0}
          >
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </IconButton>
          <button
            type="button"
            onClick={() => setZoomIndex(DEFAULT_ZOOM_INDEX)}
            className="min-w-14 px-2 text-xs tabular-nums text-slate-600 hover:text-slate-900"
            aria-label="Reset zoom to 100%"
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton
            label="Zoom in"
            onClick={() => setZoomIndex((index) => Math.min(ZOOM_LEVELS.length - 1, index + 1))}
            disabled={zoomIndex === ZOOM_LEVELS.length - 1}
          >
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* min-w-0 lets this pane shrink below the page image's width, so a
            zoomed page scrolls inside it instead of shoving the sidebar out. */}
        <div
          ref={scrollRef}
          onPointerDown={startPan}
          onPointerMove={movePan}
          onPointerUp={endPan}
          onPointerCancel={endPan}
          className="relative min-h-96 min-w-0 flex-1 overflow-auto bg-slate-200 p-4 select-none touch-none"
        >
          {imageLoading && !imageError && (
            <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-slate-500">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Rendering page {pageNumber}...
            </div>
          )}

          {imageError ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <AlertCircle className="h-7 w-7 text-rose-500" aria-hidden="true" />
              <p className="text-sm text-slate-600">Page {pageNumber} could not be rendered.</p>
              <button
                type="button"
                onClick={() => setReloadToken((token) => token + 1)}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
              >
                Try again
              </button>
            </div>
          ) : (
            <div className="mx-auto w-fit">
              <img
                key={`${documentId}-${pageNumber}-${reloadToken}`}
                src={pageImageUrl(documentId, pageNumber)}
                alt={`Page ${pageNumber} of ${document.originalName}`}
                draggable={false}
                onLoad={(event) => {
                  setNaturalWidth(event.currentTarget.naturalWidth);
                  setImageLoading(false);
                }}
                onError={() => {
                  setImageLoading(false);
                  setImageError(true);
                }}
                style={
                  naturalWidth === null
                    ? { maxWidth: 'none' }
                    : {
                        width: `${(naturalWidth * CSS_DPI * zoom) / SERVER_RENDER_DPI}px`,
                        maxWidth: 'none',
                      }
                }
                className="block rounded shadow-lg"
              />
            </div>
          )}
        </div>

        <aside className="shrink-0 border-t border-slate-200 p-4 lg:w-64 lg:border-t-0 lg:border-l">
          {document.thumbnailUrl !== undefined && (
            <img
              src={absoluteUrl(document.thumbnailUrl)}
              alt=""
              className="mb-4 w-full rounded border border-slate-200 bg-white"
            />
          )}
          <dl className="space-y-2.5 text-xs">
            <Field label="Filename" value={document.originalName} />
            <Field label="Size" value={formatBytes(document.size)} />
            <Field label="Pages" value={formatPageCount(document.pageCount)} />
            <Field label="Uploaded" value={formatTimestamp(document.createdAt)} />
            <Field label="Status" value={document.status} />
          </dl>
        </aside>
      </div>
    </Panel>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white">
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] font-medium tracking-wide text-slate-400 uppercase">{label}</dt>
      <dd className="mt-0.5 break-words text-slate-700">{value}</dd>
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="rounded-md p-1.5 text-slate-600 hover:bg-white hover:text-slate-900 disabled:pointer-events-none disabled:opacity-40"
    >
      {children}
    </button>
  );
}
