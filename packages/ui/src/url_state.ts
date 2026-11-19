/**
 * @file url_state.ts
 * @description Shareable dashboard URL state.
 *
 * Owns only the state that is safe to put in a link: the active tab, the build
 * matrix overlay, the selected agent and the wagers-table filters/sort. Customer
 * and ticket deep links, shadow-pricing slice params (`sport`, `period`, …) and
 * `apiBase` are preserved untouched; free-text search stays out of the URL.
 */

import { DASHBOARD_DEFAULT_TAB } from "./config/dashboard.ts";
import { WAGERS_DEFAULTS } from "./config/wagers.ts";
import { resolveInitialTab } from "./tab_routes.ts";
import {
  isWagerSortField,
  resolveDashboardTabId,
  type DashboardTabId,
  type WagerSortField,
} from "./types.ts";

export interface DashboardUrlState {
  readonly tab: DashboardTabId;
  readonly matrix: boolean;
  /** Selected agent id (kept raw here; consumers uppercase for matching). */
  readonly agent: string;
  readonly wSport: string;
  readonly wAlert: string;
  readonly wType: string;
  readonly wChannel: string;
  readonly wSort: WagerSortField;
  readonly wDir: "asc" | "desc";
}

export const DEFAULT_DASHBOARD_URL_STATE: DashboardUrlState = Object.freeze({
  tab: DASHBOARD_DEFAULT_TAB,
  matrix: false,
  agent: "",
  wSport: "ALL",
  wAlert: "ALL",
  wType: "ALL",
  wChannel: "ALL",
  wSort: WAGERS_DEFAULTS.sort_field,
  wDir: WAGERS_DEFAULTS.sort_dir,
});

const P = {
  tab: "tab",
  matrix: "matrix",
  agent: "agent",
  wSport: "wSport",
  wAlert: "wAlert",
  wType: "wType",
  wChannel: "wChannel",
  wSort: "wSort",
  wDir: "wDir",
} as const;

function paramsOf(search: string): URLSearchParams {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

function text(value: string | null): string {
  return value?.trim() ?? "";
}

function filter(value: string | null): string {
  const trimmed = text(value);
  return trimmed === "" ? "ALL" : trimmed;
}

/**
 * Primary header navigation hashes → the view they own. Kept here (not in the App) so a deep link
 * `#risk-overview` resolves on first render, before React has mounted.
 */
export const DASHBOARD_SECTION_TABS: Readonly<Record<string, DashboardTabId>> =
  Object.freeze({
    "risk-overview": "surveillance",
    "bettor-churn-simulation": "customers",
    "system-logs": "terminal",
  });

function resolveTab(
  params: URLSearchParams,
  search: string,
  pathname: string,
  hash: string,
): DashboardTabId {
  const queryTab = text(params.get(P.tab));
  if (queryTab !== "") {
    return resolveDashboardTabId(queryTab, DASHBOARD_DEFAULT_TAB);
  }
  // Slice params are a shadow-pricing quick-jump; keep them opening that tab.
  const sport = text(params.get("sport"));
  const subSport = text(params.get("subSport"));
  if (
    (sport !== "" && sport.toUpperCase() !== "ALL") ||
    (subSport !== "" && subSport.toUpperCase() !== "ALL")
  ) {
    return "shadow";
  }
  if (hash !== "") {
    const section = DASHBOARD_SECTION_TABS[hash.replace(/^#/, "")];
    if (section !== undefined) return section;
    return resolveDashboardTabId(hash, DASHBOARD_DEFAULT_TAB);
  }
  return resolveInitialTab(search, pathname);
}

/** Read and validate shareable state from a location search/path/hash. */
export function readDashboardUrlState(
  search = "",
  pathname = "/",
  hash = "",
): DashboardUrlState {
  const params = paramsOf(search);
  const sort = params.get(P.wSort);
  const dir = params.get(P.wDir);
  return {
    tab: resolveTab(params, search, pathname, hash),
    matrix: params.get(P.matrix) === "1",
    agent: text(params.get(P.agent)),
    wSport: filter(params.get(P.wSport)),
    wAlert: filter(params.get(P.wAlert)),
    wType: filter(params.get(P.wType)),
    wChannel: filter(params.get(P.wChannel)),
    wSort: isWagerSortField(sort) ? sort : WAGERS_DEFAULTS.sort_field,
    wDir: dir === "asc" || dir === "desc" ? dir : WAGERS_DEFAULTS.sort_dir,
  };
}

/**
 * Merge state into a query string. Unknown params (`customer`, `ticket`,
 * `sport`, `apiBase`, …) are preserved. The `tab` param is omitted when the
 * path already resolves to that tab (so `/live-bets` stays clean), and set
 * explicitly when the desired tab differs from the path.
 */
export function buildDashboardSearch(
  state: DashboardUrlState,
  currentSearch = "",
  pathname = "/",
): string {
  const params = paramsOf(currentSearch);
  const pathTab = resolveInitialTab("", pathname);

  if (state.tab === pathTab) params.delete(P.tab);
  else params.set(P.tab, state.tab);

  if (state.matrix) params.set(P.matrix, "1");
  else params.delete(P.matrix);

  if (state.agent !== "") params.set(P.agent, state.agent);
  else params.delete(P.agent);

  const wagerFilters: ReadonlyArray<[string, string]> = [
    [P.wSport, state.wSport],
    [P.wAlert, state.wAlert],
    [P.wType, state.wType],
    [P.wChannel, state.wChannel],
  ];
  if (state.tab === "wagers") {
    for (const [name, value] of wagerFilters) {
      if (value !== "ALL") params.set(name, value);
      else params.delete(name);
    }
    if (state.wSort !== WAGERS_DEFAULTS.sort_field)
      params.set(P.wSort, state.wSort);
    else params.delete(P.wSort);
    if (state.wDir !== WAGERS_DEFAULTS.sort_dir) params.set(P.wDir, state.wDir);
    else params.delete(P.wDir);
  } else {
    for (const [name] of wagerFilters) params.delete(name);
    params.delete(P.wSort);
    params.delete(P.wDir);
  }

  return params.toString();
}

/** Relative URL (path + query + hash) for a state, preserving unknown params. */
export function dashboardUrl(
  state: DashboardUrlState,
  currentHref = "/",
): string {
  const url = new URL(currentHref, "http://dashboard.local");
  url.search = buildDashboardSearch(state, url.search, url.pathname);
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface DashboardHistoryWindow {
  readonly location: {
    readonly href: string;
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
  };
  readonly history: {
    replaceState(data: unknown, unused: string, url: string): void;
    pushState?(data: unknown, unused: string, url: string): void;
  };
}

export interface DashboardWriteOptions {
  /** Add a history entry (tab navigation) instead of replacing the current one. */
  readonly push?: boolean;
}

/**
 * Replace the current history entry (never push) when the URL actually changes.
 * Returns true when a write happened. No-op during SSR.
 */
function defaultHistoryWindow(): DashboardHistoryWindow | null {
  const candidate = (
    globalThis as unknown as { window?: DashboardHistoryWindow }
  ).window;
  return candidate ?? null;
}

export function writeDashboardUrl(
  state: DashboardUrlState,
  win: DashboardHistoryWindow | null = defaultHistoryWindow(),
  options: DashboardWriteOptions = {},
): boolean {
  if (win === null) return false;
  const next = dashboardUrl(state, win.location.href);
  const current = `${win.location.pathname}${win.location.search}${win.location.hash}`;
  if (next === current) return false;
  if (options.push === true && typeof win.history.pushState === "function") {
    win.history.pushState(null, "", next);
  } else {
    win.history.replaceState(null, "", next);
  }
  return true;
}
