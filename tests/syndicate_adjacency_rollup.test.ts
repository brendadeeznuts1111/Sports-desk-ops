import { describe, expect, test } from "bun:test";
import {
  SYNDICATE_RINGS_MANIFEST_KEY,
  SYNDICATE_RINGS_SNAPSHOT_PREFIX,
  SyndicateAdjacencyRollupArena,
  flushTopSyndicateRingsToR2,
  type SyndicateRingsStore,
} from "../src/lib/syndicate_adjacency_rollup.ts";
import type { SyndicateFollowEdge } from "../src/lib/syndicate_bot_detector.ts";

function edge(
  leader: number,
  follower: number,
  lastLagMs: number,
  key: number,
): SyndicateFollowEdge {
  return {
    leaderCustomerRow: leader,
    followerCustomerRow: follower,
    followCountU32: 1,
    avgLagMsU32: 999_999,
    lastLagMsU32: lastLagMs,
    lastPackedComboKey15: key,
  };
}

describe("SyndicateAdjacencyRollupArena CSR", () => {
  test("compacts edges into customer-major CSR and conserves counts", () => {
    const arena = new SyndicateAdjacencyRollupArena(8, 64);
    expect(arena.recordFollowRaw(0, 1, 1_000, 5)).toBe(true);
    expect(arena.recordFollowRaw(0, 1, 500, 8)).toBe(true);
    expect(arena.recordFollowRaw(0, 2, 2_000, 6)).toBe(true);
    expect(arena.recordFollowRaw(1, 2, 3_000, 7)).toBe(true);
    expect(arena.recordFollowRaw(1, 1, 1, 1)).toBe(false);
    expect(arena.recordFollowRaw(8, 2, 1, 1)).toBe(false);
    expect(arena.edgeCount).toBe(3);

    expect(arena.compactToCsr()).toBe(3);
    expect(Array.from(arena.csrRowHeadU32Col)).toEqual([
      0, 2, 3, 3, 3, 3, 3, 3, 3,
    ]);
    // row 0: follower 1 (2 hits, avg 750, min 500, last key 8), follower 2 (1 hit).
    // CSR order is edge-slot order, not insertion order, so compare per follower.
    const row0 = [0, 1]
      .map((i) => ({
        follower: arena.csrFollowerRowU32Col[i]!,
        count: arena.csrFollowCountU32Col[i]!,
        avg: arena.csrAvgLagMsU32Col[i]!,
        min: arena.csrMinLagMsU32Col[i]!,
        key: arena.csrLastComboKey15Col[i]!,
      }))
      .sort((a, b) => a.follower - b.follower);
    expect(row0).toEqual([
      { follower: 1, count: 2, avg: 750, min: 500, key: 8 },
      { follower: 2, count: 1, avg: 2_000, min: 2_000, key: 6 },
    ]);
    // row 1: follower 2
    expect(arena.csrFollowerRowU32Col[2]).toBe(2);
    expect(arena.csrFollowCountU32Col[2]).toBe(1);
    expect(arena.csrAvgLagMsU32Col[2]).toBe(3_000);
  });

  test("recordFollowEdge uses the last lag, not the average lag", () => {
    const arena = new SyndicateAdjacencyRollupArena(4, 64);
    expect(arena.recordFollowEdge(edge(0, 1, 1_250, 5))).toBe(true);
    expect(arena.compactToCsr()).toBe(1);
    expect(arena.csrMinLagMsU32Col[0]).toBe(1_250);
    expect(arena.csrAvgLagMsU32Col[0]).toBe(1_250);
  });

  test("reset returns the arena to an empty, reusable state", () => {
    const arena = new SyndicateAdjacencyRollupArena(4, 64);
    arena.recordFollowRaw(0, 1, 100, 1);
    arena.resetInPlace();
    expect(arena.edgeCount).toBe(0);
    expect(arena.compactToCsr()).toBe(0);
    expect(arena.csrRowHeadU32Col[0]).toBe(0);
    expect(arena.recordFollowRaw(0, 1, 100, 1)).toBe(true);
  });
});

describe("SyndicateAdjacencyRollupArena ring extraction", () => {
  function buildRingArena(): SyndicateAdjacencyRollupArena {
    const arena = new SyndicateAdjacencyRollupArena(8, 64);
    // A(0) -> B(1) x3, B(1) -> C(2) x2; A -> C count 1 is below the default threshold.
    arena.recordFollowRaw(0, 1, 500, 11);
    arena.recordFollowRaw(0, 1, 600, 11);
    arena.recordFollowRaw(0, 1, 700, 12);
    arena.recordFollowRaw(1, 2, 800, 13);
    arena.recordFollowRaw(1, 2, 900, 13);
    arena.recordFollowRaw(0, 2, 1_000, 14);
    return arena;
  }

  test("separates origin leader, bridge relay and copy follower", () => {
    const arena = buildRingArena();
    const rings = arena.extractTopSyndicateRings(2, 10);
    expect(rings).toHaveLength(1);
    const ring = rings[0]!;
    expect(ring.memberCountU32).toBe(3);
    expect(ring.totalFollowEdgesU32).toBe(2);
    expect(ring.totalFollowHitsU32).toBe(5);
    expect(ring.fastestReactionMsU32).toBe(500);
    expect(ring.dominantPackedComboKey15).toBe(12);
    expect(ring.ringIdU32).toBe(0);
    expect(ring.members.map((m) => m.role)).toEqual([
      "ORIGIN_LEADER",
      "BRIDGE_RELAY",
      "COPY_FOLLOWER",
    ]);
    const bridge = ring.members.find((m) => m.customerRow === 1)!;
    expect(bridge.inboundFollowsU32).toBe(3);
    expect(bridge.outboundFollowsU32).toBe(2);
    expect(bridge.minInboundLagMsU32).toBe(500);
    const follower = ring.members.find((m) => m.customerRow === 2)!;
    expect(follower.minInboundLagMsU32).toBe(800);
  });

  test("drops components whose edges are all below the threshold", () => {
    const arena = new SyndicateAdjacencyRollupArena(8, 64);
    arena.recordFollowRaw(0, 1, 500, 11);
    arena.recordFollowRaw(1, 2, 600, 12);
    expect(arena.extractTopSyndicateRings(2, 10)).toEqual([]);
  });
});

describe("flushTopSyndicateRingsToR2", () => {
  function buildArena(): SyndicateAdjacencyRollupArena {
    const arena = new SyndicateAdjacencyRollupArena(8, 64);
    arena.recordFollowRaw(0, 1, 500, 11);
    arena.recordFollowRaw(0, 1, 600, 11);
    arena.recordFollowRaw(0, 1, 700, 12);
    arena.recordFollowRaw(1, 2, 800, 13);
    arena.recordFollowRaw(1, 2, 900, 13);
    return arena;
  }

  function makeStore(initialEtag: string): {
    store: SyndicateRingsStore;
    writes: Array<{ key: string; body: string }>;
    getEtag: () => string;
    setEtag: (value: string) => void;
  } {
    const writes: Array<{ key: string; body: string }> = [];
    let etag = initialEtag;
    return {
      writes,
      getEtag: () => etag,
      setEtag: (value: string) => {
        etag = value;
      },
      store: {
        write: async (key, data) => {
          writes.push({ key, body: String(data) });
          return 1;
        },
        stat: async () => ({ etag }),
        presign: (key) => `https://r2.test/${key}?X-Amz-Signature=test`,
      },
    };
  }

  test("writes snapshot + generation, then promotes with If-Match", async () => {
    const arena = buildArena();
    const { store, writes, setEtag } = makeStore('"prev"');
    const fetchCalls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (input: string, init?: RequestInit) => {
      fetchCalls.push({ url: String(input), init: init ?? {} });
      setEtag('"next"');
      return new Response("", {
        status: 200,
        headers: { etag: '"next"' },
      });
    }) as unknown as typeof fetch;

    const result = await flushTopSyndicateRingsToR2(store, arena, {
      nextGenerationU32: 7,
      spineGenerationU32: 3,
      expectedPrevETag: '"prev"',
      dataWindowMaxEpochMs: 1_699_999_995_000,
      flushEpochMs: 1_700_000_000_000,
      fetchImpl,
    });

    expect(writes).toHaveLength(2);
    expect(
      writes[0]!.key.startsWith(`${SYNDICATE_RINGS_SNAPSHOT_PREFIX}/`),
    ).toBe(true);
    expect(writes[0]!.key.endsWith(".json")).toBe(true);
    expect(writes[1]!.key).toContain("generations/syndicate-rings/gen-7-");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.url).toContain(SYNDICATE_RINGS_MANIFEST_KEY);
    expect(new Headers(fetchCalls[0]!.init.headers).get("If-Match")).toBe(
      '"prev"',
    );
    expect(result.newETag).toBe('"next"');
    expect(result.ringCountU32).toBe(1);
    expect(result.merkleRootSha256).toHaveLength(64);

    const manifest = JSON.parse(writes[0]!.body) as {
      data_window_max_epoch_ms: number;
      r2_published_at_epoch_ms: number;
      poison_bit: number;
      circuit_state: string;
      unresolved_gap_cents: string;
      active_edge_count_u32: number;
      ring_count_u32: number;
      rings: unknown[];
    };
    expect(manifest.data_window_max_epoch_ms).toBe(1_699_999_995_000);
    expect(manifest.r2_published_at_epoch_ms).toBe(1_700_000_000_000);
    expect(manifest.poison_bit).toBe(0);
    expect(manifest.circuit_state).toBe("CLOSED");
    expect(manifest.unresolved_gap_cents).toBe("0");
    expect(manifest.active_edge_count_u32).toBe(2);
    expect(manifest.ring_count_u32).toBe(1);
    expect(manifest.rings).toHaveLength(1);
  });

  test("a stale expected ETag is rejected before any snapshot is written", async () => {
    const arena = buildArena();
    const { store, writes } = makeStore('"other"');
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("");
    }) as unknown as typeof fetch;

    await expect(
      flushTopSyndicateRingsToR2(store, arena, {
        nextGenerationU32: 8,
        spineGenerationU32: 3,
        expectedPrevETag: '"prev"',
        fetchImpl,
      }),
    ).rejects.toThrow(/ERR_R2_MANIFEST_CAS_REJECTED/);
    expect(fetched).toBe(false);
    expect(writes).toHaveLength(0);
  });

  test("HTTP 412 is a CAS rejection, not a retry or rebase", async () => {
    const arena = buildArena();
    const { store, writes } = makeStore('"prev"');
    const fetchImpl = (async () =>
      new Response("", { status: 412 })) as unknown as typeof fetch;
    let capturedErr: unknown = null;
    try {
      await flushTopSyndicateRingsToR2(store, arena, {
        nextGenerationU32: 9,
        spineGenerationU32: 3,
        expectedPrevETag: '"prev"',
        fetchImpl,
      });
    } catch (err) {
      capturedErr = err;
    }
    expect(capturedErr).toBeInstanceOf(Error);
    expect((capturedErr as Error).message).toMatch(
      /ERR_R2_MANIFEST_CAS_REJECTED/,
    );
    expect((capturedErr as { exitCode?: number }).exitCode).toBe(74);
    expect(writes).toHaveLength(2);
  });

  test("initial gen=1 promotion uses If-None-Match=* when manifest is absent", async () => {
    const arena = buildArena();
    const { store, writes, setEtag } = makeStore("");
    const fetchCalls: Array<{ init: RequestInit }> = [];
    const fetchImpl = (async (_input: string, init?: RequestInit) => {
      fetchCalls.push({ init: init ?? {} });
      setEtag('"gen1"');
      return new Response("", {
        status: 200,
        headers: { etag: '"gen1"' },
      });
    }) as unknown as typeof fetch;

    const result = await flushTopSyndicateRingsToR2(store, arena, {
      nextGenerationU32: 1,
      spineGenerationU32: 1,
      expectedPrevETag: "*",
      dataWindowMaxEpochMs: 1_700_000_000_000,
      flushEpochMs: 1_700_000_001_000,
      fetchImpl,
    });

    expect(writes).toHaveLength(2);
    expect(fetchCalls).toHaveLength(1);
    expect(new Headers(fetchCalls[0]!.init.headers).get("If-None-Match")).toBe(
      "*",
    );
    expect(result.newETag).toBe('"gen1"');
  });

  test("empty expected ETag fails before any write", async () => {
    const arena = buildArena();
    const { store, writes } = makeStore('"prev"');
    await expect(
      flushTopSyndicateRingsToR2(store, arena, {
        nextGenerationU32: 10,
        spineGenerationU32: 3,
        expectedPrevETag: "   ",
      }),
    ).rejects.toThrow(/ERR_R2_MANIFEST_CAS_REJECTED/);
    expect(writes).toHaveLength(0);
  });
});
