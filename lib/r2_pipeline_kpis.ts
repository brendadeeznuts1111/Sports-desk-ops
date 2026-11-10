/**
 * Public R2 `latest.json` freshness for `/api/kpis.pipeline.r2` — same SLA as `lib/r2_staleness.ts`.
 * Publish age (HEAD Last-Modified) is separate from **data age** (rollup window end).
 */

import {
  BRIDGE_STALENESS_TARGETS,
  evaluateProbe,
  parseLastModified,
  publicUrlFor,
  R2_PUBLIC_BASE,
  type StalenessProbe,
  type StalenessState,
  type StalenessTarget,
} from "./r2_staleness.ts";

/** Data older than this is surfaced as `dataStale` (distinct from publish SLA stale). */
export const R2_DATA_STALE_SECONDS = 86_400;

export interface R2PipelineSinkKpi {
  readonly lastModified: string | null;
  /** Age of the published `latest.json` pointer (publish / Last-Modified). */
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly state: StalenessState;
  readonly reason: string;
  /** Age of the covered data window end (`window.toMs`, epoch end, or observedEnd). */
  readonly dataAgeSeconds: number | null;
  readonly dataStale: boolean;
  readonly dataWindowToMs: number | null;
}

export type R2PipelineKpis = Readonly<Record<string, R2PipelineSinkKpi>>;

/** Injectable for tests (avoids requiring full Bun `fetch` surface). */
export type R2PipelineFetcher = (
  url: string,
  init: { readonly method: "HEAD" | "GET" },
) => Promise<Response>;

/** @deprecated Use {@link R2PipelineFetcher}. */
export type R2HeadFetcher = R2PipelineFetcher;

const SINK_ID = (key: string) => key.replace(/\/latest\.json$/, "");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Best-effort end-of-window ms from a rollup body or inline latest artifact. */
export function parseDataWindowEndMs(value: unknown): number | null {
  if (!isRecord(value)) return null;
  const window = value.window;
  if (isRecord(window)) {
    if (typeof window.toMs === "number" && Number.isFinite(window.toMs)) {
      return window.toMs;
    }
    const observedEnd = window.observedEnd;
    if (typeof observedEnd === "string" && observedEnd.trim() !== "") {
      const ms = Date.parse(observedEnd);
      if (Number.isFinite(ms)) return ms;
    }
    if (
      typeof window.toEpochSec === "number" &&
      Number.isFinite(window.toEpochSec)
    ) {
      return window.toEpochSec * 1000;
    }
    if (typeof window.to === "number" && Number.isFinite(window.to)) {
      return window.to < 1e12 ? window.to * 1000 : window.to;
    }
  }
  const generatedAt = value.generatedAt ?? value.capturedAt;
  if (typeof generatedAt === "string" && generatedAt.trim() !== "") {
    const ms = Date.parse(generatedAt);
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function artifactUrlFromPointer(pointer: unknown): string | null {
  if (!isRecord(pointer)) return null;
  const key = pointer.key;
  if (typeof key !== "string" || key.trim() === "") return null;
  const trimmed = key.replace(/^\/+/, "");
  return `${R2_PUBLIC_BASE}/${trimmed}`;
}

async function readJsonBody(
  url: string,
  fetchImpl: R2PipelineFetcher,
): Promise<unknown | null> {
  try {
    const response = await fetchImpl(url, { method: "GET" });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  }
}

async function resolveDataWindowToMs(
  target: StalenessTarget,
  fetchImpl: R2PipelineFetcher,
): Promise<number | null> {
  const latestUrl = publicUrlFor(target);
  const latest = await readJsonBody(latestUrl, fetchImpl);
  if (latest === null) return null;

  const inlineEnd = parseDataWindowEndMs(latest);
  const artifactUrl = artifactUrlFromPointer(latest);
  if (artifactUrl === null) return inlineEnd;

  const rollup = await readJsonBody(artifactUrl, fetchImpl);
  if (rollup === null) return inlineEnd;
  return parseDataWindowEndMs(rollup) ?? inlineEnd;
}

function applyDataAge(
  kpi: R2PipelineSinkKpi,
  windowToMs: number | null,
  nowMs: number,
): R2PipelineSinkKpi {
  if (windowToMs === null || !Number.isFinite(windowToMs)) {
    return {
      ...kpi,
      dataAgeSeconds: null,
      dataStale: false,
      dataWindowToMs: null,
    };
  }
  const ageSeconds = Math.max(0, Math.round((nowMs - windowToMs) / 1000));
  return {
    ...kpi,
    dataWindowToMs: windowToMs,
    dataAgeSeconds: ageSeconds,
    dataStale: ageSeconds > R2_DATA_STALE_SECONDS,
  };
}

const DEFAULT_R2_PROBE_TIMEOUT_MS = 5_000;

export async function probeR2PipelineKpis(
  now: Date = new Date(),
  fetchImpl: R2PipelineFetcher = (url, init) =>
    fetch(url, {
      ...init,
      signal: AbortSignal.timeout(DEFAULT_R2_PROBE_TIMEOUT_MS),
    }),
): Promise<R2PipelineKpis> {
  const nowMs = now.getTime();
  const out: Record<string, R2PipelineSinkKpi> = {};
  await Promise.all(
    BRIDGE_STALENESS_TARGETS.map(async (target) => {
      const url = publicUrlFor(target);
      const [probe, windowToMs] = await Promise.all([
        (async (): Promise<StalenessProbe> => {
          try {
            const response = await fetchImpl(url, { method: "HEAD" as const });
            return {
              target,
              status: response.status,
              lastModifiedMs: parseLastModified(
                response.headers.get("last-modified"),
              ),
            };
          } catch (err) {
            return {
              target,
              status: 0,
              lastModifiedMs: null,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })(),
        resolveDataWindowToMs(target, fetchImpl),
      ]);
      const verdict = evaluateProbe(probe, nowMs);
      const base: R2PipelineSinkKpi = {
        lastModified:
          probe.lastModifiedMs === null
            ? null
            : new Date(probe.lastModifiedMs).toISOString(),
        ageSeconds:
          verdict.ageMs === null ? null : Math.round(verdict.ageMs / 1000),
        stale:
          verdict.state === "stale" ||
          verdict.state === "missing" ||
          verdict.state === "error",
        state: verdict.state,
        reason: verdict.reason,
        dataAgeSeconds: null,
        dataStale: false,
        dataWindowToMs: null,
      };
      out[SINK_ID(target.key)] = applyDataAge(base, windowToMs, nowMs);
    }),
  );
  return out;
}
