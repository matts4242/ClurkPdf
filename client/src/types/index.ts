/**
 * Client-side mirror of the server's API contract.
 *
 * Kept in sync by hand for Week 1; Week 2 moves these into a shared package
 * alongside the Prisma models.
 */

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}

/** `queued` only happens in a batch; a lone upload starts at `processing`. */
export type DocumentStatus = 'queued' | 'processing' | 'ready' | 'error';

export interface Document {
  id: string;
  filename: string;
  originalName: string;
  mimeType: string;
  size: number;
  pageCount: number;
  uploadPath: string;
  createdAt: string;
  status: DocumentStatus;
  thumbnailUrl?: string;
  errorMessage?: string;
  /** Set when the document was uploaded as part of a batch. */
  batchId?: string;
}

export type UploadStatus = 'idle' | 'uploading' | 'processing' | 'success' | 'error';

/** A document plus a summary of the regions drawn on it. */
export interface DocumentWithStats extends Document {
  regionCount: number;
  pagesWithRegions: number[];
}

export const FIELD_TYPES = [
  'VENDOR_NAME',
  'VENDOR_ADDRESS',
  'INVOICE_NUMBER',
  'INVOICE_DATE',
  'DUE_DATE',
  'PO_NUMBER',
  'SUBTOTAL',
  'TAX',
  'TOTAL',
  'LINE_ITEMS',
  'CUSTOM',
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** Human-readable names, and the colour each field type is drawn in. */
export const FIELD_TYPE_META: Record<FieldType, { label: string; color: string }> = {
  VENDOR_NAME: { label: 'Vendor name', color: '#0ea5e9' },
  VENDOR_ADDRESS: { label: 'Vendor address', color: '#06b6d4' },
  INVOICE_NUMBER: { label: 'Invoice number', color: '#8b5cf6' },
  INVOICE_DATE: { label: 'Invoice date', color: '#a855f7' },
  DUE_DATE: { label: 'Due date', color: '#d946ef' },
  PO_NUMBER: { label: 'PO number', color: '#f43f5e' },
  SUBTOTAL: { label: 'Subtotal', color: '#f59e0b' },
  TAX: { label: 'Tax', color: '#eab308' },
  TOTAL: { label: 'Total', color: '#16a34a' },
  LINE_ITEMS: { label: 'Line items', color: '#0d9488' },
  CUSTOM: { label: 'Custom', color: '#64748b' },
};

/** A rectangle in normalised 0-1 page coordinates. */
export interface NormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const OCR_STATUSES = ['PENDING', 'PROCESSING', 'DONE', 'ERROR'] as const;
export type OcrStatus = (typeof OCR_STATUSES)[number];

export const TEXT_SOURCES = ['NONE', 'OCR', 'TEXT_LAYER'] as const;
export type TextSource = (typeof TEXT_SOURCES)[number];

/** One positioned run of text from the PDF's own text layer. */
export interface TextItem {
  text: string;
  /** Normalised 0-1, y measured down from the top of the page. */
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

export interface TextLayerData {
  pageNumber: number;
  pageWidth: number;
  pageHeight: number;
  textItems: TextItem[];
  /** False for a scanned page, which has no text layer and needs OCR. */
  hasText: boolean;
}

export interface Region extends NormalizedRect {
  id: string;
  documentId: string;
  /** 1-indexed. */
  pageNumber: number;
  fieldType: FieldType;
  fieldLabel?: string;

  /** Where `rawText` came from. */
  textSource: TextSource;
  ocrStatus: OcrStatus;
  /** Text as OCR read it. A human edit never overwrites this. */
  rawText?: string;
  /** Human correction. When present, this is the value to trust. */
  correctedText?: string;
  /** Tesseract's own confidence, 0-100. */
  confidence?: number;
  ocrError?: string;
  ocrAt?: string;

  createdAt: string;
  updatedAt: string;
}

/** The value to use downstream: the human's correction if there is one. */
export const regionValue = (region: Region): string =>
  region.correctedText ?? region.rawText ?? '';

/**
 * Confidence banding from the specification: green above 90, amber 70-90,
 * red below 70.
 */
export function confidenceBand(confidence: number | undefined): {
  label: string;
  className: string;
} {
  if (confidence === undefined) return { label: '--', className: 'bg-slate-100 text-slate-500' };
  if (confidence > 90) return { label: `${Math.round(confidence)}%`, className: 'bg-emerald-100 text-emerald-700' };
  if (confidence >= 70) return { label: `${Math.round(confidence)}%`, className: 'bg-amber-100 text-amber-700' };
  return { label: `${Math.round(confidence)}%`, className: 'bg-rose-100 text-rose-700' };
}

export interface OcrRegionResult {
  regionId: string;
  status: OcrStatus;
  text?: string;
  confidence?: number;
  error?: string;
}

export interface RunOcrResponse {
  results: OcrRegionResult[];
  succeeded: number;
  failed: number;
}

export interface CreateRegionInput extends NormalizedRect {
  pageNumber: number;
  fieldType: FieldType;
  fieldLabel?: string;
  /** `TEXT_LAYER` asks the server to fill the text from the PDF itself. */
  textSource?: TextSource;
}

export type UpdateRegionInput = Partial<NormalizedRect> & {
  fieldType?: FieldType;
  fieldLabel?: string;
  correctedText?: string;
};

/** How pointer input on the page is interpreted. */
export type ViewerMode = 'pan' | 'draw' | 'select' | 'text';

/** Display name for a region, falling back to its field type. */
export const regionLabel = (region: Region): string =>
  region.fieldType === 'CUSTOM' && region.fieldLabel
    ? region.fieldLabel
    : FIELD_TYPE_META[region.fieldType].label;

// --- Week 5: batches -----------------------------------------------------

export interface BatchCounts {
  total: number;
  queued: number;
  processing: number;
  ready: number;
  error: number;
}

/** A set of documents uploaded together, with its documents. */
export interface Batch {
  id: string;
  name?: string;
  createdAt: string;
  documents: Document[];
  counts: BatchCounts;
}

/** A batch without its documents, for the list. */
export interface BatchSummary {
  id: string;
  name?: string;
  createdAt: string;
  counts: BatchCounts;
  thumbnailUrls: string[];
}

/** A file the server refused, reported alongside the batch it was meant for. */
export interface RejectedFile {
  filename: string;
  reason: string;
}

export interface CreateBatchResponse {
  batch: Batch;
  rejected: RejectedFile[];
}

/** What the server pushes over the WebSocket while a batch runs. */
export type BatchEvent =
  | { type: 'document'; batchId: string; document: Document }
  | { type: 'batch-complete'; batchId: string; counts: BatchCounts };

export const DOCUMENT_STATUS_META: Record<
  DocumentStatus,
  { label: string; badge: string }
> = {
  queued: { label: 'Queued', badge: 'bg-slate-100 text-slate-600' },
  processing: { label: 'Processing', badge: 'bg-amber-100 text-amber-700' },
  ready: { label: 'Ready', badge: 'bg-emerald-100 text-emerald-700' },
  error: { label: 'Failed', badge: 'bg-rose-100 text-rose-700' },
};
