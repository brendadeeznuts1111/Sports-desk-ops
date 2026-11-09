/**
 * @file lib/forensic_diagnostic_modes_endpoints.ts
 * @description Cycle-free pre-filtered endpoint bridge for Forensic Diagnostic Modes.
 *
 * Backed by module-init frozen tables. Separated from forensic_diagnostic_modes.ts
 * so mode evaluation engines incur zero cycle risk or per-call bitwise filtering overhead.
 */

import type { DiagnosticModeNumber } from "./forensic_diagnostic_modes.ts";
import {
  AUDITED_ENDPOINTS_CACHE,
  type AuditedEndpointRow,
  type EndpointRole,
} from "./hostname_surface_audit.ts";

export interface ModeEndpointPlan {
  readonly mode: DiagnosticModeNumber;
  readonly allEndpoints: readonly AuditedEndpointRow[];
  readonly sourceEndpoints: readonly AuditedEndpointRow[];
  readonly sinkEndpoints: readonly AuditedEndpointRow[];
  readonly httpsSourceEndpoints: readonly AuditedEndpointRow[];
  readonly wssSourceEndpoints: readonly AuditedEndpointRow[];
  readonly wsSourceEndpoints: readonly AuditedEndpointRow[];
  readonly unixSourceEndpoints: readonly AuditedEndpointRow[];
}

/**
 * Pre-filtered module-init lookup tables for instant index lookup without per-call filtering.
 */
const MODE_ENDPOINTS_TABLE: ReadonlyMap<
  DiagnosticModeNumber,
  readonly AuditedEndpointRow[]
> = (() => {
  const map = new Map<DiagnosticModeNumber, readonly AuditedEndpointRow[]>();
  for (let m = 1; m <= 10; m++) {
    const modeNum = m as DiagnosticModeNumber;
    const bit = 1 << modeNum;
    const matching = AUDITED_ENDPOINTS_CACHE.filter(
      (ep) => (ep.modesMask & bit) !== 0,
    );
    map.set(modeNum, Object.freeze(matching));
  }
  return map;
})();

const MODE_ENDPOINT_PLANS_TABLE: ReadonlyMap<
  DiagnosticModeNumber,
  ModeEndpointPlan
> = (() => {
  const map = new Map<DiagnosticModeNumber, ModeEndpointPlan>();
  for (let m = 1; m <= 10; m++) {
    const modeNum = m as DiagnosticModeNumber;
    const all = MODE_ENDPOINTS_TABLE.get(modeNum) ?? [];
    const sourceEndpoints = Object.freeze(
      all.filter((e) => e.role === "source"),
    );
    const sinkEndpoints = Object.freeze(all.filter((e) => e.role === "sink"));
    const httpsSourceEndpoints = Object.freeze(
      sourceEndpoints.filter((e) => e.connectTransport === "https"),
    );
    const wssSourceEndpoints = Object.freeze(
      sourceEndpoints.filter((e) => e.connectTransport === "wss"),
    );
    const wsSourceEndpoints = Object.freeze(
      sourceEndpoints.filter((e) => e.connectTransport === "ws"),
    );
    const unixSourceEndpoints = Object.freeze(
      sourceEndpoints.filter((e) => e.connectTransport === "unix"),
    );

    const plan: ModeEndpointPlan = Object.freeze({
      mode: modeNum,
      allEndpoints: all,
      sourceEndpoints,
      sinkEndpoints,
      httpsSourceEndpoints,
      wssSourceEndpoints,
      wsSourceEndpoints,
      unixSourceEndpoints,
    });
    map.set(modeNum, plan);
  }
  return map;
})();

/**
 * Returns audited endpoints configured for a given DiagnosticModeNumber.
 * Optionally pre-filtered by endpoint role ('source' | 'sink' | 'doc').
 */
export function getEndpointsForMode(
  mode: DiagnosticModeNumber,
  role?: EndpointRole,
): readonly AuditedEndpointRow[] {
  const endpoints = MODE_ENDPOINTS_TABLE.get(mode) ?? [];
  if (!role) return endpoints;
  return Object.freeze(endpoints.filter((ep) => ep.role === role));
}

/**
 * Returns audited endpoints configured for a bitwise DomainMask.
 * Optionally pre-filtered by endpoint role ('source' | 'sink' | 'doc').
 */
export function getEndpointsForDomainMask(
  mask: number,
  role?: EndpointRole,
): readonly AuditedEndpointRow[] {
  const matching = AUDITED_ENDPOINTS_CACHE.filter(
    (ep) => (ep.modesMask & mask) !== 0,
  );
  if (!role) return Object.freeze(matching);
  return Object.freeze(matching.filter((ep) => ep.role === role));
}

/**
 * Returns the pre-partitioned ModeEndpointPlan for a mode.
 */
export function getModeEndpointPlan(
  mode: DiagnosticModeNumber,
): ModeEndpointPlan {
  const plan = MODE_ENDPOINT_PLANS_TABLE.get(mode);
  if (!plan) {
    throw new Error(`Unrecognized diagnostic mode: ${mode}`);
  }
  return plan;
}
