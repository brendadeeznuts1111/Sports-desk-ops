/**
 * @file r2_canonical_manifests.ts
 * @description Public read-side contract for the canonical CAS manifests
 * (`manifests/<sink>/latest`) that `r2_manifest_cas.ts` promotes into
 * `sportsdesk-ops-reports`. The write side owns Compare-And-Swap; this probe owns
 * what an operator can see without credentials.
 *
 * The desk dashboard runs with no R2 credentials, so this module reads the public
 * gateway directly: one GET per sink returns both the pointer's `Last-Modified` and
 * the manifest body. Pointer freshness, lineage and integrity are reported as
 * separate facts, so a fresh pointer never hides an open circuit, a manifest read
 * from the wrong key, or a non-zero reconciliation gap.
 */

import {
  CANONICAL_R2_SINK_SPECS,
  type CanonicalManifestRecord,
  type CanonicalR2SinkId,
} from "./r2_manifest_cas.ts";
import {
  R2_DATA_STALE_SECONDS,
  parseDataWindowEndMs,
} from "./r2_pipeline_kpis.ts";
import {
  R2_PUBLIC_BASE,
  evaluateProbe,
  parseLastModified,
  type StalenessProbe,
  type StalenessState,
} from "./r2_staleness.ts";

/** Canonical sink ids in declaration order, so a consumer renders a stable list. */
export const CANONICAL_MANIFEST_SINK_IDS: readonly CanonicalR2SinkId[] =
  Object.keys(CANONICAL_R2_SINK_SPECS) as readonly CanonicalR2SinkId[];

/** One canonical sink as the dashboard measures it: pointer freshness plus lineage. */
export interface CanonicalManifestKpi {
  readonly sinkId: CanonicalR2SinkId;
  /** Public key the probe read (`manifests/<sink>/latest`). */
  readonly manifestKey: string;
  readonly lastModified: string | null;
  /** Publish age from `Last-Modified`; null when the pointer did not answer. */
  readonly ageSeconds: number | null;
  /** True for `stale`, `missing` and `error` — every non-fresh pointer state. */
  readonly stale: boolean;
  readonly state: StalenessState;
  readonly reason: string;
  readonly dataAgeSeconds: number | null;
  readonly dataStale: boolean;
  readonly dataWindowToMs: number | null;
  readonly generation: number | null;
  readonly merkleRoot: string | null;
  /** `CLOSED`/`OPEN` as the manifest records it; null when the body is absent. */
  readonly circuitState: string | null;
  readonly unresolvedGapCents: string | null;
  /**
   * Whether the body's `sink_id` — or `manifest_key` when a sink omits `sink_id` —
   * matches the key it was read from. Null when the body is absent or carries
   * neither field.
   */
  readonly identityOk: boolean | null;
  readonly publishedAt: string | null;
}

export type CanonicalManifestKpis = Readonly<
  Record<CanonicalR2SinkId, CanonicalManifestKpi>
>;

/** Injectable for tests; a real `fetch` is used by default. */
export type CanonicalManifestFetcher = (
  url: string,
  init: { readonly method: "GET" },
) => Promise<Response>;

const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

/** The public URL of one canonical manifest pointer. */
export function canonicalManifestPublicUrl(sinkId: CanonicalR2SinkId): string {
  return `${R2_PUBLIC_BASE}/${CANONICAL_R2_SINK_SPECS[sinkId].manifestKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readEpochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readGeneration(body: CanonicalManifestRecord): number | null {
  const value = body.generation_u32 ?? body.snapshot_gen_u32;
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

interface ManifestRead {
  readonly status: number;
  readonly lastModifiedMs: number | null;
  readonly body: CanonicalManifestRecord | null;
  readonly error?: string;
}

/**
 * One GET per sink returns both the pointer's `Last-Modified` and its body, so a
 * dashboard poll costs one request per manifest instead of two.
 */
async function readManifest(
  url: string,
  fetchImpl: CanonicalManifestFetcher,
): Promise<ManifestRead> {
  try {
    const response = await fetchImpl(url, { method: "GET" });
    const lastModifiedMs = parseLastModified(
      response.headers.get("last-modified"),
    );
    if (!response.ok) {
      return { status: response.status, lastModifiedMs, body: null };
    }
    let body: CanonicalManifestRecord | null = null;
    try {
      const parsed: unknown = await response.json();
      body = isRecord(parsed) ? (parsed as CanonicalManifestRecord) : null;
    } catch {
      body = null;
    }
    return { status: response.status, lastModifiedMs, body };
  } catch (err) {
    return {
      status: 0,
      lastModifiedMs: null,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function probeCanonicalManifest(
  sinkId: CanonicalR2SinkId,
  nowMs: number,
  fetchImpl: CanonicalManifestFetcher,
): Promise<CanonicalManifestKpi> {
  const spec = CANONICAL_R2_SINK_SPECS[sinkId];
  const url = canonicalManifestPublicUrl(sinkId);
  const target = { key: spec.manifestKey, slaMs: spec.slaMs, label: sinkId };
  const read = await readManifest(url, fetchImpl);
  const probe: StalenessProbe =
    read.error === undefined
      ? { target, status: read.status, lastModifiedMs: read.lastModifiedMs }
      : {
          target,
          status: read.status,
          lastModifiedMs: read.lastModifiedMs,
          error: read.error,
        };
  const body = read.body;

  const verdict = evaluateProbe(probe, nowMs);
  const windowToMs = body === null ? null : parseDataWindowEndMs(body);
  const dataAgeSeconds =
    windowToMs === null
      ? null
      : Math.max(0, Math.round((nowMs - windowToMs) / 1_000));
  const publishedEpochMs =
    body === null ? null : readEpochMs(body.r2_published_at_epoch_ms);
  const seenSinkId = body === null ? null : readText(body.sink_id);
  const seenManifestKey = body === null ? null : readText(body.manifest_key);
  // `sink_id` is the primary identity; the rings manifest carries `manifest_key` instead.
  const identityOk =
    seenSinkId !== null
      ? seenSinkId === sinkId
      : seenManifestKey !== null
        ? seenManifestKey === spec.manifestKey
        : null;

  return {
    sinkId,
    manifestKey: spec.manifestKey,
    lastModified:
      probe.lastModifiedMs === null
        ? null
        : new Date(probe.lastModifiedMs).toISOString(),
    ageSeconds:
      verdict.ageMs === null ? null : Math.round(verdict.ageMs / 1_000),
    stale: verdict.state !== "fresh",
    state: verdict.state,
    reason: verdict.reason,
    dataAgeSeconds,
    dataStale:
      dataAgeSeconds !== null && dataAgeSeconds > R2_DATA_STALE_SECONDS,
    dataWindowToMs: windowToMs,
    generation: body === null ? null : readGeneration(body),
    merkleRoot: body === null ? null : readText(body.merkle_root_sha256),
    circuitState: body === null ? null : readText(body.circuit_state),
    unresolvedGapCents:
      body === null ? null : readText(body.unresolved_gap_cents),
    identityOk,
    publishedAt:
      publishedEpochMs === null
        ? null
        : new Date(publishedEpochMs).toISOString(),
  };
}

/**
 * Probe every canonical sink against the public gateway.
 *
 * Never throws: a refused connection, a 404, a non-JSON body or a missing
 * `Last-Modified` becomes `error`/`missing` on that sink only. The returned record
 * always carries every {@link CANONICAL_MANIFEST_SINK_IDS} entry.
 */
export async function probeCanonicalManifestKpis(
  now: Date = new Date(),
  fetchImpl: CanonicalManifestFetcher = (url, init) =>
    fetch(url, {
      ...init,
      signal: AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS),
    }),
): Promise<CanonicalManifestKpis> {
  const nowMs = now.getTime();
  const results = await Promise.all(
    CANONICAL_MANIFEST_SINK_IDS.map((sinkId) =>
      probeCanonicalManifest(sinkId, nowMs, fetchImpl),
    ),
  );
  // The probe enumerates every canonical sink id, so each key is present exactly once.
  const out = {} as Record<CanonicalR2SinkId, CanonicalManifestKpi>;
  for (const kpi of results) out[kpi.sinkId] = kpi;
  return out;
}
