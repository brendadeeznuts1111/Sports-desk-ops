/**
 * @file lib/live_provenance.ts
 * @description Persists one live-read artifact and its provenance: an atomic artifact write plus
 * a merged record in `data/capture-health.json`.
 *
 * A live read can serve from memory, but the desk also keeps the artifact on disk so a restart, a
 * cron, or a downstream tool sees the same bytes the response carried. Writing on every poll
 * would churn a file for nothing, so a snapshot whose SHA-256 is unchanged is throttled until the
 * interval lapses; a changed body always writes.
 *
 * The artifact text is written exactly as the caller built it (the builder already stripped PII),
 * and nothing here logs or records a customer id, a cookie or a response body. The health record
 * carries only the operation, transport, byte count and hashes, which is the same PII-free shape
 * `lib/live_capture.ts` records for a capture run.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  mergeCaptureHealth,
  readCaptureHealth,
  writeCaptureHealth,
  type LiveCaptureRecord,
} from "./live_capture.ts";

/** One artifact to persist, plus the provenance the health snapshot records for it. */
export interface LiveArtifactSnapshot {
  /** Health source key, e.g. `getBetTicker` / `Pending`. */
  readonly source: string;
  /** Wire operation the live read called, e.g. `/cloud/api/Report/Pending`. */
  readonly operation: string;
  /** Repo-relative artifact path, e.g. `data/live-wagers.json`. */
  readonly artifactPath: string;
  /** Exact bytes to persist (the caller serialized the artifact). */
  readonly artifactText: string;
  readonly observedAt: string;
  readonly transport: string | null;
  readonly httpStatus: number | null;
  readonly rows: number;
  readonly partial: boolean;
}

/** What the last write of one artifact left behind, so a caller can throttle the next one. */
export interface LivePersistState {
  readonly artifactPath: string;
  /** Epoch milliseconds of the write that produced `sha256`. */
  readonly at: number;
  /** SHA-256 of the artifact text that was written. */
  readonly sha256: string;
}

export interface PersistLiveOptions {
  /** Repo root (`data/` lives under it). */
  readonly rootDir: string;
  /** Health snapshot path, absolute or repo-relative; default `data/capture-health.json`. */
  readonly healthPath?: string;
  readonly snapshot: LiveArtifactSnapshot;
  /** Clock seam; defaults to `new Date()`. */
  readonly now?: Date;
  /** Minimum interval between unchanged rewrites, ms; default 60000, `0` always writes. */
  readonly throttleMs?: number;
  /** Previous write state for this artifact; omit on first write. */
  readonly previous?: LivePersistState | null;
}

export type PersistLiveOutcome =
  | {
      readonly wrote: false;
      readonly reason: "throttled";
      readonly state: LivePersistState;
    }
  | {
      readonly wrote: true;
      readonly state: LivePersistState;
      readonly healthPath: string;
      readonly artifactSha256: string;
    };

const DEFAULT_HEALTH_PATH = "data/capture-health.json";
const DEFAULT_THROTTLE_MS = 60_000;

function sha256Hex(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** NaN-safe: an absent/non-finite throttle takes the default, a negative one means "always". */
function resolveThrottleMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value))
    return DEFAULT_THROTTLE_MS;
  return Math.max(0, Math.trunc(value));
}

/**
 * Writes `text` to `path` through a sibling temp file and one rename, so a reader never sees a
 * half-written artifact and a concurrent read of the old bytes still wins or loses atomically.
 */
async function writeArtifactAtomic(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  try {
    await Bun.write(temporary, text);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/**
 * Persists a live snapshot, unless the same bytes were written recently.
 *
 * A write is skipped only when the previous state names the same artifact, carries the same
 * SHA-256, and the throttle interval has not elapsed. Everything else (a first write, changed
 * bytes, elapsed interval, `throttleMs: 0`) writes the artifact and merges one
 * `provenanceClass: "api"` record into the capture-health snapshot. Returns the write state
 * either way so the caller can pass it back as `previous`.
 */
export async function persistLiveSnapshot(
  options: PersistLiveOptions,
): Promise<PersistLiveOutcome> {
  const { snapshot } = options;
  const now = options.now ?? new Date();
  const at = now.getTime();
  const throttleMs = resolveThrottleMs(options.throttleMs);
  const artifactSha256 = sha256Hex(snapshot.artifactText);
  const previous = options.previous ?? null;

  if (
    previous !== null &&
    previous.artifactPath === snapshot.artifactPath &&
    previous.sha256 === artifactSha256 &&
    throttleMs > 0 &&
    at - previous.at < throttleMs
  ) {
    return { wrote: false, reason: "throttled", state: previous };
  }

  const artifactPath = resolve(options.rootDir, snapshot.artifactPath);
  const healthPath = resolve(
    options.rootDir,
    options.healthPath ?? DEFAULT_HEALTH_PATH,
  );
  await writeArtifactAtomic(artifactPath, snapshot.artifactText);

  const transport = snapshot.transport ?? "unknown";
  const record: LiveCaptureRecord = {
    source: snapshot.source,
    operation: snapshot.operation,
    artifact: snapshot.artifactPath,
    startedAt: snapshot.observedAt,
    finishedAt: snapshot.observedAt,
    outcome: "captured",
    transport,
    httpStatus: snapshot.httpStatus,
    rows: snapshot.rows,
    bytes: snapshot.artifactText.length,
    bodySha256: artifactSha256,
    artifactWritten: true,
    keptPreviousArtifact: false,
    error: null,
    provenanceClass: "api",
  };
  const previousHealth = await readCaptureHealth(healthPath);
  await writeCaptureHealth(
    healthPath,
    mergeCaptureHealth(
      previousHealth,
      [record],
      snapshot.observedAt,
      transport,
    ),
  );

  return {
    wrote: true,
    state: { artifactPath: snapshot.artifactPath, at, sha256: artifactSha256 },
    healthPath,
    artifactSha256,
  };
}
