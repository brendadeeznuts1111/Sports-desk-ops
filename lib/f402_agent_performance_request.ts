/**
 * @file f402_agent_performance_request.ts
 * @description Builds the form body the portal's agent-performance screen sends.
 *
 * The shape comes from two observed requests (2026-11-01), recorded in
 * `tests/fixtures/f402-report-requests-observed-2026-11-01.json`:
 *
 *   start=M/D/YYYY & end=M/D/YYYY & agentID & type=CP & freePlay=Y & store & sport
 *   & subsport & period & wagerType & betType & tipo=0 & debug=0
 *   & operation=getAgentPerformance & RRO=1 & agentOwner
 *
 * Everything that is easy to get subtly wrong is pinned here rather than left to a caller:
 *
 *  - `sport` is **padded to 20 characters** with spaces. The wire carries `Football` + 12 spaces;
 *    trimming it produces a different request.
 *  - `subsport` is a catalog **code** (`NFL`, `CFL RSW`, …), not a number and not the display name.
 *  - `period` is the catalog's number for that sport, so `1` means `1st Half` under Football and
 *    something else elsewhere; `-1` means all periods in the observed all-periods call.
 *  - `subsport`, `wagerType` and `betType` are **always present**, empty when unfiltered.
 *  - `tipo` is **not** constant: CP sent `0` and CPS sent `-1`.
 *  - `wagerType`/`betType` values are passed through untouched. `M` has no documented meaning in
 *    this repo, so this module never maps a code to a name.
 *
 * What this module deliberately cannot do: describe a response. No response for this operation has
 * ever been observed, so there is no schema here to be wrong about.
 */

import type { AnalysisReport } from "./analysis_filters.ts";
import { ANALYSIS_REPORTS } from "./analysis_filters.ts";
import {
  findSubSport,
  periodsFor,
  type SportCatalogFile,
} from "./sport_catalog.ts";

import { SPORT_FIELD_WIDTH, padField } from "./f402_field_widths.ts";

/** The portal pads `sport` to this width with spaces; 20 is measured, not guessed. */
export { SPORT_FIELD_WIDTH };

/** Fixed in every observed request. */
const OPERATION = "getAgentPerformance";
const RRO = "1";
const DEBUG = "0";

/** `tipo` when the caller does not specify one: CP's observed value. */
export const DEFAULT_TIPO = 0;

/** `-1` is what the all-periods call sends. */
export const ALL_PERIODS = -1;

export type FreePlayFlag = "Y" | "N";

export interface AgentPerformanceSelection {
  /** `M/D/YYYY`, as the portal sends it. */
  readonly start: string;
  /** `M/D/YYYY`; must not be before `start`. */
  readonly end: string;
  readonly agentId: string;
  readonly report: AnalysisReport;
  readonly freePlay: FreePlayFlag;
  /** Defaults to `agentId`. */
  readonly store?: string;
  /** Defaults to `agentId`; the portal sends it on every observed call. */
  readonly agentOwner?: string;
  /** Unpadded sport name, e.g. `Football`. Padded on the wire. */
  readonly sport: string;
  /** Catalog sub-sport code, e.g. `NFL`. Omitted or empty means unfiltered. */
  readonly subSport?: string;
  /** Catalog period number for `sport`, or {@link ALL_PERIODS}. Defaults to all periods. */
  readonly period?: number;
  /** Raw `WagerType` code (`M`, `S`, `P`, …) — never translated. */
  readonly wagerType?: string;
  /** Raw bet-type code, passed through. */
  readonly betType?: string;
  /**
   * Portal `tipo` value. Observed as `0` for CP and `-1` for CPS, so it is a field of the
   * selection rather than a literal. Defaults to {@link DEFAULT_TIPO}.
   */
  readonly tipo?: number;
}

export interface BuiltAgentPerformanceRequest {
  /** The form-urlencoded body, byte-identical to what the portal sends. */
  readonly body: string;
  /** The same fields, in wire order, before encoding. */
  readonly fields: readonly (readonly [string, string])[];
  /** `sport` after padding — 20 characters. */
  readonly sportPadded: string;
  /** True when the catalog verified `sport`, `subSport` and `period`. */
  readonly catalogChecked: boolean;
}

const DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/** Parses `M/D/YYYY` into a sortable key without going through a timezone-sensitive Date. */
function dateKey(value: string, field: "start" | "end"): string {
  const match = DATE_PATTERN.exec(value.trim());
  if (match === null) {
    throw new Error(`${field} must be M/D/YYYY, got "${value}"`);
  }
  const [, month, day, year] = match;
  return `${year}${(month ?? "").padStart(2, "0")}${(day ?? "").padStart(2, "0")}`;
}

function isReport(value: string): value is AnalysisReport {
  return ANALYSIS_REPORTS.some((entry) => entry.value === value);
}

/**
 * Pads `sport` to the portal's field width.
 *
 * A sport already at the width is returned unchanged; a longer one is an error rather than a silent
 * truncation, because either way the request would not be the one the portal sends.
 */
export function padSportField(sport: string): string {
  const trimmed = sport.trim();
  if (trimmed === "") throw new Error("sport is required");
  if (trimmed.length > SPORT_FIELD_WIDTH) {
    throw new Error(
      `sport "${trimmed}" is ${trimmed.length} characters; the portal's field holds ${SPORT_FIELD_WIDTH}`,
    );
  }
  return padField(trimmed, SPORT_FIELD_WIDTH);
}

/**
 * Builds the request the agent-performance screen sends for one selection.
 *
 * Pass `catalog` to have `sport`/`subSport`/`period` checked against the captured catalog. Without
 * it the body is still built, and `catalogChecked` says the values were not verified.
 */
export function buildAgentPerformanceRequest(
  selection: AgentPerformanceSelection,
  options?: { readonly catalog?: SportCatalogFile | null },
): BuiltAgentPerformanceRequest {
  const startKey = dateKey(selection.start, "start");
  const endKey = dateKey(selection.end, "end");
  if (startKey > endKey) {
    throw new Error(`start ${selection.start} is after end ${selection.end}`);
  }

  const agentId = selection.agentId.trim();
  if (agentId === "") throw new Error("agentId is required");

  if (!isReport(selection.report)) {
    throw new Error(
      `unknown report kind "${selection.report}"; expected one of ${ANALYSIS_REPORTS.map((entry) => entry.value).join("/")}`,
    );
  }

  if (selection.freePlay !== "Y" && selection.freePlay !== "N") {
    throw new Error(`freePlay must be Y or N, got "${selection.freePlay}"`);
  }

  const sportPadded = padSportField(selection.sport);
  const subSport = (selection.subSport ?? "").trim();
  const period = selection.period ?? ALL_PERIODS;
  if (!Number.isInteger(period)) {
    throw new Error(
      `period must be an integer, got ${String(selection.period)}`,
    );
  }

  const tipo = selection.tipo ?? DEFAULT_TIPO;
  if (!Number.isInteger(tipo)) {
    throw new Error(`tipo must be an integer, got ${String(selection.tipo)}`);
  }

  const catalog = options?.catalog ?? null;
  let catalogChecked = false;
  if (catalog !== null) {
    const sportName = sportPadded.trim();
    if (!catalog.sports.some((entry) => entry.sport === sportName)) {
      throw new Error(
        `unknown sport "${sportName}" (not in the captured catalog)`,
      );
    }
    if (
      subSport !== "" &&
      findSubSport(catalog, sportName, subSport) === null
    ) {
      throw new Error(
        `sub-sport "${subSport}" is not one of ${sportName}'s catalog codes`,
      );
    }
    if (period !== ALL_PERIODS) {
      const known = periodsFor(catalog, sportName).some(
        (entry) => entry.number === period,
      );
      if (!known) {
        throw new Error(
          `period ${period} is not in ${sportName}'s period menu (use ${ALL_PERIODS} for all periods)`,
        );
      }
    }
    catalogChecked = true;
  }

  const fields: (readonly [string, string])[] = [
    ["start", selection.start.trim()],
    ["end", selection.end.trim()],
    ["agentID", agentId],
    ["type", selection.report],
    ["freePlay", selection.freePlay],
    ["store", (selection.store ?? agentId).trim()],
    ["sport", sportPadded],
    ["subsport", subSport],
    ["period", String(period)],
    ["wagerType", (selection.wagerType ?? "").trim()],
    ["betType", (selection.betType ?? "").trim()],
    ["tipo", String(tipo)],
    ["debug", DEBUG],
    ["operation", OPERATION],
    ["RRO", RRO],
    ["agentOwner", (selection.agentOwner ?? agentId).trim()],
  ];

  return {
    body: new URLSearchParams(fields as [string, string][]).toString(),
    fields,
    sportPadded,
    catalogChecked,
  };
}
