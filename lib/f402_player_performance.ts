/**
 * The customer-admin player-performance read.
 *
 * Observed 2026-11-13: a POST to `/cloud/api/Manager/getPerformancePlayer` with
 * `acc=<customerID>&period=0&operation=getPerformancePlayer&RRO=1&agentID=…&agentOwner=…`,
 * answered by 31 daily rows `{ Date: "11/13/2026 Friday", Won, Lost }`. `Won`/`Lost` are cents
 * (1_500_000 → $15,000.00); the read is the daily P/L series behind the performance tab.
 */

export interface PlayerPerformanceDay {
  /** `MM/DD/YYYY Weekday`, the portal's own label. */
  readonly Date: string;
  readonly Won: number;
  readonly Lost: number;
}

export interface PlayerPerformanceRequest {
  readonly acc: string;
  readonly period: number;
  readonly operation: "getPerformancePlayer";
  readonly RRO: 1;
  readonly agentID: string;
  readonly agentOwner: string;
}

export interface PlayerPerformanceRequestInput {
  readonly acc: string;
  readonly agentID: string;
  readonly agentOwner?: string;
  readonly period?: number;
}

export function buildPerformancePlayerRequest(
  input: PlayerPerformanceRequestInput,
): PlayerPerformanceRequest {
  return {
    acc: input.acc,
    period: input.period ?? 0,
    operation: "getPerformancePlayer",
    RRO: 1,
    agentID: input.agentID,
    agentOwner: input.agentOwner ?? input.agentID,
  };
}

export interface PlayerPerformanceSummary {
  readonly days: number;
  readonly activeDays: number;
  readonly totalWonCents: number;
  readonly totalLostCents: number;
  readonly netCents: number;
}

const DAY_LABEL = /^\d{1,2}\/\d{1,2}\/\d{4}(\s+\p{L}+)?$/u;

/** Parse the array the endpoint returns; throws on a row that would silently become NaN. */
export function parsePlayerPerformancePayload(
  raw: unknown,
): readonly PlayerPerformanceDay[] {
  if (!Array.isArray(raw)) {
    throw new Error("getPerformancePlayer payload must be an array");
  }
  return raw.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new Error(`getPerformancePlayer row ${index} is not an object`);
    }
    const rec = row as Record<string, unknown>;
    if (typeof rec.Date !== "string" || !DAY_LABEL.test(rec.Date.trim())) {
      throw new Error(
        `getPerformancePlayer row ${index} has no MM/DD/YYYY Date label`,
      );
    }
    const won = rec.Won;
    if (typeof won !== "number" || !Number.isFinite(won) || won < 0) {
      throw new Error(
        `getPerformancePlayer row ${index} Won must be a non-negative number`,
      );
    }
    const lost = rec.Lost;
    if (typeof lost !== "number" || !Number.isFinite(lost) || lost < 0) {
      throw new Error(
        `getPerformancePlayer row ${index} Lost must be a non-negative number`,
      );
    }
    return { Date: rec.Date.trim(), Won: won, Lost: lost };
  });
}

export function summarizePlayerPerformance(
  days: readonly PlayerPerformanceDay[],
): PlayerPerformanceSummary {
  let totalWonCents = 0;
  let totalLostCents = 0;
  let activeDays = 0;
  for (const day of days) {
    totalWonCents += day.Won;
    totalLostCents += day.Lost;
    if (day.Won > 0 || day.Lost > 0) activeDays += 1;
  }
  return {
    days: days.length,
    activeDays,
    totalWonCents,
    totalLostCents,
    netCents: totalWonCents - totalLostCents,
  };
}
