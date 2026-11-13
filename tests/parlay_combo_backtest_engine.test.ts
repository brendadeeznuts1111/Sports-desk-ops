import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  runFourWeekParlayComboBacktest,
  type CustomerParlayBacktestRow,
  type FourWeekParlayBacktestReport,
} from "../lib/parlay_combo_backtest_engine.ts";

const enrichedCustomers: Array<{ recent_tickets?: unknown[] }> = existsSync(
  "enriched_customers_full.json",
)
  ? (JSON.parse(readFileSync("enriched_customers_full.json", "utf8")) as Array<{
      recent_tickets?: unknown[];
    }>)
  : [];
const expectedSampledTickets = enrichedCustomers.reduce(
  (sum, customer) => sum + (customer.recent_tickets?.length ?? 0),
  0,
);
const hasFullCustomerBook = enrichedCustomers.length >= 220;
const downlineCounts: {
  provisionedCustomers: number;
  activeSportsBettors: number;
  provisionedSource: "downline-meta" | "snapshot";
} = (() => {
  const defaults = {
    provisionedCustomers: 9_435,
    activeSportsBettors: 2_236,
    provisionedSource: "snapshot" as const,
  };
  if (!existsSync("sportsdesk_downline_data.json")) return defaults;
  try {
    const downline = JSON.parse(
      readFileSync("sportsdesk_downline_data.json", "utf8"),
    ) as {
      meta?: {
        total_provisioned_accounts?: unknown;
        active_sports_bettors?: unknown;
      };
    };
    const provisioned = Number(downline.meta?.total_provisioned_accounts);
    const active = Number(downline.meta?.active_sports_bettors);
    return {
      provisionedCustomers:
        Number.isFinite(provisioned) && provisioned > 0
          ? provisioned
          : defaults.provisionedCustomers,
      activeSportsBettors:
        Number.isFinite(active) && active >= 0
          ? active
          : defaults.activeSportsBettors,
      provisionedSource:
        Number.isFinite(provisioned) && provisioned > 0
          ? "downline-meta"
          : "snapshot",
    };
  } catch {
    return defaults;
  }
})();

describe("4-Week Full-Customer CFB & NBA Parlay & Combo Backtest Engine", () => {
  const report = runFourWeekParlayComboBacktest();

  test("scans the 9,435-account downline, 220 enriched profiles, and 22 valid Polymarket wallets across 4 weeks", () => {
    expect(report.schemaVersion).toBe(1);
    expect(report.totalProvisionedCustomers).toBe(
      downlineCounts.provisionedCustomers,
    );
    expect(report.totalActiveSportsBettors).toBe(
      downlineCounts.activeSportsBettors,
    );
    const expectedMinProfiles =
      enrichedCustomers.length > 0 ? enrichedCustomers.length : 220;
    expect(report.totalEnrichedProfilesScanned).toBeGreaterThanOrEqual(
      expectedMinProfiles,
    );
    expect(report.totalBridgedPolymarketWallets).toBe(22);
    expect(report.weeklyBreakdown.length).toBe(4);
    expect(report.dataBasis.scenarioTicketTotals).toBe(true);
    expect(report.dataBasis.provisionedSource).toBe(
      downlineCounts.provisionedSource,
    );
    expect(report.dataBasis.sampledTickets).toBe(expectedSampledTickets);
  });

  test("reconciles CFB and NBA 4-week ticket, leg, handle, and counterfactual P&L totals", () => {
    expect(report.cfbTotalTickets4Wk).toBe(4085);
    expect(report.nbaTotalTickets4Wk).toBe(3578);
    expect(report.totalParlayTickets4Wk).toBe(7663);
    expect(report.totalParlayLegs4Wk).toBe(17455);
    expect(report.totalParlayHandleUsd4Wk).toBe(4716200);
    expect(report.baselineTotalDeskNetUsd4Wk).toBe(-412380);
    expect(report.protectedTotalDeskNetUsd4Wk).toBe(762280);
    expect(report.totalCounterfactualSavingsUsd4Wk).toBe(1174660);
    expect(report.recreationalRetentionPct).toBeGreaterThanOrEqual(99.0);
  });

  test("populates customer leaderboard with direct Polymarket profile, positions API, and Fantasy402 profile links", () => {
    // enriched_customers_full.json is gitignored (customer data). CI and the 6-customer
    // tracked fixture fall back to featured rows (23); a full 220+ customer book gets 30+.
    expect(report.customerLeaderboard.length).toBeGreaterThanOrEqual(
      hasFullCustomerBook ? 30 : 23,
    );
    const bgd = report.customerLeaderboard.find(
      (c) => c.customerId === "BGD101",
    );
    expect(bgd).toBeDefined();
    expect(bgd?.f402CustomerProfileUrl).toBe(
      "https://fantasy402.com/manager.html?customer=BGD101",
    );
    expect(bgd?.polymarketProfileUrl).toBe(
      "https://polymarket.com/profile/0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    );
    expect(bgd?.polymarketPositionsApiUrl).toBe(
      "https://data-api.polymarket.com/v2/positions?user=0x26cf4a41eb49f0c560d32a2d2e4f45715e47c612",
    );

    const rf = report.customerLeaderboard.find(
      (c) => c.customerId === "RF2003",
    );
    expect(rf).toBeDefined();
    expect(rf?.primaryGuardTriggered).toBe("RECREATIONAL_RETAINED_FLOW");
    expect(rf?.deskSavingsUsd).toBe(0);
  });

  test.if(hasFullCustomerBook)(
    "committed backtest artifact matches the engine output",
    async () => {
      const artifact = (await Bun.file(
        "docs/backtest-4wk-cfb-nba.json",
      ).json()) as Record<string, unknown>;
      const fresh = JSON.parse(JSON.stringify(report)) as Record<
        string,
        unknown
      >;
      delete artifact.generatedAtIso;
      delete artifact.generatedAtCdt;
      delete fresh.generatedAtIso;
      delete fresh.generatedAtCdt;
      expect(fresh).toEqual(artifact);
    },
  );
});

/**
 * The tests above assert the full local book; `enriched_customers_full.json` and
 * `sportsdesk_downline_data.json` are gitignored, so on a clean checkout they
 * degrade to the snapshot constants and the artifact parity test is skipped.
 *
 * The block below drives the same engine from `tests/fixtures/backtest/`
 * (synthetic, committed) so the file-reading paths run in CI too.
 */
const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "backtest");
const GOLDEN_PATH = path.join(
  FIXTURE_DIR,
  "expected-fixture-report.golden.json",
);
const DOCS_ARTIFACT_PATH = path.join(
  import.meta.dirname,
  "..",
  "docs",
  "backtest-4wk-cfb-nba.json",
);

const FIXTURE_CUSTOMER_IDS = [
  "SYNTH_SYN_01",
  "SYNTH_SNIPER_02",
  "SYNTH_REC_03",
  "SYNTH_REC_04",
  "PEY101",
] as const;

/**
 * Artifact fields a fixture-driven run cannot reproduce: the headline counts and
 * `dataBasis` read the gitignored local book, `customerLeaderboard` lists its
 * accounts, and the two timestamps are the generation time.
 */
const LOCAL_BOOK_AND_RUN_FIELDS = [
  "generatedAtIso",
  "generatedAtCdt",
  "totalProvisionedCustomers",
  "totalActiveSportsBettors",
  "totalEnrichedProfilesScanned",
  "dataBasis",
  "customerLeaderboard",
] as const;

const GOLDEN_COMMENT =
  "Generated by tests/parlay_combo_backtest_engine.test.ts from tests/fixtures/backtest/ (synthetic). Timestamps and the scenario constants (weeklyBreakdown, comboFamilyBreakdown, guardAttribution) are omitted; CI pins those against docs/backtest-4wk-cfb-nba.json instead.";

function fixtureLeaderboardRows(
  report: FourWeekParlayBacktestReport,
): CustomerParlayBacktestRow[] {
  return FIXTURE_CUSTOMER_IDS.map((customerId) => {
    const row = report.customerLeaderboard.find(
      (c) => c.customerId === customerId,
    );
    if (!row) throw new Error(`fixture row ${customerId} is missing`);
    return row;
  });
}

function goldenSlice(report: FourWeekParlayBacktestReport) {
  return {
    headline: {
      totalProvisionedCustomers: report.totalProvisionedCustomers,
      totalActiveSportsBettors: report.totalActiveSportsBettors,
      totalEnrichedProfilesScanned: report.totalEnrichedProfilesScanned,
      totalBridgedPolymarketWallets: report.totalBridgedPolymarketWallets,
      customerLeaderboardRows: report.customerLeaderboard.length,
    },
    dataBasis: report.dataBasis,
    fixtureCustomerLeaderboard: fixtureLeaderboardRows(report),
  };
}

type GoldenSlice = ReturnType<typeof goldenSlice>;

describe("4-Week backtest engine — committed synthetic fixture (CI-safe)", () => {
  const report = runFourWeekParlayComboBacktest(FIXTURE_DIR);

  test("reads provisioned, active, and sampled counts from the fixture", () => {
    // 41/7 can only come from the fixture downline; the repo root file is gitignored.
    expect(report.dataBasis.provisionedSource).toBe("downline-meta");
    expect(report.totalProvisionedCustomers).toBe(41);
    expect(report.totalActiveSportsBettors).toBe(7);
    expect(report.totalEnrichedProfilesScanned).toBe(6);
    expect(report.dataBasis.sampledTickets).toBe(9);
    // The duplicate BGD101 row is still sampled, so the window starts on its date.
    expect(report.dataBasis.sampledWindowIso).toEqual([
      "2026-10-03T00:00:00Z",
      "2026-10-30T23:59:00Z",
    ]);
    expect(report.dataBasis.scenarioTicketTotals).toBe(true);
    // Wallets come from the committed CUSTOMER_TO_POLY_WALLET map, not the book.
    expect(report.totalBridgedPolymarketWallets).toBe(22);
    // 23 curated featured accounts + the 5 fixture rows that are not duplicates.
    expect(report.customerLeaderboard.length).toBe(28);
    expect(report.weeklyBreakdown.length).toBe(4);
    expect(report.comboFamilyBreakdown.length).toBe(8);
    expect(report.guardAttribution.length).toBe(6);
  });

  test("derives the sharp branch from net/volume and from CLV", () => {
    const [syn, sniper] = fixtureLeaderboardRows(report);

    // SYNTH_SYN_01: lifetime net/volume = -15% (< -10%) => sharp.
    // avgRisk = 60,000 / 5 = 12,000; CFB tickets = 2 * 4 + 4, NBA = 1 * 4 + 4.
    expect(syn?.cfbParlayTickets).toBe(12);
    expect(syn?.cfbParlayHandleUsd).toBe(144000);
    expect(syn?.cfbBaselineDeskNetUsd).toBe(-31680);
    expect(syn?.cfbProtectedDeskNetUsd).toBe(17280);
    expect(syn?.nbaParlayTickets).toBe(8);
    expect(syn?.nbaParlayHandleUsd).toBe(96000);
    expect(syn?.totalParlayLegs).toBe(46); // round(20 * 2.28)
    expect(syn?.baselineDeskNetUsd).toBe(-54720);
    expect(syn?.protectedDeskNetUsd).toBe(30720);
    expect(syn?.deskSavingsUsd).toBe(85440);
    expect(syn?.baselineHoldPct).toBe(-22.8);
    expect(syn?.protectedHoldPct).toBe(12.8);
    expect(syn?.dominantComboFamily).toBe("CFB_KEY_3_7_10_14_TEASER_MIDDLE");
    expect(syn?.primaryGuardTriggered).toBe("GUARD_4_CORRELATED_SGP_VIG_TAX");
    expect(syn?.masterAgent).toBe("SYNTH_MASTER_01");
    // Empty `placed_at` on the third ticket falls back to the first ticket.
    expect(syn?.lastActiveAt).toBe("2026-10-04T12:00:00Z");

    // SYNTH_SNIPER_02: clv_bps = 120 => sharp even though net/volume is -2%.
    // sports_7d_volume_usd = 0 falls back to 5,000 / 5 = 1,000 per ticket.
    expect(sniper?.cfbParlayTickets).toBe(8);
    expect(sniper?.cfbParlayHandleUsd).toBe(8000);
    expect(sniper?.nbaParlayHandleUsd).toBe(4000); // the NFL ticket is ignored
    expect(sniper?.totalParlayHandleUsd).toBe(12000);
    expect(sniper?.baselineDeskNetUsd).toBe(-2720);
    expect(sniper?.protectedDeskNetUsd).toBe(1520);
    expect(sniper?.deskSavingsUsd).toBe(4240);
    expect(sniper?.masterAgent).toBe("BILLY666"); // master_agent omitted
  });

  test("derives the recreational branch, including null and absent tickets", () => {
    const [, , recNoVolume, recNoTickets] = fixtureLeaderboardRows(report);

    // SYNTH_REC_03: lifetime_volume_usd = 0 => hold is null, so recreational.
    // avgRisk = 12,500 / 5 = 2,500; empty recent_tickets still yields 4 + 4.
    expect(recNoVolume?.cfbParlayTickets).toBe(4);
    expect(recNoVolume?.cfbParlayHandleUsd).toBe(10000);
    expect(recNoVolume?.nbaParlayHandleUsd).toBe(10000);
    expect(recNoVolume?.baselineDeskNetUsd).toBe(5000);
    expect(recNoVolume?.protectedDeskNetUsd).toBe(5000);
    expect(recNoVolume?.deskSavingsUsd).toBe(0);
    expect(recNoVolume?.dominantComboFamily).toBe("REC_MULTI_LEG_PARLAY");
    expect(recNoVolume?.primaryGuardTriggered).toBe(
      "RECREATIONAL_RETAINED_FLOW",
    );

    // SYNTH_REC_04: no `recent_tickets` key at all; avgRisk = 7,500 / 5.
    expect(recNoTickets?.totalParlayTickets).toBe(8);
    expect(recNoTickets?.totalParlayHandleUsd).toBe(12000);
    expect(recNoTickets?.baselineDeskNetUsd).toBe(3000);
    expect(recNoTickets?.deskSavingsUsd).toBe(0);
    expect(recNoTickets?.lastActiveAt).toBe("2026-10-27T20:00:00Z");
  });

  test("links a fixture account to its mapped Polymarket wallet", () => {
    const pey = fixtureLeaderboardRows(report)[4];

    expect(pey?.proxyWallet).toBe("0x55a866f711d987c544e089b677f189d558e666f3");
    expect(pey?.shortWallet).toBe("0x55a8...66f3");
    expect(pey?.polymarketProfileUrl).toBe(
      "https://polymarket.com/profile/0x55a866f711d987c544e089b677f189d558e666f3",
    );
    expect(pey?.polymarketPositionsApiUrl).toBe(
      "https://data-api.polymarket.com/v2/positions?user=0x55a866f711d987c544e089b677f189d558e666f3",
    );
    expect(pey?.f402CustomerProfileUrl).toBe(
      "https://fantasy402.com/manager.html?customer=PEY101",
    );
    expect(pey?.cfbParlayTickets).toBe(4);
    expect(pey?.nbaParlayTickets).toBe(16);
    expect(pey?.totalParlayHandleUsd).toBe(80000);
    expect(pey?.deskSavingsUsd).toBe(29760);
    // Unmapped fixture accounts keep the F402-only shape.
    expect(fixtureLeaderboardRows(report)[0]?.proxyWallet).toBeNull();
    expect(fixtureLeaderboardRows(report)[0]?.polymarketProfileUrl).toBeNull();
  });

  test("ignores a book row that duplicates a curated featured account", () => {
    const duplicates = report.customerLeaderboard.filter(
      (c) => c.customerId === "BGD101",
    );
    expect(duplicates.length).toBe(1);
    expect(duplicates[0]?.agentId).toBe("BIGDAD");
    expect(duplicates[0]?.totalParlayTickets).toBe(62);
    expect(duplicates[0]?.totalParlayHandleUsd).toBe(310000);
    expect(duplicates[0]?.sharpScore).toBe(91.4);
  });

  test("fixture run matches the committed expectation", async () => {
    const slice = goldenSlice(report);
    if (Bun.env.BACKTEST_FIXTURE_UPDATE_GOLDEN === "1") {
      await Bun.write(
        GOLDEN_PATH,
        JSON.stringify({ $comment: GOLDEN_COMMENT, ...slice }, null, 2) + "\n",
      );
    }
    const golden = (await Bun.file(GOLDEN_PATH).json()) as GoldenSlice & {
      $comment?: string;
    };
    delete golden.$comment;
    expect(slice).toEqual(golden);
  });

  test("committed docs artifact matches every file-independent section", async () => {
    const artifact = (await Bun.file(DOCS_ARTIFACT_PATH).json()) as Record<
      string,
      unknown
    >;
    const fresh = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
    for (const key of LOCAL_BOOK_AND_RUN_FIELDS) {
      delete artifact[key];
      delete fresh[key];
    }
    // Weekly rows, combo families, guards, aggregates and hold percentages are
    // scenario constants, so the fixture run reproduces the committed artifact.
    expect(fresh).toEqual(artifact);
  });
});
