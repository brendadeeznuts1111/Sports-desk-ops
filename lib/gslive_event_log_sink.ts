/**
 * @file gslive_event_log_sink.ts
 * @description R2 sink for GSLive `getEventLog` responses. Mirrors the tally / weblog pattern: all
 * per-event writes land first and are size-verified, only then does the index at
 * `gslive-event-logs/latest-index.json` advance. If any per-event write is short or missing, the
 * index is not touched — a reader that trusts the index can trust every key it names is fully
 * written.
 *
 * Each per-event key is `gslive-event-logs/<deskDate>/<betId>-<eventId>.json`. Identifiers are
 * validated against `[A-Za-z0-9._-]{1,128}` before any key is constructed to prevent path-traversal.
 * The sanitization guard rejects known identifier-shaped keys inside the payload; callers must
 * pre-sanitize before handing the entries in.
 *
 * Source labels on `x-amz-meta-source` distinguish the two write phases: `gslive-event-logs` for
 * each per-event entry, `gslive-event-logs-index` for the index.
 */

import { R2S3Client } from "./r2_s3_client.ts";

export const GSLIVE_EVENT_LOGS_PREFIX = "gslive-event-logs/";
export const GSLIVE_EVENT_LOGS_INDEX_KEY = `${GSLIVE_EVENT_LOGS_PREFIX}latest-index.json`;
export const GSLIVE_EVENT_LOGS_KIND = "gslive-event-logs";
export const GSLIVE_EVENT_LOGS_INDEX_SOURCE = `${GSLIVE_EVENT_LOGS_KIND}-index`;
export const GSLIVE_EVENT_LOGS_SCHEMA_VERSION = 1;
export const GSLIVE_EVENT_LOGS_INDEX_SCHEMA_VERSION = 1;
/** Soft ceiling per event entry; a single event log should be comfortably under 256 KiB. */
export const GSLIVE_EVENT_LOGS_MAX_ENTRY_BYTES = 256 * 1024;

const FORBIDDEN_KEYS =
  /^(betGroupId|ticketNumber|wagerNumber|login|agent|ipAddress|userID|partnerUserID|playerId)$/;

export interface GsliveEventLogEntry {
  readonly betId: string;
  readonly eventId: string;
  /** `logTime` echoed from the `getEventLog` form body; GSLive uses this as a cursor. */
  readonly logTime: string;
  /** JSON body already parsed from `fetchEventLog`. Must be caller-sanitized of PII. */
  readonly payload: unknown;
}

export interface GsliveEventLogsPublishInput {
  /** `YYYY-MM-DD` (America/Chicago), the desk date entries belong to. */
  readonly deskDate: string;
  /** Collection time, rendered into every write's `x-amz-meta-observed-at`. */
  readonly observedAtIso: string;
  readonly entries: readonly GsliveEventLogEntry[];
}

export interface GsliveEventLogsIndexEntry {
  readonly key: string;
  readonly betId: string;
  readonly eventId: string;
  readonly logTime: string;
  readonly observedAtIso: string;
}

export interface GsliveEventLogsIndex {
  readonly schemaVersion: typeof GSLIVE_EVENT_LOGS_INDEX_SCHEMA_VERSION;
  readonly deskDate: string;
  readonly generatedAtIso: string;
  readonly entries: readonly GsliveEventLogsIndexEntry[];
}

export interface GsliveEventLogsPublishResult {
  readonly indexKey: string;
  readonly entryKeys: readonly string[];
  readonly totalBytes: number;
  readonly publicIndexUrl: string;
}

function isSafeIdentifier(value: string): boolean {
  return (
    value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._-]+$/.test(value)
  );
}

function isSafeDeskDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * Validate the shape of the input and walk every entry payload for forbidden identifier-shaped
 * keys. Throws before any R2 call so a violation never leaks a byte.
 */
export function assertSanitizedGsliveEventLogs(
  input: GsliveEventLogsPublishInput,
): void {
  if (!isSafeDeskDate(input.deskDate)) {
    throw new Error(
      `gslive event logs: deskDate must be YYYY-MM-DD (got "${input.deskDate}")`,
    );
  }
  const walk = (value: unknown): void => {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry);
      return;
    }
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_KEYS.test(key)) {
        throw new Error(
          `gslive event logs: entry payload carries forbidden key "${key}"`,
        );
      }
      walk(child);
    }
  };
  for (const entry of input.entries) {
    if (!isSafeIdentifier(entry.betId)) {
      throw new Error(
        `gslive event logs: betId must match [A-Za-z0-9._-]{1,128} (got "${entry.betId}")`,
      );
    }
    if (!isSafeIdentifier(entry.eventId)) {
      throw new Error(
        `gslive event logs: eventId must match [A-Za-z0-9._-]{1,128} (got "${entry.eventId}")`,
      );
    }
    walk(entry.payload);
  }
}

/**
 * Publish every entry as an immutable per-event key, then publish the index last. Each per-event
 * write is size-verified against its stat before the index is touched; a short or missing write
 * aborts with no index update. Throws if R2 credentials are unavailable.
 */
export async function publishGsliveEventLogs(
  input: GsliveEventLogsPublishInput,
  options: { readonly r2Client?: R2S3Client | null } = {},
): Promise<GsliveEventLogsPublishResult> {
  assertSanitizedGsliveEventLogs(input);

  const client =
    options.r2Client === undefined
      ? await R2S3Client.fromEnvOrSecrets()
      : options.r2Client;
  if (client === null) throw new Error("R2 credentials are unavailable");

  const entryKeys: string[] = [];
  const indexEntries: GsliveEventLogsIndexEntry[] = [];
  let totalBytes = 0;

  for (const entry of input.entries) {
    const key = `${GSLIVE_EVENT_LOGS_PREFIX}${input.deskDate}/${entry.betId}-${entry.eventId}.json`;
    const payload = {
      schemaVersion: GSLIVE_EVENT_LOGS_SCHEMA_VERSION,
      deskDate: input.deskDate,
      observedAtIso: input.observedAtIso,
      betId: entry.betId,
      eventId: entry.eventId,
      logTime: entry.logTime,
      payload: entry.payload,
    };
    const body = new TextEncoder().encode(
      `${JSON.stringify(payload, null, 2)}\n`,
    );
    if (body.byteLength > GSLIVE_EVENT_LOGS_MAX_ENTRY_BYTES) {
      throw new Error(
        `gslive event logs: entry ${entry.betId}-${entry.eventId} exceeds ${GSLIVE_EVENT_LOGS_MAX_ENTRY_BYTES} bytes (${body.byteLength})`,
      );
    }
    await client.writeWithMetadata(key, body, {
      type: "application/json",
      metadata: {
        pii: "caller-sanitized",
        "schema-version": String(GSLIVE_EVENT_LOGS_SCHEMA_VERSION),
        "desk-date": input.deskDate,
        "observed-at": input.observedAtIso,
        "bet-id": entry.betId,
        "event-id": entry.eventId,
        "log-time": entry.logTime,
        source: GSLIVE_EVENT_LOGS_KIND,
      },
    });
    const entryStat = await client.stat(key);
    if (entryStat.size !== body.byteLength) {
      throw new Error(
        `gslive event logs: entry ${key} size mismatch: wrote ${body.byteLength}, stat ${entryStat.size}`,
      );
    }
    entryKeys.push(key);
    indexEntries.push({
      key,
      betId: entry.betId,
      eventId: entry.eventId,
      logTime: entry.logTime,
      observedAtIso: input.observedAtIso,
    });
    totalBytes += body.byteLength;
  }

  const index: GsliveEventLogsIndex = {
    schemaVersion: GSLIVE_EVENT_LOGS_INDEX_SCHEMA_VERSION,
    deskDate: input.deskDate,
    generatedAtIso: input.observedAtIso,
    entries: indexEntries,
  };
  await client.writeWithMetadata(
    GSLIVE_EVENT_LOGS_INDEX_KEY,
    new TextEncoder().encode(`${JSON.stringify(index, null, 2)}\n`),
    {
      type: "application/json",
      metadata: {
        pii: "none",
        "schema-version": String(GSLIVE_EVENT_LOGS_INDEX_SCHEMA_VERSION),
        "desk-date": input.deskDate,
        "generated-at": input.observedAtIso,
        "entry-count": String(indexEntries.length),
        source: GSLIVE_EVENT_LOGS_INDEX_SOURCE,
      },
    },
  );

  return {
    indexKey: GSLIVE_EVENT_LOGS_INDEX_KEY,
    entryKeys,
    totalBytes,
    publicIndexUrl: `${client.publicBase}/${GSLIVE_EVENT_LOGS_INDEX_KEY}`,
  };
}
