/**
 * @file packages/backend/src/parsers.ts
 * @description Query parameter and auth-gate helpers shared by the dashboard backend and API.
 */

import type {
  RouterAuditMode,
  ShadowRepriceMode,
} from "@sportsdesk-ops/contracts";

export type DashboardRepriceMode = ShadowRepriceMode;
export type DashboardRouterAuditMode = RouterAuditMode;

/** Parse a query string value into a finite number, or `undefined`. */
export function parseFiniteNumber(
  raw: string | null | undefined,
): number | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Parse a shadow reprice mode query/body value (`floor` | `exact`). */
export function parseRepriceMode(
  raw: string | null | undefined,
): DashboardRepriceMode | undefined {
  if (raw === "floor" || raw === "exact") return raw;
  return undefined;
}

/** Parse a shadow router audit mode query/body value. */
export function parseRouterAuditMode(
  raw: string | null | undefined,
): DashboardRouterAuditMode | undefined {
  if (raw === "observed_ledger" || raw === "enforced_lockout") return raw;
  return undefined;
}

/** Determine whether dashboard API auth is required for the current environment. */
export function isDashboardAuthRequired(
  env: Record<string, string | undefined> = Bun.env,
): boolean {
  return env.NODE_ENV === "production"
    ? env.SPORTSDESK_AUTH_DISABLED !== "1"
    : env.SPORTSDESK_AUTH_REQUIRED === "1";
}
