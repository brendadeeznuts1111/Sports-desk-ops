/**
 * @file packages/api/src/types.ts
 * @description Dependency-injection interfaces for `createDashboardApi(deps)`.
 */

import type {
  MarketFilter,
  PeriodFilter,
  RouterAuditMode,
  ShadowRepriceMode,
  SportFilter,
  SubSportFilter,
} from "@sportsdesk-ops/contracts";

export type RouteRequestWithParams<
  P extends Record<string, string> = Record<string, string>,
> = Request & { readonly params: P };

export interface EncodedResponseSpec {
  readonly version: string;
  readonly contentType: string;
  readonly produce: () => Uint8Array<ArrayBuffer>;
  readonly headers?: Record<string, string> | undefined;
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
  readonly routerAuditMode?: RouterAuditMode | undefined;
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
  readonly loadDashboardMarkdown: () => Promise<{
    readonly stamp: string;
    readonly markdown: string;
    readonly html: string;
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
  readonly getBuildMatrix: () => Promise<readonly unknown[]>;
}
