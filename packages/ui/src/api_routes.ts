/**
 * @file packages/ui/src/api_routes.ts
 * @description The desk's endpoint names, their paths, and the one URL builder the UI uses.
 *
 * `[api]` in `dashboard.toml` stays the only place a declared path is written down; the keys
 * below are the names a call site is allowed to say out loud, so no component spells
 * `/api/bet-ticker` or interpolates `?id=` by hand. `deskApiUrl` resolves the path against the
 * configured base and appends query params through `URL.searchParams`, which encodes them once.
 *
 * The daemon's `?apiBase=` loopback override still applies: `dashboardApiUrl` owns base resolution
 * (including the empty-base same-origin case), and this module only builds the path.
 */

import { DASHBOARD_API, dashboardApiUrl } from "./config/dashboard.ts";

/** Routes declared in `[api]`; the key is the name the UI should use. */
export const DESK_API_ROUTES = {
  dashboard: DASHBOARD_API.dashboard,
  tiers: DASHBOARD_API.tiers,
  customers: DASHBOARD_API.customers,
  wagers: DASHBOARD_API.wagers,
  betTicker: DASHBOARD_API.bet_ticker,
  r2Pipeline: DASHBOARD_API.r2_pipeline,
  dns: DASHBOARD_API.dns,
  health: DASHBOARD_API.health,
  buildMatrix: DASHBOARD_API.build_matrix,
} as const;

/**
 * Routes the daemon serves that `[api]` does not declare. Named here so a call site still has a
 * symbol instead of a string literal; promote one to `[api]` when it needs a base override.
 */
export const DESK_API_EXTRA_ROUTES = {
  liveBetsV2: "/api/v2/live-bets",
  customerProfile: "/api/customer/profile",
  customerRating: "/api/customer/rating",
  r2PipelineHistory: "/api/r2/pipeline/history",
  gsliveVerifyTickets: "/api/gslive/verify-tickets",
  terminalExec: "/api/terminal/exec",
  imageAssets: "/api/diagnostics/image-assets",
} as const;

export type DeskApiRoute =
  keyof typeof DESK_API_ROUTES | keyof typeof DESK_API_EXTRA_ROUTES;

/** Query values; `null`/`undefined` drop the parameter instead of writing "null". */
export type DeskApiParams = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

export interface DeskApiUrlOptions {
  /** Origin override; `null` means the configured base (and its loopback `?apiBase=`). */
  readonly base?: string | null;
  readonly params?: DeskApiParams;
}

/** Path for a named route, or the given path/URL unchanged when it is already one. */
export function deskApiPath(route: DeskApiRoute | string): string {
  if (route in DESK_API_ROUTES) {
    return DESK_API_ROUTES[route as keyof typeof DESK_API_ROUTES];
  }
  if (route in DESK_API_EXTRA_ROUTES) {
    return DESK_API_EXTRA_ROUTES[route as keyof typeof DESK_API_EXTRA_ROUTES];
  }
  return route;
}

/** Apply params through `URL`, so a value is encoded exactly once. */
function withParams(path: string, params: DeskApiParams): string {
  const url = new URL(path, "http://dashboard.local");
  for (const [name, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") continue;
    url.searchParams.set(name, String(value));
  }
  return `${url.pathname}${url.search}`;
}

/**
 * Absolute URL when `[api].base` (or the loopback `?apiBase=`) names an origin, a same-origin
 * relative path otherwise. A trailing `#hash` and unrelated params survive.
 */
export function deskApiUrl(
  route: DeskApiRoute | string,
  options: DeskApiUrlOptions = {},
): string {
  const path = deskApiPath(route);
  const withQuery =
    options.params === undefined ? path : withParams(path, options.params);
  return dashboardApiUrl(withQuery, options.base ?? null);
}
