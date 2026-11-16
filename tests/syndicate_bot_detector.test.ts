import { describe, expect, test } from "bun:test";
import {
  SyndicateTrackerArena,
  type SyndicateFollowEdge,
} from "../src/lib/syndicate_bot_detector.ts";
import { packSubSportComboKey15 } from "../src/lib/portal_taxonomy_normalizer.ts";

const key = (subSport = 1, wagerType = 0, period = 0, marketKind = 0) =>
  packSubSportComboKey15(subSport, wagerType, period, marketKind);

function edgeOf(edge: SyndicateFollowEdge | null): SyndicateFollowEdge {
  if (edge === null) throw new Error("expected a follow edge");
  return { ...edge };
}

describe("SyndicateTrackerArena", () => {
  test("first account leads; later accounts on the same tuple become directed edges", () => {
    const arena = new SyndicateTrackerArena(8);
    const k = key(1);
    expect(arena.observeWagerLeg(1, 42, k, 7, 1_000)).toBeNull();

    const first = edgeOf(arena.observeWagerLeg(2, 42, k, 7, 3_000));
    expect(first.leaderCustomerRow).toBe(1);
    expect(first.followerCustomerRow).toBe(2);
    expect(first.followCountU32).toBe(1);
    expect(first.avgLagMsU32).toBe(2_000);

    const second = edgeOf(arena.observeWagerLeg(3, 42, k, 7, 5_000));
    expect(second.followerCustomerRow).toBe(3);
    expect(second.followCountU32).toBe(1);
    expect(second.avgLagMsU32).toBe(4_000);

    const repeat = edgeOf(arena.observeWagerLeg(2, 42, k, 7, 6_000));
    expect(repeat.followCountU32).toBe(2);
    expect(repeat.avgLagMsU32).toBe(3_500); // (2000 + 5000) / 2

    expect(arena.getEdgeWeight(1, 2)).toBe(2);
    expect(arena.getEdgeAvgLagMs(1, 2)).toBe(3_500);
    expect(arena.getEdgeWeight(1, 3)).toBe(1);
  });

  test("the leader's own re-bet and different tuples are not follower edges", () => {
    const arena = new SyndicateTrackerArena(8);
    const k = key(1);
    arena.observeWagerLeg(1, 42, k, 7, 1_000);
    expect(arena.observeWagerLeg(1, 42, k, 7, 2_000)).toBeNull();
    expect(arena.observeWagerLeg(2, 42, key(2), 7, 2_000)).toBeNull();
    expect(arena.observeWagerLeg(2, 42, k, 8, 2_000)).toBeNull();
    expect(arena.getEdgeWeight(1, 2)).toBe(0);
  });

  test("a tuple older than the follow window is reclaimed by a new leader", () => {
    const arena = new SyndicateTrackerArena(8);
    const k = key(1);
    arena.observeWagerLeg(1, 99, k, 1, 1_000);
    // 16s later: outside the default 15s window, so account 2 becomes the new leader.
    expect(arena.observeWagerLeg(2, 99, k, 1, 17_000)).toBeNull();
    const edge = edgeOf(arena.observeWagerLeg(3, 99, k, 1, 18_000));
    expect(edge.leaderCustomerRow).toBe(2);
    expect(edge.avgLagMsU32).toBe(1_000);
    expect(arena.getEdgeWeight(1, 3)).toBe(0);
  });

  test("cadence columns count sub-second bursts and market breadth", () => {
    const arena = new SyndicateTrackerArena(4);
    arena.observeWagerLeg(0, 1, key(1), 1, 1_000);
    arena.observeWagerLeg(0, 1, key(2), 1, 1_100);
    arena.observeWagerLeg(0, 1, key(3), 1, 1_200);
    arena.observeWagerLeg(0, 1, key(1), 1, 5_000);

    const metrics = arena.getBotCadenceMetrics(0);
    expect(metrics.totalTickets).toBe(4);
    expect(metrics.subSecondBurstCount).toBe(2);
    expect(metrics.subSecondBurstRatio).toBeCloseTo(0.5, 6);
    expect(metrics.minInterArrivalMs).toBe(100);
    expect(metrics.interArrivalVarianceMs2).toBeGreaterThan(0);
    expect(metrics.distinctMarketKeys).toBe(3);
    expect(arena.getDistinctMarketKeys(0)).toBe(3);
    expect(arena.getBotCadenceMetrics(1).totalTickets).toBe(0);
  });

  test("fails closed on out-of-range rows, event ids, keys, clocks and ring sizes", () => {
    expect(() => new SyndicateTrackerArena(8, 100)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    const arena = new SyndicateTrackerArena(8);
    const k = key(1);
    expect(() => arena.observeWagerLeg(-1, 42, k, 7, 1_000)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => arena.observeWagerLeg(8, 42, k, 7, 1_000)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => arena.observeWagerLeg(1, 0, k, 7, 1_000)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() =>
      arena.observeWagerLeg(1, 42, 40_000 as never, 7, 1_000),
    ).toThrow(/ERR_DOD_BITFIELD_RANGE_OVERFLOW/);
    expect(() => arena.observeWagerLeg(1, 42, k, 7, 0)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
    expect(() => arena.observeWagerLeg(1, 42, k, 7, 1_000, 0)).toThrow(
      /ERR_DOD_BITFIELD_RANGE_OVERFLOW/,
    );
  });
});
