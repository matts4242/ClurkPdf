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

  /** Where `rawText` came from. */
  textSource: TextSource;
  /** Week 3: OCR. */
  ocrStatus: OcrStatus;
  /** Text as OCR read it. A human edit never overwrites this. */
  rawText?: string;
  /** Human correction. When present, this is the value to trust. */
  correctedText?: string;
  /** Tesseract's own confidence, 0-100. */
  confidence?: number;
  /** Why the last attempt failed, when `ocrStatus` is `ERROR`. */
  ocrError?: string;
  ocrAt?: string;

  createdAt: string;
  updatedAt: string;
}

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

export const isTextSource = (value: unknown): value is TextSource =>
  typeof value === 'string' && (TEXT_SOURCES as readonly string[]).includes(value);

/** One positioned run of text from the PDF's own text layer. */
export interface TextItem {
  text: string;
  /** Normalised 0-1, y measured down from the top of the page. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Font height in PDF points, useful for styling the overlay. */
  fontSize: number;
}

export interface TextLayer {
  pageNumber: number;
  /** Page size in PDF points, for reference. */
  pageWidth: number;
  pageHeight: number;
  textItems: TextItem[];
  /** False for a scanned page, which has no text layer and needs OCR. */
  hasText: boolean;
}

/** One region's outcome from an OCR run. */
export interface OcrRegionResult {
  regionId: string;
  status: OcrStatus;
  text?: string;
  confidence?: number;
  error?: string;
}

export interface RunOcrResponse {
  results: OcrRegionResult[];
  /** How many regions were recognised, and how many failed. */
  succeeded: number;
  failed: number;
}

export interface CreateRegionRequest {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: FieldType;
  fieldLabel?: string;
  /**
   * `TEXT_LAYER` fills the region's text from the PDF's own text layer at
   * creation time, which is what the highlight mode uses. Anything else leaves
   * the region unread until OCR runs.
   */
  textSource?: TextSource;
}

export interface UpdateRegionRequest {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fieldType?: FieldType;
  fieldLabel?: string;
  /** Human correction of the OCR text. Pass an empty string to clear it. */
  correctedText?: string;
}

export interface ListRegionsResponse {
  regions: Region[];
  total: number;
}
