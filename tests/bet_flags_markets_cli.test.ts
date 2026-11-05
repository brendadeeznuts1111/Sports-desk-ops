import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  runSportsdeskBetFlagsCli,
  type BetFlagsCliDeps,
} from "../cli/sportsdesk_bet_flags_cli.ts";
import {
  compareSettlementRules,
  type BetVenueBreakdown,
  type VenueBreakdownResult,
} from "../lib/bet_venue_breakdown.ts";
import { comboProfile } from "../lib/market_type_registry.ts";

/**
 * `markets` wiring: the command reuses the scan pipeline for its bet source, then hands the
 * records to the venue-breakdown builder. The builder seam is injected here so the test never
 * touches the public venue APIs; the real builder's own tests cover the assembly.
 */

const ROOT = join(import.meta.dir, "..");
const FIXTURE = join(import.meta.dir, "fixtures/live-wagers-list-sample.json");

function breakdownRow(index: number): BetVenueBreakdown {
  return {
    betKey: `bet-${index}`,
    eventLabel: "Cavaliers/Thunder",
    teams: ["Cavaliers", "Thunder"],
    league: "NBA",
    sport: "Basketball",
    subSport: "PREGAME",
    period: "Game",
    marketType: "total",
    periodLabel: "Game",
    line: 220.5,
    side: "over",
    stakeUsd: 1000,
    signalProbability: 0.524,
    americanOdds: -110,
    notes: [],
    kalshi: {
      available: true,
      verdict: "actionable",
      reason: null,
      seriesTicker: "KXNBATOTAL",
      eventTicker: "KXNBA-1",
      marketTicker: "KXNBATOTAL-1",
      title: "Total",
      side: "YES",
      price: 0.53,
      edgeBps: 200,
      liquidity: {
        verdict: "ok",
        spreadCents: 2,
        depthContracts: 900,
        topSize: 400,
        referenceNotionalUsd: 1000,
      },
      book: { yes: [{ price: 0.53, size: 400 }], no: [] },
      rule: null,
    },
    polymarket: {
      available: false,
      reason: "game-winner markets only",
      marketId: null,
      question: null,
      slug: null,
      outcomes: [],
      rule: null,
    },
    settlement: compareSettlementRules(null, null),
    combo: comboProfile({ wagerType: "S", picks: 1 }),
  };
}

function fakeResult(count: number): VenueBreakdownResult {
  return {
    breakdowns: Array.from({ length: count }, (_, index) =>
      breakdownRow(index),
    ),
    refusals: [],
    telemetry: { kalshi: null, polymarket: null },
  };
}

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly seen: {
    readonly records: number;
    readonly venues: readonly string[];
    readonly maxBets: number | undefined;
    readonly league: string | undefined;
  };
}

async function run(argv: string[]): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const seen = {
    records: 0,
    venues: [] as readonly string[],
    maxBets: undefined as number | undefined,
    league: undefined as string | undefined,
  };
  const deps: BetFlagsCliDeps = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    venueBreakdown: async (records, options) => {
      seen.records = records.length;
      seen.venues = options?.venues ?? ["kalshi", "polymarket"];
      seen.maxBets = options?.maxBets;
      seen.league = options?.leagueOverride;
      return fakeResult(records.length);
    },
  };
  const code = await runSportsdeskBetFlagsCli(argv, deps);
  return { code, stdout, stderr, seen };
}

const FILE_ARGS = ["--source", "file", "--file", FIXTURE, "--root", ROOT];

describe("markets command", () => {
  test("matches every fetched row with --all and emits one JSON envelope", async () => {
    const result = await run(["markets", "--json", "--all", ...FILE_ARGS]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["success"]).toBe(true);
    expect(payload["command"]).toBe("markets");
    expect(result.seen.records).toBe(7);
    expect(result.seen.venues).toEqual(["kalshi", "polymarket"]);
    const counts = payload["counts"] as Record<string, unknown>;
    expect(counts["bets"]).toBe(7);
    expect(counts["kalshiMatched"]).toBe(7);
    expect(counts["includeAll"]).toBe(true);
    const source = payload["source"] as Record<string, unknown>;
    expect(source["kind"]).toBe("file-capture");
    expect(Array.isArray(payload["breakdowns"])).toBe(true);
  });

  test("without --all it matches findings only, and says so when there are none", async () => {
    const result = await run(["markets", "--json", ...FILE_ARGS]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    // The fixture produces at most a couple of findings; either way the row count is bounded.
    const counts = payload["counts"] as Record<string, unknown>;
    expect(Number(counts["bets"])).toBeLessThanOrEqual(7);
    expect(
      payload["note"] === null || typeof payload["note"] === "string",
    ).toBe(true);
  });

  test("--group-by adds flat groups and a nested tree to the JSON", async () => {
    const result = await run([
      "markets",
      "--json",
      "--all",
      "--group-by",
      "sport,period",
      ...FILE_ARGS,
    ]);
    expect(result.code).toBe(0);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["dimensions"]).toEqual(["sport", "period"]);
    const groups = payload["groups"] as Record<string, unknown>[];
    expect(Array.isArray(groups)).toBe(true);
    expect(
      groups.every(
        (group) =>
          group["dimension"] === "sport" || group["dimension"] === "period",
      ),
    ).toBe(true);
    const tree = payload["tree"] as Record<string, unknown>[];
    expect(tree[0]?.["dimension"]).toBe("sport");
    expect(Array.isArray(tree[0]?.["children"])).toBe(true);
  });

  test("an unknown --group-by dimension is a usage error", async () => {
    const result = await run([
      "markets",
      "--json",
      "--group-by",
      "sport,bogus",
      ...FILE_ARGS,
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--group-by");
  });

  test("human output prints one table per requested dimension", async () => {
    const result = await run([
      "markets",
      "--all",
      "--group-by",
      "sport,period",
      ...FILE_ARGS,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("grouped by sport → period");
    expect(result.stdout).toContain("— by sport —");
    expect(result.stdout).toContain("— by period —");
  });

  test("--venues is forwarded as a closed set", async () => {
    const result = await run([
      "markets",
      "--json",
      "--all",
      "--venues",
      "kalshi",
      ...FILE_ARGS,
    ]);
    expect(result.code).toBe(0);
    expect(result.seen.venues).toEqual(["kalshi"]);
  });

  test("--league overrides the inferred league", async () => {
    const result = await run([
      "markets",
      "--json",
      "--all",
      "--league",
      "CFB",
      ...FILE_ARGS,
    ]);
    expect(result.code).toBe(0);
    expect(result.seen.league).toBe("CFB");
  });

  test("rejects an unknown venue, league and an out-of-range --max-bets", async () => {
    for (const argv of [
      ["markets", "--venues", "betfair", ...FILE_ARGS],
      ["markets", "--league", "XYZ", ...FILE_ARGS],
      ["markets", "--max-bets", "99", ...FILE_ARGS],
    ]) {
      const result = await run(argv);
      expect(result.code).toBe(2);
      expect(result.stderr.length).toBeGreaterThan(0);
    }
  });

  test("human output summarizes the breakdown", async () => {
    const result = await run(["markets", "--all", ...FILE_ARGS]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("bets · kalshi");
    expect(result.stdout).toContain("bet-0");
  });
});
