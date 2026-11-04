import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import type { F402TickerRow } from "../lib/f402_ingest.ts";
import {
  createDod6SpineOverlay,
  readDod6SpineHeader,
  SHARP_CAND_MIN_CLV_LEGS_V54,
} from "../lib/dod6_spine_overlay.ts";
import { createDod6V54LifetimeReader } from "../lib/dod6_v54_lifetime_reader.ts";
import { parseGsLivePackedWord0 } from "../lib/gslive_packed_words.ts";
import { circuitScoreFromMechanisms } from "../lib/weight_tier_circuit_score.ts";
import {
  loadGsliveSteamIndexFromJson,
  steamFlagsFromTimeUntilScoreSec,
} from "../lib/gslive_steam_index.ts";
import { resolveTickerMarketOffline } from "../lib/weight_tier_market_resolve.ts";
import { planStreamSignalForRow } from "../lib/weight_tier_stream_signals.ts";

const REPO = resolve(import.meta.dir, "..");

describe("DOD6 spine header", () => {
  test("reads v5.4 envelope when dodbin present", () => {
    const header = readDod6SpineHeader(
      resolve(REPO, "data/sportsdesk_unified_baseline_v54.dodbin"),
    );
    if (header === null) return;
    expect(header.magic).toBe("DOD6");
    expect(header.version).toBe(54);
    expect(header.customerCount).toBeGreaterThan(0);
    expect(header.sectionCount).toBe(88);
  });
});

describe("DOD6 v54 columnar lifetime", () => {
  test("GX195 resolves from dodbin radix spine", async () => {
    const reader = await createDod6V54LifetimeReader(
      resolve(REPO, "data/sportsdesk_unified_baseline_v54.dodbin"),
    );
    if (reader === null) return;
    const row = reader.lookup("GX195");
    expect(row).not.toBeNull();
    expect(row!.clvLegs).toBeGreaterThanOrEqual(SHARP_CAND_MIN_CLV_LEGS_V54);
    expect(row!.lifetimeNetUsd).toBeGreaterThan(0);
  });

  test("overlay prefers dodbin columnar over CSV when both provided", async () => {
    const overlay = await createDod6SpineOverlay({
      dodbinPath: resolve(REPO, "data/sportsdesk_unified_baseline_v54.dodbin"),
      lifetimeCsvPath: resolve(
        REPO,
        "tests/fixtures/dod6-lifetime-sample.csv",
      ),
    });
    const row = overlay.lookup("GX195");
    expect(row?.source).toBe("dodbin_columnar");
  });
});

describe("lifetime CSV sharp gate", () => {
  test(`GX195 passes >= ${SHARP_CAND_MIN_CLV_LEGS_V54} CLV leg gate`, async () => {
    const overlay = await createDod6SpineOverlay({
      lifetimeCsvPath: resolve(
        REPO,
        "tests/fixtures/dod6-lifetime-sample.csv",
      ),
    });
    const row = overlay.lookup("GX195");
    expect(row?.sharpCandidateGatePassed).toBe(true);
    expect(row?.clvLegs).toBeGreaterThanOrEqual(SHARP_CAND_MIN_CLV_LEGS_V54);
  });
});

describe("GSLive steam index", () => {
  test("maps ROT 516 to word0 steam mask", async () => {
    const index = await loadGsliveSteamIndexFromJson(
      resolve(REPO, "tests/fixtures/gslive-steam-index.json"),
    );
    const hit = index.lookup("ROT 516");
    expect(hit?.flags.within15s).toBe(true);
    expect(hit?.flags.word0SteamMask & 0x2000).not.toBe(0);
  });

  test("steamFlagsFromTimeUntilScoreSec matches spec bits", () => {
    const flags = steamFlagsFromTimeUntilScoreSec(-3);
    expect(flags.within5s).toBe(true);
    expect(flags.word0SteamMask).toBe(0x6000);
  });

  test("packed word0 sets steam mask bits", () => {
    const parsed = parseGsLivePackedWord0(0x0000_6000n);
    expect(parsed.steamFlags.word0SteamMask).toBe(0x6000);
  });
});

describe("Section 11 circuit proxy", () => {
  test("aggregates mechanism confidences", () => {
    const score = circuitScoreFromMechanisms([
      {
        id: "qk_ov_induction_virtual",
        layer: "test",
        signal: "twin",
        confidenceHundredths: 85,
      },
      {
        id: "bitwise_score_proximity_steam",
        layer: "test",
        signal: "steam",
        confidenceHundredths: 95,
      },
      {
        id: "sentinel_clv_market_split",
        layer: "test",
        signal: "clv",
        confidenceHundredths: 70,
      },
      {
        id: "rank1_reasoning_loop_sla",
        layer: "test",
        signal: "sla",
        confidenceHundredths: 75,
      },
    ]);
    expect(score.scoreHundredths).toBeGreaterThan(80);
    expect(score.inductionHundredths).toBe(85);
  });
});

describe("market resolve + emission", () => {
  test("NFL spread resolves KXNFLSPREAD offline", () => {
    const row: F402TickerRow = {
      login: "GX195",
      customerId: "GX195",
      agentId: "GOLD22",
      agentLogin: "GOLD22",
      ticketWriter: "Internet",
      wagerNumber: "1",
      ticketNumber: "",
      wagerType: "S",
      shortDesc:
        "S.\r\nFootball - Kansas City Chiefs vs Buffalo Bills / Game / Point spread / Kansas City Chiefs -2.5 -110",
      insertedAt: "2026-11-04T18:00:00.000Z",
      vip: "",
      amountWagered: 3500,
      toWinAmount: 3182,
      volumeAmount: 3500,
    };
    const resolved = resolveTickerMarketOffline(row);
    expect(resolved.kalshiSeriesTicker).toBe("KXNFLSPREAD");
    const emission = planStreamSignalForRow(row, { resolveMarkets: true });
    expect(emission?.marketResolve.kalshiSeriesTicker).toBe("KXNFLSPREAD");
    const kalshi = emission?.external.find((o) => o.venue === "kalshi");
    expect(kalshi?.wireDraft._resolve).toBeDefined();
  });
});
