import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository path of the server package, whether running from src/ or dist/. */
export const SERVER_ROOT = path.resolve(here, '..');

// Load server/.env before anything reads process.env. Node 22.13+ does this
// natively, so dotenv is not needed. Real environment variables already set
// take precedence, which is what CI and production rely on.
const envFile = path.resolve(SERVER_ROOT, '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const config = {
  port: int(process.env.PORT, 3001),

  /** PostgreSQL connection string. Required; the server refuses to start without it. */
  databaseUrl: process.env.DATABASE_URL ?? '',

  /** Maximum connections in the pg pool. */
  databasePoolSize: int(process.env.DATABASE_POOL_SIZE, 10),

  /** Absolute path of the uploads root. */
  uploadsDir: path.resolve(SERVER_ROOT, process.env.UPLOADS_DIR ?? 'uploads'),

  /** Hard ceiling enforced by multer, in bytes. */
  maxFileSize: int(process.env.MAX_FILE_SIZE, 10 * 1024 * 1024),

  /** Browser origins allowed to call the API. */
  allowedOrigins: (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  /** Render resolution for full page images. The spec floor is 150. */
  pageDpi: int(process.env.PAGE_DPI, 150),

  /** Width in pixels of the page-1 preview generated on upload. */
  thumbnailWidth: int(process.env.THUMBNAIL_WIDTH, 150),

  /** How long browsers may cache rendered page images. */
  imageCacheSeconds: int(process.env.IMAGE_CACHE_SECONDS, 60 * 60 * 24),

  /** Tesseract language, e.g. `eng` or `eng+deu`. */
  ocrLanguage: process.env.OCR_LANGUAGE ?? 'eng',

  /**
   * Where Tesseract keeps its downloaded language data. Without this it writes
   * a 5MB file into the process's working directory.
   */
  ocrCacheDir: path.resolve(SERVER_ROOT, process.env.OCR_CACHE_DIR ?? '.tesseract-cache'),

  /** How many regions are recognised at once. Each worker is a WASM instance. */
  ocrConcurrency: int(process.env.OCR_CONCURRENCY, 2),

  /** Give up on a single region after this long. */
  ocrTimeoutMs: int(process.env.OCR_TIMEOUT_MS, 30_000),

  /**
   * Crops narrower than this are upscaled before recognition. Tesseract is
   * tuned for roughly 300dpi and pages render at PAGE_DPI (150 by default), so
   * a small field would otherwise arrive at half the resolution it wants.
   */
  ocrMinCropWidth: int(process.env.OCR_MIN_CROP_WIDTH, 1000),

  isProduction: process.env.NODE_ENV === 'production',

  /** Suppresses request logging so the test output stays readable. */
  isTest: process.env.NODE_ENV === 'test' || process.env.VITEST === 'true',
} as const;

export const ACCEPTED_MIME_TYPES = ['application/pdf'] as const;
