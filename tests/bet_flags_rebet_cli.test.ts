import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runSportsdeskBetFlagsCli,
  type BetFlagsCliDeps,
} from "../cli/sportsdesk_bet_flags_cli.ts";
import {
  compareSettlementRules,
  type BetVenueBreakdown,
} from "../lib/bet_venue_breakdown.ts";
import { comboProfile } from "../lib/market_type_registry.ts";

const FIXTURE = join(import.meta.dir, "fixtures/live-wagers-list-sample.json");

function breakdownRow(kalshiPrice: number): BetVenueBreakdown {
  return {
    betKey: `bet-${kalshiPrice}`,
    eventLabel: "Cavaliers/Thunder",
    teams: ["Cavaliers", "Thunder"],
    league: "NBA",
    sport: "Basketball",
    subSport: "Winner (2 way)",
    period: "Game",
    marketType: "moneyline",
    periodLabel: "Game",
    line: null,
    side: "Cavaliers",
    stakeUsd: 100,
    signalProbability: 0.524,
    americanOdds: -110,
    notes: [],
    kalshi: {
      available: true,
      verdict: "actionable",
      reason: null,
      seriesTicker: "KXNBAGAME",
      eventTicker: "KXNBA-1",
      marketTicker: "KXNBAGAME-1-CLE",
      title: "Cavaliers win",
      side: "YES",
      price: kalshiPrice,
      edgeBps: 0,
      liquidity: null,
      book: {
        yes: [{ price: kalshiPrice, size: 100 }],
        no: [{ price: 1 - kalshiPrice, size: 100 }],
      },
      rule: null,
    },
    polymarket: {
      available: true,
      reason: null,
      marketId: "poly-1",
      question: "Cavaliers vs. Thunder",
      slug: "nba-cle-okc",
      outcomes: [
        {
          name: "Cavaliers",
          bestBid: 0.42,
          bestAsk: 0.44,
          spread: 0.02,
          bidDepthUsd: 10,
          askDepthUsd: 10,
        },
      ],
      rule: null,
    },
    settlement: compareSettlementRules(null, null),
    combo: comboProfile({ wagerType: "S", picks: 1 }),
  };
}

async function run(argv: string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  const deps: BetFlagsCliDeps = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    venueBreakdown: async () => ({
      breakdowns: [breakdownRow(0.45), breakdownRow(0.62)],
      refusals: [],
      telemetry: { kalshi: null, polymarket: null },
    }),
  };
  const code = await runSportsdeskBetFlagsCli(argv, deps);
  return { code, stdout, stderr };
}

function payloadOf(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("expected one JSON object");
  }
  return parsed as Record<string, unknown>;
}

describe("rebet command", () => {
  test("finds better-price opportunities, writes paper ledger, and dedupes", async () => {
    const root = mkdtempSync(join(tmpdir(), "rebet-cli-"));
    const argv = [
      "rebet",
      "--json",
      "--source",
      "file",
      "--file",
      FIXTURE,
      "--root",
      root,
      "--paper",
    ];
    const first = await run(argv);
    expect(first.code).toBe(0);
    const payload = payloadOf(first.stdout);
    expect(payload["command"]).toBe("rebet");
    const counts = payload["counts"] as Record<string, unknown>;
    expect(counts["bets"]).toBe(2);
    expect(Number(counts["opportunities"])).toBeGreaterThanOrEqual(2);
    expect(Number(counts["recorded"])).toBeGreaterThanOrEqual(2);
    // Detection records PENDING opportunities; no fill is written until approval.
    expect(counts["fills"]).toBeUndefined();
    const opportunities = payload["opportunities"] as Array<
      Record<string, unknown>
    >;
    // The 0.45 row clears a taker edge; the 0.62 row must not.
    expect(
      opportunities.some(
        (opportunity) =>
          opportunity["venue"] === "kalshi" &&
          opportunity["style"] === "taker" &&
          Number(opportunity["edgeBps"]) > 0,
      ),
    ).toBe(true);
    expect(
      opportunities.some(
        (opportunity) =>
          opportunity["betKey"] === "bet-0.62" &&
          opportunity["venue"] === "kalshi" &&
          opportunity["style"] === "taker",
      ),
    ).toBe(false);

    const second = await run(argv);
    expect(second.code).toBe(0);
    const secondCounts = payloadOf(second.stdout)["counts"] as Record<
      string,
      unknown
    >;
    expect(secondCounts["recorded"]).toBe(0);
    expect(Number(secondCounts["skipped"])).toBeGreaterThan(0);

    // Operator approval turns the first pending opportunity into a simulated paper fill.
    const firstOpp = opportunities[0] as { id?: string; style?: string };
    expect(typeof firstOpp.id).toBe("string");
    const approve = await run([
      "rebet",
      "--json",
      "--approve",
      firstOpp.id as string,
      "--actor",
      "alice",
      "--root",
      root,
    ]);
    expect(approve.code).toBe(0);
    const approved = payloadOf(approve.stdout) as {
      decision?: { status?: string; actor?: string };
      fill?: { status?: string } | null;
    };
    expect(approved.decision?.status).toBe("approved");
    expect(approved.decision?.actor).toBe("alice");
    expect(approved.fill?.status).toBe("simulated");

    // A second decision on the same opportunity is refused.
    const again = await run([
      "rebet",
      "--json",
      "--approve",
      firstOpp.id as string,
      "--actor",
      "alice",
      "--root",
      root,
    ]);
    expect(again.code).not.toBe(0);

    // Rejecting needs a reason, and lands as rejected.
    const secondOpp = opportunities[1] as { id?: string };
    expect(typeof secondOpp.id).toBe("string");
    const rejectNoReason = await run([
      "rebet",
      "--json",
      "--reject",
      secondOpp.id as string,
      "--actor",
      "bob",
      "--root",
      root,
    ]);
    expect(rejectNoReason.code).not.toBe(0);
    const reject = await run([
      "rebet",
      "--json",
      "--reject",
      secondOpp.id as string,
      "--actor",
      "bob",
      "--reason",
      "price moved",
      "--root",
      root,
    ]);
    expect(reject.code).toBe(0);
    expect(
      (payloadOf(reject.stdout) as { decision?: { status?: string } }).decision
        ?.status,
    ).toBe("rejected");

    const listed = await run(["rebet", "--json", "--list", "--root", root]);
    expect(listed.code).toBe(0);
    const listPayload = payloadOf(listed.stdout) as {
      counts?: Record<string, number>;
    };
    expect(Number(listPayload.counts?.["approved"])).toBe(1);
    expect(Number(listPayload.counts?.["rejected"])).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  test("--style restricts the evaluated styles", async () => {
    const root = mkdtempSync(join(tmpdir(), "rebet-style-"));
    const result = await run([
      "rebet",
      "--json",
      "--source",
      "file",
      "--file",
      FIXTURE,
      "--root",
      root,
      "--style",
      "taker",
    ]);
    expect(result.code).toBe(0);
    const opportunities = payloadOf(result.stdout)["opportunities"] as Array<
      Record<string, unknown>
    >;
    expect(
      opportunities.every((opportunity) => opportunity["style"] === "taker"),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  test("rejects an unknown style", async () => {
    const result = await run([
      "rebet",
      "--source",
      "file",
      "--file",
      FIXTURE,
      "--style",
      "limit",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--style");
  });

  test("--watch with --max-ticks runs the automation loop and stops", async () => {
    const root = mkdtempSync(join(tmpdir(), "rebet-watch-"));
    const result = await run([
      "rebet",
      "--json",
      "--watch",
      "--max-ticks",
      "1",
      "--source",
      "file",
      "--file",
      FIXTURE,
      "--root",
      root,
      "--paper",
    ]);
    expect(result.code).toBe(0);
    const lines = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0]!) as {
      command?: string;
      tick?: number;
      counts?: Record<string, unknown>;
    };
    expect(payload.command).toBe("rebet");
    expect(payload.tick).toBe(1);
    expect(Number(payload.counts?.["recorded"])).toBeGreaterThan(0);
    rmSync(root, { recursive: true, force: true });
  });

  test("human output summarizes opportunities and rejections", async () => {
    const root = mkdtempSync(join(tmpdir(), "rebet-human-"));
    const result = await run([
      "rebet",
      "--source",
      "file",
      "--file",
      FIXTURE,
      "--root",
      root,
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("rebet:");
    expect(result.stdout).toContain("rejections:");
    rmSync(root, { recursive: true, force: true });
  });
});
