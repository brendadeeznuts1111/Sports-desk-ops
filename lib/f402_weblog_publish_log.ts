/** Stderr line after R2 publish: names data window end, not publication time. */
const MS_PER_DAY = 86_400_000;

export function weblogPublishDataWindowLogLine(
  windowToMs: number,
  nowMs = Date.now(),
): string {
  const daysOld = Math.floor((nowMs - windowToMs) / MS_PER_DAY);
  return (
    `weblog: published rollup for data window ` +
    `${new Date(windowToMs).toISOString()} (${daysOld}d old)`
  );
}
