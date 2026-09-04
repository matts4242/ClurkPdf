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

export type DocumentStatus = 'uploaded' | 'processing' | 'ready' | 'error';

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

export interface Region extends NormalizedRect {
  id: string;
  documentId: string;
  /** 1-indexed. */
  pageNumber: number;
  fieldType: FieldType;
  fieldLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRegionInput extends NormalizedRect {
  pageNumber: number;
  fieldType: FieldType;
  fieldLabel?: string;
}

export type UpdateRegionInput = Partial<NormalizedRect> & {
  fieldType?: FieldType;
  fieldLabel?: string;
};

/** How pointer input on the page is interpreted. */
export type ViewerMode = 'pan' | 'draw' | 'select';

/** Display name for a region, falling back to its field type. */
export const regionLabel = (region: Region): string =>
  region.fieldType === 'CUSTOM' && region.fieldLabel
    ? region.fieldLabel
    : FIELD_TYPE_META[region.fieldType].label;
