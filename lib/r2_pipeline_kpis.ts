/**
 * Public R2 `latest.json` freshness for `/api/kpis.pipeline.r2` — same SLA as `lib/r2_staleness.ts`.
 */

import {
  BRIDGE_STALENESS_TARGETS,
  evaluateProbe,
  parseLastModified,
  publicUrlFor,
  type StalenessProbe,
  type StalenessState,
} from "./r2_staleness.ts";

export interface R2PipelineSinkKpi {
  readonly lastModified: string | null;
  readonly ageSeconds: number | null;
  readonly stale: boolean;
  readonly state: StalenessState;
  readonly reason: string;
}

export type R2PipelineKpis = Readonly<Record<string, R2PipelineSinkKpi>>;

/** Injectable for tests (avoids requiring full Bun `fetch` surface). */
export type R2HeadFetcher = (
  url: string,
  init: { readonly method: "HEAD" },
) => Promise<Response>;

const SINK_ID = (key: string) => key.replace(/\/latest\.json$/, "");

export async function probeR2PipelineKpis(
  now: Date = new Date(),
  fetchImpl: R2HeadFetcher = (url, init) => fetch(url, init),
): Promise<R2PipelineKpis> {
  const nowMs = now.getTime();
  const out: Record<string, R2PipelineSinkKpi> = {};
  await Promise.all(
    BRIDGE_STALENESS_TARGETS.map(async (target) => {
      const url = publicUrlFor(target);
      let probe: StalenessProbe;
      try {
        const response = await fetchImpl(url, { method: "HEAD" as const });
        probe = {
          target,
          status: response.status,
          lastModifiedMs: parseLastModified(
            response.headers.get("last-modified"),
          ),
        };
      } catch (err) {
        probe = {
          target,
          status: 0,
          lastModifiedMs: null,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      const verdict = evaluateProbe(probe, nowMs);
      out[SINK_ID(target.key)] = {
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
      };
    }),
  );
  return out;
}
