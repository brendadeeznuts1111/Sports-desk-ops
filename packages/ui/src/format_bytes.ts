/**
 * @file packages/ui/src/format_bytes.ts
 * @description Byte-size formatting shared by dashboard panels.
 */

/** 1024-based units (`KiB`/`MiB`) for asset and payload sizes. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * Decimal-labelled units (`KB`/`MB`) retained for the R2 panel's existing copy and tests.
 * This is not SI (the divisor is still 1024); it preserves the shipped labels.
 */
export function formatBytesDecimal(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
