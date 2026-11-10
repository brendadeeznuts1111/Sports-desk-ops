/**
 * @file src/dashboard/runtime_flags.ts
 * @description Compile-time bun:bundle feature evaluation for the SportsDesk Dashboard.
 *
 * AST Constraint (AGENTS.md): `feature()` from `"bun:bundle"` MUST appear ONLY
 * directly inside an `if` condition or ternary condition (`feature("FLAG") ? a : b`).
 */

import { feature } from "bun:bundle";
import type { BuildTarget, Feature } from "../../types/features.ts";

export interface DashboardRuntimeFlags {
  readonly target: BuildTarget | "unbundled-hmr";
  readonly isProd: boolean;
  readonly isDebug: boolean;
  readonly isTest: boolean;
  readonly isAnalytics: boolean;
  readonly isExperimental: boolean;
  readonly enabledFeatures: readonly Feature[];
  readonly dceMarker: string;
}

export const IS_PROD_BUILD: boolean = feature("PROD") ? true : false;
export const IS_DEBUG_BUILD: boolean = feature("DEBUG") ? true : false;
export const IS_TEST_BUILD: boolean = feature("TEST") ? true : false;
export const IS_ANALYTICS_BUILD: boolean = feature("ANALYTICS") ? true : false;
export const IS_EXPERIMENTAL_BUILD: boolean = feature("EXPERIMENTAL")
  ? true
  : false;

export function getDashboardRuntimeFlags(): DashboardRuntimeFlags {
  const enabled: Feature[] = [];
  let dceMarker = "[DCE_UNBUNDLED_HMR]";

  if (feature("PROD")) {
    enabled.push("PROD");
    dceMarker = "[DCE_PROD_TARGET_ACTIVE]";
  }
  if (feature("DEBUG")) {
    enabled.push("DEBUG");
    dceMarker = "[DCE_DEBUG_TRACE_ACTIVE]";
  }
  if (feature("TEST")) {
    enabled.push("TEST");
  }
  if (feature("ANALYTICS")) {
    enabled.push("ANALYTICS");
  }
  if (feature("EXPERIMENTAL")) {
    enabled.push("EXPERIMENTAL");
    dceMarker = "[DCE_EXPERIMENTAL_MATRIX_ACTIVE]";
  }

  let target: DashboardRuntimeFlags["target"] = "unbundled-hmr";
  if (feature("PROD")) {
    target = "prod";
  } else if (feature("EXPERIMENTAL")) {
    target = "dev";
  } else if (feature("TEST")) {
    target = "test";
  }

  return {
    target,
    isProd: IS_PROD_BUILD,
    isDebug: IS_DEBUG_BUILD,
    isTest: IS_TEST_BUILD,
    isAnalytics: IS_ANALYTICS_BUILD,
    isExperimental: IS_EXPERIMENTAL_BUILD,
    enabledFeatures: enabled,
    dceMarker,
  };
}

/**
 * Feature-flag gate for the typed `SliceMetrics` SoA DataTable + DiffView:
 * enabled in `dev` (`EXPERIMENTAL`) and unbundled HMR by default, gated off in
 * `prod` unless `?sliceMetrics=1` is explicitly supplied.
 */
export function resolveSliceMetricsFeatureDefault(
  searchOverride?: string,
): boolean {
  let rawSearch = searchOverride;
  if (rawSearch === undefined && "location" in globalThis) {
    const loc = (globalThis as { location?: { search?: string } }).location;
    if (loc !== undefined && typeof loc.search === "string") {
      rawSearch = loc.search;
    }
  }
  if (rawSearch !== undefined && rawSearch !== "") {
    const param = new URLSearchParams(rawSearch).get("sliceMetrics");
    if (param === "0" || param === "false") return false;
    if (param === "1" || param === "true") return true;
  }
  if (feature("EXPERIMENTAL")) {
    return true;
  }
  if (feature("PROD")) {
    return false;
  }
  return true;
}

/**
 * Emits debug trace output in `dev`/`test` builds; completely dead-code eliminated in `prod`.
 */
export function debugDashboardTrace(event: string, detail?: unknown): void {
  if (feature("DEBUG")) {
    if (detail !== undefined) {
      console.debug(`[SportsDesk:DEBUG] ${event}`, detail);
    } else {
      console.debug(`[SportsDesk:DEBUG] ${event}`);
    }
  }
}
