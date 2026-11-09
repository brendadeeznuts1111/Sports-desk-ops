import {
  isoTime as isoDateTimeUtc,
  type IsoTime as IsoDateTimeUtc,
} from "./brand.ts";

/** Append-only batch marker (CLI may override with --run-id). */
export type AuditRunId = string & { readonly __auditRunId: unique symbol };

export function auditRunId(value: string = Bun.randomUUIDv7()): AuditRunId {
  return value as AuditRunId;
}

export type { IsoDateTimeUtc };

/** Validated tx_time / run_at for append-only SQLite rows. */
export function auditRunAt(
  value: string = new Date().toISOString(),
): IsoDateTimeUtc {
  return isoDateTimeUtc(value);
}
