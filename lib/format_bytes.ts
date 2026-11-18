/**
 * @file lib/format_bytes.ts
 * @description One byte-count formatter for CLI cards and diagnostic JSON.
 */

/** Formats `1234` as `1.2 KiB`; negative or non-finite input falls back to the raw number. */
export function formatByteCount(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}
