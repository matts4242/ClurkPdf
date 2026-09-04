/**
 * Shared API and domain types for the invoice processor server.
 *
 * The client mirrors these in `client/src/types/index.ts`. Keep the two in
 * sync; Week 2 introduces a shared package once Prisma models land.
 */

/** Every endpoint responds with this envelope, success or failure. */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export const ERROR_CODES = [
  'FILE_TOO_LARGE',
  'INVALID_FILE_TYPE',
  'NO_FILE_UPLOADED',
  'UPLOAD_FAILED',
  'INVALID_PDF',
  'INVALID_REQUEST',
  'DOCUMENT_NOT_FOUND',
  'PAGE_NOT_FOUND',
  'PROCESSING_ERROR',
  'FORBIDDEN',
  'ROUTE_NOT_FOUND',
  'INTERNAL_ERROR',
  // Week 2: regions
  'REGION_NOT_FOUND',
  'REGION_OUT_OF_BOUNDS',
  'INVALID_DIMENSIONS',
  'INVALID_PAGE',
  'INVALID_FIELD_TYPE',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export type DocumentStatus = 'uploaded' | 'processing' | 'ready' | 'error';

export interface Document {
  /** UUID v4. */
  id: string;
  /** Sanitized name as stored on disk. */
  filename: string;
  /** Name exactly as the browser reported it. */
  originalName: string;
  mimeType: string;
  /** Size in bytes. */
  size: number;
  pageCount: number;
  /** Path to the original PDF, relative to the uploads root. */
  uploadPath: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  status: DocumentStatus;
  /** URL of the page-1 preview image. Present once the page has rendered. */
  thumbnailUrl?: string;
  /** Populated when `status` is `error`. */
  errorMessage?: string;
}

/** A document plus a summary of the regions drawn on it. */
export interface DocumentWithStats extends Document {
  regionCount: number;
  /** Page numbers that have at least one region, ascending. */
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

export const isFieldType = (value: unknown): value is FieldType =>
  typeof value === 'string' && (FIELD_TYPES as readonly string[]).includes(value);

/**
 * A rectangular area of a page marked for extraction.
 *
 * Coordinates are normalised to 0-1 against the page, so a region drawn at one
 * zoom level or render resolution lands in the same place at any other.
 */
export interface Region {
  id: string;
  documentId: string;
  /** 1-indexed. */
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: FieldType;
  /** Only meaningful when `fieldType` is `CUSTOM`. */
  fieldLabel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateRegionRequest {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: FieldType;
  fieldLabel?: string;
}

export interface UpdateRegionRequest {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fieldType?: FieldType;
  fieldLabel?: string;
}

export interface ListRegionsResponse {
  regions: Region[];
  total: number;
}
