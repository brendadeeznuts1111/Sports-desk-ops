/**
 * Post-ingest filters for analyze: accounts, sports, and minimum stake.
 * Book-wide pull endpoints cannot apply these on the wire, so they run here.
 */

import {
  F402AnalyzeError,
  type PullProjection,
} from "./f402_analyze_ingest.ts";

export interface AnalyzeFilters {
  readonly accounts?: readonly string[];
  readonly sports?: readonly string[];
  readonly minStake?: number;
}

export function parseAccountList(raw: string, flag = "--accounts"): string[] {
  const parts = [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((part) => part.trim())
        .filter((part) => part !== ""),
    ),
  ];
  if (parts.length === 0) {
    throw new F402AnalyzeError(
      "config",
      "filter",
      `${flag} needs at least one id`,
    );
  }
  return parts;
}

export function parseSportsList(raw: string): string[] {
  return parseAccountList(raw, "--sports");
}

export function parseMinStake(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new F402AnalyzeError(
      "config",
      "filter",
      "--min-stake must be a number >= 0 (dollars, or cents if the wager is in cents)",
    );
  }
  return n;
}

function stakeMeetsMin(amountWagered: number, minStake: number): boolean {
  if (!Number.isFinite(amountWagered)) return false;
  if (amountWagered >= minStake) return true;
  if (Math.round(amountWagered / 100) >= minStake) return true;
  return false;
}

function allowAccount(id: string, allow: ReadonlySet<string> | null): boolean {
  if (allow === null) return true;
  return allow.has(id.trim().toLowerCase());
}

export function filterProjection(
  projection: PullProjection,
  filters: AnalyzeFilters = {},
): PullProjection {
  const accountAllow =
    filters.accounts !== undefined && filters.accounts.length > 0
      ? new Set(filters.accounts.map((id) => id.trim().toLowerCase()))
      : null;
  const sportsAllow =
    filters.sports !== undefined && filters.sports.length > 0
      ? new Set(filters.sports.map((s) => s.trim().toLowerCase()))
      : null;
  const minStake = filters.minStake;

  const accounts = projection.accounts.filter(
    (row) =>
      allowAccount(row.accountId, accountAllow) ||
      allowAccount(row.login, accountAllow),
  );
  const keep = new Set(
    accounts.flatMap((row) => [
      row.accountId.toLowerCase(),
      row.login.toLowerCase(),
    ]),
  );
  const ledger = projection.ledger.filter((row) =>
    keep.has(row.accountId.toLowerCase()),
  );
  const weblog = projection.weblog.filter((row) =>
    keep.has(row.loginId.toLowerCase()),
  );
  const wagers = projection.wagers.filter((row) => {
    if (!keep.has(row.accountId.toLowerCase())) return false;
    if (sportsAllow !== null) {
      const sport = row.sport.trim().toLowerCase();
      const legHit = row.legs.some((leg) =>
        sportsAllow.has(leg.sport.trim().toLowerCase()),
      );
      if (!sportsAllow.has(sport) && !legHit) return false;
    }
    if (minStake !== undefined && !stakeMeetsMin(row.amountWagered, minStake)) {
      return false;
    }
    return true;
  });
  const censusSnapshots = (projection.censusSnapshots ?? []).filter(
    (row) =>
      allowAccount(row.accountId, accountAllow) ||
      allowAccount(row.login, accountAllow),
  );
  return {
    ...projection,
    accounts,
    ledger,
    weblog,
    wagers,
    censusSnapshots,
  };
}
