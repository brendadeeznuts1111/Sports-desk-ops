/**
 * Tab ↔ URL mapping for the React dashboard.
 *
 * The app is mounted at both `/` (dev:api host) and `/app` (the daemon route), so tab links are
 * relative (`?tab=…`) and the path resolver only looks at the last segment. That makes
 * `/app/live-bets` and `/live-bets` both open the wagers tab, while an explicit `?tab=` still wins.
 */
import type { DashboardTabId } from "./types.ts";

const TAB_IDS: readonly DashboardTabId[] = [
  "surveillance",
  "customers",
  "terminal",
  "rankings",
  "wagers",
  "bet-ticker",
  "r2",
  "alerts",
  "shadow",
];

const PATH_TABS: Readonly<Record<string, DashboardTabId>> = {
  "live-bets": "wagers",
  wagers: "wagers",
  "bet-ticker": "bet-ticker",
  customers: "customers",
  surveillance: "surveillance",
  shadow: "shadow",
  terminal: "terminal",
  rankings: "rankings",
  alerts: "alerts",
  r2: "r2",
};

export function isDashboardTab(value: string | null): value is DashboardTabId {
  return value !== null && (TAB_IDS as readonly string[]).includes(value);
}

/** Resolve the initial tab: explicit `?tab=`, then the last path segment, then customers. */
export function resolveInitialTab(
  search: string,
  pathname: string,
): DashboardTabId {
  const fromQuery = new URLSearchParams(search).get("tab");
  if (isDashboardTab(fromQuery)) return fromQuery;
  const segment = pathname.split("/").filter(Boolean).pop() ?? "";
  return PATH_TABS[segment] ?? "customers";
}

/** A relative link that carries the tab; resolves under both `/` and `/app/`. */
export function tabHref(tab: DashboardTabId): string {
  return `?tab=${tab}`;
}
