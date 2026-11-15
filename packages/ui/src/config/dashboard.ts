/**
 * @file packages/ui/src/config/dashboard.ts
 * @description Sole TypeScript entrypoint for `dashboard.toml`.
 *
 * Bun parses and tree-shakes static TOML named exports at bundle time.
 * Never import `churn` here — `scripts/validate_dashboard_config.ts` asserts that
 * unimported top-level tables (`[churn]`) are eliminated from `dist/dashboard/*.js`
 * while active keys (`thresholds.sharp`) are inlined.
 */

import { type DashboardTabId, resolveDashboardTabId } from "../types.ts";
import {
  api,
  freshness,
  leagues,
  meta,
  panels,
  thresholds,
} from "./dashboard.toml";

export interface DashboardMeta {
  readonly schema: string;
  readonly version: string;
  /** ISO-8601 string: unquoted TOML dates parse to Temporal.* and fail validation. */
  readonly generated_at: string;
  readonly auto_execute: false;
}

export interface DashboardThresholds {
  readonly sharp: number;
  readonly elite_sharp_score: number;
  readonly sharp_score: number;
  readonly steam: number;
  readonly clv_alert_bps: number;
  readonly conduit_concentration_pct: number;
  readonly high_risk_wager_usd: number;
}

export interface DashboardLeagues {
  readonly names: readonly string[];
  readonly primary: readonly string[];
  readonly inplay_priority: readonly string[];
}

export interface DashboardApi {
  /** Empty for same-origin; otherwise an origin (`scheme://host[:port]`) without a path. */
  readonly base: string;
  readonly dashboard: string;
  readonly tiers: string;
  readonly customers: string;
  readonly wagers: string;
  readonly bet_ticker: string;
  readonly r2_pipeline: string;
  readonly dns: string;
  readonly health: string;
  readonly build_matrix: string;
}

export interface DashboardFreshness {
  readonly stale_after_minutes: number;
  readonly critical_after_minutes: number;
  readonly poll_dashboard_seconds: number;
  readonly poll_wagers_seconds: number;
  readonly poll_ticker_seconds: number;
  readonly poll_dns_seconds: number;
}

export interface DashboardPanelsConfig {
  readonly default_tab: string;
  readonly customers_page_size: number;
  readonly live_wagers_limit: number;
  readonly ticker_max_rows: number;
  readonly dns_cache_capacity: number;
  readonly dns_warm_hit_rate_pct: number;
  readonly dns_active_hit_rate_pct: number;
}

export const DASHBOARD_META = meta as DashboardMeta;
export const DASHBOARD_THRESHOLDS = thresholds as DashboardThresholds;
export const DASHBOARD_LEAGUES = leagues as DashboardLeagues;
export const DASHBOARD_API = api as DashboardApi;
export const DASHBOARD_FRESHNESS = freshness as DashboardFreshness;
export const DASHBOARD_PANELS = panels as DashboardPanelsConfig;

/** Validated default tab resolved from `dashboard.toml` `[panels].default_tab`. */
export const DASHBOARD_DEFAULT_TAB: DashboardTabId = resolveDashboardTabId(
  DASHBOARD_PANELS.default_tab,
);

/** Loopback hosts allowed to override `[api].base` via `?apiBase=...` in local dev. */
const DEV_OVERRIDE_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * `?apiBase=http://127.0.0.1:4021` overrides `[api].base` at runtime for loopback
 * dev servers without mutating `dashboard.toml`. Non-loopback hosts are ignored.
 */
function devApiBaseOverride(): string | null {
  const page = (globalThis as { location?: { search?: string } }).location;
  if (!page) return null;
  const raw = new URLSearchParams(page.search ?? "").get("apiBase");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return DEV_OVERRIDE_HOSTS.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

/**
 * Resolve a feed path against `[api].base` (origin only; `checkSchema` rejects paths).
 * Passing an absolute `/api/...` path into `new URL(path, base)` replaces any path on `base`.
 */
export function dashboardApiUrl(
  path: string,
  base: string | null = null,
): string {
  const resolved = base ?? devApiBaseOverride() ?? DASHBOARD_API.base;
  if (!resolved) return path;
  return new URL(path, resolved).toString();
}
