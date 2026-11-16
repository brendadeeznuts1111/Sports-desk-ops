/**
 * @file build_info.ts
 * @description Build-time metadata injected by `Bun.build({ define })` in
 * `scripts/build_dashboard.ts`.
 *
 * In an unbundled HMR session these identifiers are undeclared; the `typeof`
 * guard is intentional and keeps `getDashboardBuildInfo()` null there. The
 * bundler replaces each identifier with a JSON string literal, which lets the
 * footer show exactly which build is running without a runtime fetch.
 */

declare const __DASHBOARD_BUILD_TARGET__: string;
declare const __DASHBOARD_BUILD_TIME__: string;
declare const __DASHBOARD_BUILD_COMMIT__: string;

export interface DashboardBuildInfo {
  readonly target: string;
  readonly builtAt: string;
  readonly commit: string;
}

export function getDashboardBuildInfo(): DashboardBuildInfo | null {
  if (typeof __DASHBOARD_BUILD_TARGET__ === "undefined") return null;
  return {
    target: __DASHBOARD_BUILD_TARGET__,
    builtAt: __DASHBOARD_BUILD_TIME__,
    commit: __DASHBOARD_BUILD_COMMIT__,
  };
}
