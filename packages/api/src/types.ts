/**
 * @file packages/api/src/types.ts
 * @description Dependency-injection interfaces for `createDashboardApi(deps)`.
 */

import type {
  AgentDetailApiResponse,
  AutomationsSnapshot,
  BetTickerApiResponse,
  Daemon4020Status,
  MarketFilter,
  PeriodFilter,
  R2ImageProvenanceApiResponse,
  R2PipelineApiResponse,
  R2PipelineHistoryApiResponse,
  RegimeFilter,
  RouterAuditMode,
  ShadowRepriceMode,
  SportFilter,
  SubSportFilter,
  TicketVerificationSummary,
} from "@sportsdesk-ops/contracts";

/**
 * One completed `Bun.build` DCE probe. `generatedAt` is the probe's completion
 * time, not the response time: the server caches the probe and re-serves it, so a
 * response timestamp would make a stale probe look fresh.
 */
export interface BuildMatrixStaticDirProbe {
  readonly wildcardPath: string;
  readonly dir: string;
  readonly caseInsensitiveHostFs: boolean;
  readonly totalFiles: number;
  readonly totalBytes: number;
  readonly files: readonly {
    readonly relativePath: string;
    readonly urlPath: string;
    readonly bytes: number;
    readonly contentType: string;
    readonly lastModifiedIso: string | null;
  }[];
  readonly liveCheck: {
    readonly origin: string;
    readonly elapsedMs: number;
    readonly allPassed: boolean;
    readonly etag: string | null;
    readonly contentRange: string | null;
    readonly checks: readonly {
      readonly name: string;
      readonly requestPath: string;
      readonly expectedStatus: number;
      readonly status: number | null;
      readonly ok: boolean;
      readonly detail: string;
    }[];
  } | null;
}

export interface BuildMatrixProbe {
  readonly targets: readonly unknown[];
  readonly generatedAt: string;
  readonly staticDir?: BuildMatrixStaticDirProbe | undefined;
}

export type RouteRequestWithParams<
  P extends Record<string, string> = Record<string, string>,
> = Request & { readonly params: P };

export interface EncodedResponseSpec {
  readonly version: string;
  readonly contentType: string;
  readonly produce: () => Uint8Array<ArrayBuffer>;
  readonly headers?: Record<string, string> | undefined;
  /** `false` when the payload is assembled per request and must not occupy the body cache. */
  readonly cache?: boolean | undefined;
}

export interface ShadowPricingQueryParams {
  readonly dbPath?: string | undefined;
  readonly forceFixture: boolean;
  readonly ladderKey3?: number | undefined;
  readonly ladderKey7?: number | undefined;
  readonly ladderKey14_21?: number | undefined;
  readonly minVolume?: number | undefined;
  readonly retailElasticity?: number | undefined;
  readonly repriceMode?: ShadowRepriceMode | undefined;
  readonly sport?: SportFilter | undefined;
  readonly subSport?: SubSportFilter | undefined;
  readonly period?: PeriodFilter | undefined;
  readonly market?: MarketFilter | undefined;
  readonly regime?: RegimeFilter | undefined;
  readonly routerAuditMode?: RouterAuditMode | undefined;
}

/** Live load counters straight off the `Bun.serve` server object. */
export interface DashboardServerTelemetry {
  readonly pendingRequests: number;
  readonly pendingWebSockets: number;
  /**
   * `server.subscriberCount(topic)` per dashboard topic. uWS's own table, so it can disagree with
   * the client-derived distribution when a socket is subscribed but not tracked.
   */
  readonly subscriberCounts?: Readonly<Record<string, number>> | undefined;
}

export interface DashboardApiDeps {
  readonly enforceAuth?:
    ((req: Request) => Promise<Response | null>) | undefined;
  readonly auth: {
    readonly login: (req: Request) => Response | Promise<Response>;
    readonly logout: (req: Request) => Response | Promise<Response>;
    readonly me: (req: Request) => Response | Promise<Response>;
  };
  readonly encodeResponse?:
    | ((
        req: Request,
        spec: EncodedResponseSpec,
      ) => Response | Promise<Response>)
    | undefined;
  readonly getHealthPayload: () => Promise<object> | object;
  /**
   * Live `Bun.serve` counters. Optional: a host without the `Server` reference (or the in-memory
   * test harness) omits them rather than reporting a fabricated zero.
   */
  readonly getServerTelemetry?: (() => DashboardServerTelemetry) | undefined;
  readonly loadDashboardMarkdown: () => Promise<{
    readonly stamp: string;
    readonly markdown: string;
    readonly html: string;
    readonly renderDurationMs?: number;
    readonly markdownBytes?: number;
    readonly htmlBytes?: number;
    readonly nonAsciiChars?: number;
  } | null>;
  readonly dns: {
    readonly getTelemetryPayload: () => Record<string, unknown>;
    readonly benchmark: (host: string) => Promise<unknown>;
    readonly classifyIp: (ip: string) => Promise<unknown>;
  };
  readonly customers: {
    readonly getCohortReport: () => Promise<{
      readonly versionStamp: string;
      readonly payload: unknown;
    }>;
    readonly getProfile: (id: string) => Promise<unknown | null>;
    readonly getRating: (id: string) => Promise<unknown | null>;
  };
  readonly execTerminal: (
    command: string,
    dims: { readonly cols: number; readonly rows: number },
  ) => Promise<unknown>;
  readonly rankings: {
    readonly getAll: (limit: number) => Promise<{
      readonly generatedAtIso: string;
      readonly payload: unknown;
    }>;
    readonly getConduits: () => Promise<readonly unknown[]>;
  };
  readonly getLiveWagersPayload: () => Promise<object>;
  /**
   * Panel-policy stamp merged into `/api/wagers` and `/api/live-wagers`.
   * Optional so hermetic API tests need no policy file; when absent the feed
   * response is unchanged. The host wires `loadWagersTabPolicyStamp()`.
   */
  readonly getWagersTabPolicy?:
    (() => Promise<WagersTabPolicyStamp | null>) | undefined;
  readonly getTiersConfig: () => Promise<unknown>;
  readonly alerts: {
    readonly sweepOnce: () => Promise<unknown>;
    readonly list: (status: string) => readonly unknown[];
    readonly ack: (input: {
      readonly deliveryId: string;
      readonly operatorId: string;
      readonly notes?: string | undefined;
    }) => Promise<boolean>;
    readonly retry: (input: {
      readonly deliveryId: string;
      readonly operatorId: string;
    }) => Promise<string | null>;
    readonly getShiftSummary: (operatorId: string) => unknown;
  };
  readonly getTaxonomyCatalog: () => unknown;
  readonly runShadowPricing: (
    params: ShadowPricingQueryParams,
  ) => Promise<unknown>;
  readonly forceShadowFixture?: boolean | undefined;
  readonly shadowDbPath?: string | undefined;
  /**
   * DCE build-matrix probe. `force` recompiles the three targets instead of
   * returning the process-wide cached probe.
   */
  readonly getBuildMatrix: (force?: boolean) => Promise<BuildMatrixProbe>;
  readonly handleMcp?:
    ((req: Request) => Response | Promise<Response>) | undefined;
  readonly getBetTickerPayload?:
    | ((filters?: {
        readonly writer?: string | undefined;
        readonly wagerType?: string | undefined;
      }) => Promise<BetTickerApiResponse> | BetTickerApiResponse)
    | undefined;
  readonly getR2PipelinePayload?:
    | ((options?: {
        readonly refresh?: boolean | undefined;
      }) => Promise<R2PipelineApiResponse> | R2PipelineApiResponse)
    | undefined;
  /**
   * Process-local freshness samples for the R2 sinks. Optional so hermetic API
   * tests need no service; when absent the route reports an empty series
   * (`source: "process-memory"`, no samples) instead of inventing points.
   */
  readonly getR2PipelineHistoryPayload?:
    | ((options?: {
        readonly refresh?: boolean | undefined;
        readonly limit?: number | undefined;
      }) =>
        Promise<R2PipelineHistoryApiResponse> | R2PipelineHistoryApiResponse)
    | undefined;
  /**
   * Header-only `sportsdesk:*` provenance for one public R2 PNG/WebP key.
   * Optional: when absent the route reports an explicit "not configured" issue.
   */
  readonly getR2ImageProvenancePayload?:
    | ((options: {
        readonly key: string;
      }) =>
        Promise<R2ImageProvenanceApiResponse> | R2ImageProvenanceApiResponse)
    | undefined;
  readonly getDaemonStatusPayload?:
    (() => Promise<Daemon4020Status> | Daemon4020Status) | undefined;
  readonly getAutomationsPayload?:
    (() => Promise<AutomationsSnapshot> | AutomationsSnapshot) | undefined;
  readonly runGsliveTicketVerify?:
    | ((options?: {
        readonly dryRun?: boolean | undefined;
      }) => Promise<TicketVerificationSummary>)
    | undefined;
  readonly getAgentDetailPayload?:
    | ((
        agentId: string,
      ) => Promise<AgentDetailApiResponse> | AgentDetailApiResponse)
    | undefined;
}

/**
 * Stable, build-independent identity of the wagers-tab policy the server carries.
 * Read from `packages/ui/src/config/wagers.toml` at request time.
 */
export interface WagersTabPolicyStamp {
  /** `[table].policy_tag`, e.g. `wagers-policy/v1`. */
  readonly policy_version: string;
  /** `[meta].schema`, e.g. `sportsdesk-wagers-tab/v1`. */
  readonly policy_schema: string;
}
