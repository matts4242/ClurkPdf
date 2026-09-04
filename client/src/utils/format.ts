/** Human-readable byte size, e.g. `2.4 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '--';
  if (bytes < 1024) return `${bytes} B`;

  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  // Keep one decimal below 100 so a 10.5MB file reads as visibly over a 10MB
  // limit, but drop a trailing `.0` so round numbers stay clean.
  const rounded = value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
  return `${rounded} ${units[unitIndex]}`;
}

/** Local date and time, e.g. `4 Sep 2026, 14:03`. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--';
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** `1 page` / `12 pages`. */
export const formatPageCount = (count: number): string =>
  `${count} ${count === 1 ? 'page' : 'pages'}`;
