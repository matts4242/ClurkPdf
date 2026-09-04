import path from 'node:path';
import { invalidRequest } from './errors.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID_V4.test(value);

/**
 * Express types a route parameter as `string | string[]` because a pattern can
 * repeat. Ours never do, so collapse anything else to the empty string and let
 * the validators below reject it.
 */
type RouteParam = string | string[] | undefined;

const single = (value: RouteParam): string => (typeof value === 'string' ? value : '');

/** Throws INVALID_REQUEST unless `value` is a UUID v4. */
export function assertUuid(value: RouteParam, field = 'id'): string {
  const id = single(value);
  if (!isUuid(id)) {
    throw invalidRequest(`${field} must be a UUID v4`, { [field]: id });
  }
  return id;
}

/** Throws INVALID_REQUEST unless `value` is a 1-indexed page number. */
export function parsePageNumber(value: RouteParam): number {
  const raw = single(value);
  const pageNumber = Number(raw);
  if (raw === '' || !Number.isInteger(pageNumber) || pageNumber < 1) {
    throw invalidRequest('pageNumber must be a positive integer', { pageNumber: raw });
  }
  return pageNumber;
}

/**
 * Reduce a browser-supplied filename to something safe to write to disk.
 *
 * Directory components are dropped first, then every character outside a
 * conservative alphabet becomes an underscore. That disposes of control
 * characters, spaces, and shell metacharacters in one pass, so
 * `../../etc/passwd` becomes `passwd` and can never escape the uploads root.
 */
export function sanitizeFilename(original: string, fallback = 'document.pdf'): string {
  const base = path.basename(original.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200);
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Resolve `segments` under `root` and confirm the result stays inside it.
 *
 * Defence in depth: every path built from request input goes through here.
 */
export function resolveWithin(root: string, ...segments: string[]): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, ...segments);
  const prefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (target !== resolvedRoot && !target.startsWith(prefix)) {
    throw invalidRequest('Resolved path escapes its root directory');
  }
  return target;
}
