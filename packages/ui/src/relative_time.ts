/**
 * @file relative_time.ts
 * @description One compact relative-age formatter for every "how old is this?"
 * label on the dashboard (feed freshness, alert audit rows).
 */

/**
 * Compact age for a timestamp, or `null` when there is no usable value.
 * Sub-second and clock-skewed (future) values read as `just now` rather than
 * negative seconds.
 */
export function formatRelativeAge(
  nowMs: number,
  atMs: number | null,
): string | null {
  if (atMs === null || !Number.isFinite(atMs)) return null;
  const deltaMs = nowMs - atMs;
  if (!Number.isFinite(deltaMs) || deltaMs < 1_000) return "just now";
  const seconds = Math.floor(deltaMs / 1_000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
