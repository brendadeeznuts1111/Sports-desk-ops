/** Route threshold rows from tokens.toml → TS literal for ROUTE_CIRCUITS. */

export type { RouteThresholdKind, RouteThresholdRow } from "./tokens_ssot.ts";
import {
  ROUTE_THRESHOLD_KINDS,
  type RouteThresholdKind,
  type RouteThresholdRow,
} from "./tokens_ssot.ts";

function isRouteThresholdKind(k: string): k is RouteThresholdKind {
  return (ROUTE_THRESHOLD_KINDS as readonly string[]).includes(k);
}

export function formatRouteThreshold(row: RouteThresholdRow): string {
  const kind = row.threshold_kind;
  if (!isRouteThresholdKind(kind)) {
    throw new Error(
      `[gen:tokens] unknown route threshold_kind ${JSON.stringify(kind)}`,
    );
  }
  switch (kind) {
    case "consensus_lag":
      return `{ kind: "consensus_lag", maxLagMs: ${row.max_lag_ms} }`;
    case "bayes_shrinkage":
      return `{ kind: "bayes_shrinkage", tauStarBasisPoints: parseAsBasisPoints(${row.tau_star_basis_points}, true), minTickets: ${row.min_tickets} }`;
    case "liquidity_depth":
      return `{ kind: "liquidity_depth", minDepthCents: parseAsCents(${row.min_depth_cents}) }`;
    case "composite_risk_gate":
      return `{ kind: "composite_risk_gate", minToxicityScore: ${row.min_toxicity_score}, maxHoldRateBasisPoints: parseAsBasisPoints(${row.max_hold_rate_basis_points}, true), maxDeficitCents: parseAsCents(${row.max_deficit_cents}) }`;
  }
}
