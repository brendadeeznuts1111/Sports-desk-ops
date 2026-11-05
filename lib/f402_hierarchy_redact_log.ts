/**
 * Redacting capture log lines (File I/O: `Bun.file().writer()`).
 */

import { redactUnknown } from "./f402_hierarchy_redact.ts";

export { redactUnknown };

let sink: Bun.FileSink | null = null;
let sinkPath: string | null = null;

function captureSink(path: string): Bun.FileSink {
  if (sink !== null && sinkPath === path) return sink;
  // `Bun.file(path).writer()` truncates; close the previous sink before switching paths so its
  // buffered bytes are flushed instead of being abandoned.
  if (sink !== null) sink.end();
  sink = Bun.file(path).writer();
  sinkPath = path;
  return sink;
}

export function logCaptureEvent(
  path: string | undefined,
  event: Record<string, unknown>,
): void {
  if (path === undefined || path === "") return;
  const line = `${JSON.stringify({ ts: Date.now(), ...(redactUnknown(event) as Record<string, unknown>) })}\n`;
  captureSink(path).write(line);
}

export function flushCaptureLog(): void {
  sink?.flush();
}
