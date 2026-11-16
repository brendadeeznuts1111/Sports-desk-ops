import { describe, expect, it } from "bun:test";
import { packSubSportComboKey15 } from "../src/lib/portal_taxonomy_normalizer";
import {
  BROADCAST_SURGE_DISTINCT_THRESHOLD,
  LIVE_BOT_FOLLOW_WINDOW_MS,
  LIVE_WAGER_TYPE_CODE3,
  PREGAME_TIP_CHANNEL_WINDOW_MS,
  REGIME_BIT_BOTH,
  REGIME_BIT_LIVE,
  REGIME_BIT_PREGAME,
  SyndicateTrackerArena,
  classifyWagerRegime,
  computeRegimeLineSig32,
} from "../src/lib/syndicate_bot_detector";
import { SyndicateAdjacencyRollupArena } from "../src/lib/syndicate_adjacency_rollup";

describe("classifyWagerRegime & computeRegimeLineSig32", () => {
  it("classifies LIVE_IN_PLAY via either isGsLiveBridge=true or wagerType3=7", () => {
    const pregameStraightKey = packSubSportComboKey15(3, 0, 0, 0); // NBA | Straight | GAME | SPREAD
    const liveInPlayKey = packSubSportComboKey15(
      3,
      LIVE_WAGER_TYPE_CODE3,
      0,
      0,
    );

    expect(classifyWagerRegime(pregameStraightKey, false)).toBe("PREGAME");
    expect(classifyWagerRegime(pregameStraightKey, true)).toBe("LIVE_IN_PLAY");
    expect(classifyWagerRegime(liveInPlayKey, false)).toBe("LIVE_IN_PLAY");
    expect(classifyWagerRegime(liveInPlayKey, true)).toBe("LIVE_IN_PLAY");
  });

  it("produces price-elastic lineSig32 in LIVE_IN_PLAY and line-sensitive lineSig32 in PREGAME", () => {
    const liveSigA = computeRegimeLineSig32("LIVE_IN_PLAY", 1, 0, -350);
    const liveSigB = computeRegimeLineSig32("LIVE_IN_PLAY", 1, 0, -450);
    const liveSigOppositeSide = computeRegimeLineSig32(
      "LIVE_IN_PLAY",
      2,
      0,
      -350,
    );
    expect(liveSigA).toBe(liveSigB);
    expect(liveSigA).not.toBe(liveSigOppositeSide);

    const pregameSig30 = computeRegimeLineSig32("PREGAME", 1, 0, -300);
    const pregameSig35 = computeRegimeLineSig32("PREGAME", 1, 0, -350);
    expect(pregameSig30).not.toBe(pregameSig35);
  });
});

describe("SyndicateTrackerArena dual-regime detection", () => {
  it("enforces 1,500ms LIVE_IN_PLAY ceiling and survives half-point live tick movement", () => {
    const tracker = new SyndicateTrackerArena(64);
    const nbaLiveSpreadKey = packSubSportComboKey15(
      3,
      LIVE_WAGER_TYPE_CODE3,
      0,
      0,
    );
    const baseMs = 1_763_262_000_000;

    expect(
      tracker.observeWagerLeg(
        5,
        41_209,
        nbaLiveSpreadKey,
        1,
        -350,
        baseMs,
        true,
      ),
    ).toBeNull();

    const followHit = tracker.observeWagerLeg(
      12,
      41_209,
      nbaLiveSpreadKey,
      1,
      -450,
      baseMs + 650,
      true,
    );
    expect(followHit).toEqual({
      leaderCustomerRow: 5,
      followerCustomerRow: 12,
      regime: "LIVE_IN_PLAY",
      regimeBit: REGIME_BIT_LIVE,
      followClass: "LIVE_FEED_BOT",
      followCountU32: 2,
      lagMsU32: 650,
      lastPackedComboKey15: nbaLiveSpreadKey,
    });

    const expiredHit = tracker.observeWagerLeg(
      19,
      41_209,
      nbaLiveSpreadKey,
      1,
      -500,
      baseMs + LIVE_BOT_FOLLOW_WINDOW_MS + 100,
      true,
    );
    expect(expiredHit).toBeNull();
  });

  it("classifies PREGAME API bots (<= 5s) vs Telegram/tip-channel followers (5s..90s) and rejects > 90s", () => {
    const tracker = new SyndicateTrackerArena(64);
    const nflPregameSpreadKey = packSubSportComboKey15(1, 0, 0, 0);
    const baseMs = 1_763_262_100_000;

    expect(
      tracker.observeWagerLeg(
        2,
        50_101,
        nflPregameSpreadKey,
        1,
        -250,
        baseMs,
        false,
      ),
    ).toBeNull();

    const apiBotEdge = tracker.observeWagerLeg(
      7,
      50_101,
      nflPregameSpreadKey,
      1,
      -250,
      baseMs + 2_400,
      false,
    );
    expect(apiBotEdge).toMatchObject({
      leaderCustomerRow: 2,
      followerCustomerRow: 7,
      regime: "PREGAME",
      regimeBit: REGIME_BIT_PREGAME,
      followClass: "PREGAME_API_BOT",
      lagMsU32: 2_400,
    });

    const telegramEdge = tracker.observeWagerLeg(
      14,
      50_101,
      nflPregameSpreadKey,
      1,
      -250,
      baseMs + 42_000,
      false,
    );
    expect(telegramEdge).toMatchObject({
      leaderCustomerRow: 2,
      followerCustomerRow: 14,
      regime: "PREGAME",
      regimeBit: REGIME_BIT_PREGAME,
      followClass: "PREGAME_TIP_CHANNEL",
      lagMsU32: 42_000,
    });

    expect(
      tracker.observeWagerLeg(
        21,
        50_101,
        nflPregameSpreadKey,
        1,
        -300,
        baseMs + 3_000,
        false,
      ),
    ).toBeNull();

    expect(
      tracker.observeWagerLeg(
        28,
        50_101,
        nflPregameSpreadKey,
        1,
        -250,
        baseMs + PREGAME_TIP_CHANNEL_WINDOW_MS + 500,
        false,
      ),
    ).toBeNull();
  });

  it("suppresses TV broadcast-surge recreational pile-ons when > 8 distinct accounts hit a live event within 3,000ms", () => {
    const tracker = new SyndicateTrackerArena(64);
    const liveTotalKey = packSubSportComboKey15(1, LIVE_WAGER_TYPE_CODE3, 0, 1);
    const baseMs = 1_763_262_200_000;

    expect(
      tracker.observeWagerLeg(1, 77_001, liveTotalKey, 1, 4850, baseMs, true),
    ).toBeNull();
    for (let row = 2; row <= BROADCAST_SURGE_DISTINCT_THRESHOLD; row++) {
      const edge = tracker.observeWagerLeg(
        row,
        77_001,
        liveTotalKey,
        1,
        4850,
        baseMs + row * 100,
        true,
      );
      expect(edge).not.toBeNull();
    }
    expect(tracker.broadcastSurgeSuppressedCount).toBe(0);

    expect(
      tracker.observeWagerLeg(
        9,
        77_001,
        liveTotalKey,
        1,
        4850,
        baseMs + 950,
        true,
      ),
    ).toBeNull();
    expect(
      tracker.observeWagerLeg(
        10,
        77_001,
        liveTotalKey,
        1,
        4850,
        baseMs + 1_050,
        true,
      ),
    ).toBeNull();
    expect(tracker.broadcastSurgeSuppressedCount).toBe(2);
  });

  it("tracks sub-second bot burst cadence and SWAR popcount market breadth accurately", () => {
    const tracker = new SyndicateTrackerArena(32);
    const baseMs = 1_763_262_300_000;

    const key1 = packSubSportComboKey15(1, 0, 0, 0);
    const key2 = packSubSportComboKey15(3, 0, 1, 1);
    const key3 = packSubSportComboKey15(18, 7, 14, 2);

    tracker.observeWagerLeg(4, 1001, key1, 1, -110, baseMs, false);
    tracker.observeWagerLeg(4, 1002, key2, 1, 21050, baseMs + 120, false);
    tracker.observeWagerLeg(4, 1003, key3, 2, 0, baseMs + 300, true);
    tracker.observeWagerLeg(4, 1004, key1, 2, -110, baseMs + 4_000, false);

    const metrics = tracker.getBotCadenceMetrics(4);
    expect(metrics.totalTickets).toBe(4);
    expect(metrics.subSecondBurstRatio).toBe(0.5);
    expect(metrics.distinctMarketKeys).toBe(3);
  });
});

describe("SyndicateAdjacencyRollupArena 2-bit regimeMask & CSR classification", () => {
  it("classifies PREGAME_ONLY, LIVE_ONLY, and DUAL_REGIME rings with ORIGIN_LEADER -> BRIDGE_RELAY -> COPY_FOLLOWER roles", () => {
    const tracker = new SyndicateTrackerArena(64);
    const rollup = new SyndicateAdjacencyRollupArena(64, 256);
    const baseMs = 1_763_262_400_000;

    const pregameKey = packSubSportComboKey15(1, 0, 0, 0);
    const liveKey = packSubSportComboKey15(3, LIVE_WAGER_TYPE_CODE3, 0, 0);

    for (let round = 0; round < 2; round++) {
      const t = baseMs + round * 200_000;
      const evPregame = 80_000 + round;
      tracker.observeWagerLeg(1, evPregame, pregameKey, 1, -300, t, false);
      const e12Pre = tracker.observeWagerLeg(
        2,
        evPregame,
        pregameKey,
        1,
        -300,
        t + 1_200,
        false,
      )!;
      rollup.recordFollowEdge(e12Pre);

      const evLive = 90_000 + round;
      tracker.observeWagerLeg(2, evLive, liveKey, 2, -150, t + 5_000, true);
      const e23Live = tracker.observeWagerLeg(
        3,
        evLive,
        liveKey,
        2,
        -200,
        t + 5_400,
        true,
      )!;
      rollup.recordFollowEdge(e23Live);
    }

    for (let round = 0; round < 2; round++) {
      const t = baseMs + round * 50_000;
      const ev = 95_000 + round;
      tracker.observeWagerLeg(10, ev, liveKey, 1, 1050, t, true);
      const e1011 = tracker.observeWagerLeg(
        11,
        ev,
        liveKey,
        1,
        1100,
        t + 320,
        true,
      )!;
      rollup.recordFollowEdge(e1011);
    }

    for (let round = 0; round < 2; round++) {
      const t = baseMs + round * 300_000;
      const ev = 70_000 + round;
      tracker.observeWagerLeg(20, ev, pregameKey, 2, 700, t, false);
      const e2021 = tracker.observeWagerLeg(
        21,
        ev,
        pregameKey,
        2,
        700,
        t + 18_000,
        false,
      )!;
      rollup.recordFollowEdge(e2021);
    }

    expect(rollup.edgeCount).toBe(4);
    const allRings = rollup.extractTopSyndicateRings(2, 10);
    expect(allRings).toHaveLength(3);

    const dualRing = allRings[0]!;
    expect(dualRing.ringIdU32).toBe(1);
    expect(dualRing.regimeScope).toBe("DUAL_REGIME");
    expect(dualRing.regimeMask).toBe(REGIME_BIT_BOTH);
    expect(dualRing.totalFollowHitsU32).toBe(4);
    expect(dualRing.fastestReactionMsU32).toBe(400);
    expect(dualRing.members).toEqual([
      {
        customerRow: 1,
        role: "ORIGIN_LEADER",
        outboundFollowsU32: 2,
        inboundFollowsU32: 0,
        minInboundLagMsU32: 0,
        regimeMask: REGIME_BIT_PREGAME,
      },
      {
        customerRow: 2,
        role: "BRIDGE_RELAY",
        outboundFollowsU32: 2,
        inboundFollowsU32: 2,
        minInboundLagMsU32: 1_200,
        regimeMask: REGIME_BIT_BOTH,
      },
      {
        customerRow: 3,
        role: "COPY_FOLLOWER",
        outboundFollowsU32: 0,
        inboundFollowsU32: 2,
        minInboundLagMsU32: 400,
        regimeMask: REGIME_BIT_LIVE,
      },
    ]);

    const liveOnlyFilter = rollup.extractTopSyndicateRings(
      2,
      10,
      REGIME_BIT_LIVE,
    );
    expect(liveOnlyFilter).toHaveLength(2);
    expect(
      liveOnlyFilter.every((r) => (r.regimeMask & REGIME_BIT_LIVE) !== 0),
    ).toBe(true);
    const pureLiveRing = liveOnlyFilter.find((r) => r.ringIdU32 === 10)!;
    expect(pureLiveRing.regimeScope).toBe("LIVE_ONLY");
    expect(pureLiveRing.regimeMask).toBe(REGIME_BIT_LIVE);

    const pregameOnlyFilter = rollup.extractTopSyndicateRings(
      2,
      10,
      REGIME_BIT_PREGAME,
    );
    expect(pregameOnlyFilter).toHaveLength(2);
    const purePregameRing = pregameOnlyFilter.find((r) => r.ringIdU32 === 20)!;
    expect(purePregameRing.regimeScope).toBe("PREGAME_ONLY");
    expect(purePregameRing.regimeMask).toBe(REGIME_BIT_PREGAME);
  });

  it("resets all CSR and regimeMask columns cleanly in-place via resetInPlace()", () => {
    const rollup = new SyndicateAdjacencyRollupArena(16, 64);
    rollup.recordFollowRaw(1, 2, 450, 0x0600, REGIME_BIT_LIVE);
    rollup.recordFollowRaw(1, 2, 12_000, 0x0600, REGIME_BIT_PREGAME);

    expect(rollup.compactToCsr()).toBe(1);
    expect(rollup.csrRegimeMaskU8Col[0]).toBe(REGIME_BIT_BOTH);

    rollup.resetInPlace();
    expect(rollup.edgeCount).toBe(0);
    expect(rollup.compactToCsr()).toBe(0);
    expect(rollup.csrRegimeMaskU8Col[0]).toBe(0);
  });
});
