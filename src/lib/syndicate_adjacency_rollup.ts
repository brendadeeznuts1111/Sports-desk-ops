/**
 * @file src/lib/syndicate_adjacency_rollup.ts
 * @description Zero-allocation directed leader->follower edge accumulator, CSR compaction and
 * connected-component ring extraction, plus a presigned If-Match CAS flush to R2.
 */

import { COMBO_KEY15_MASK } from "./portal_taxonomy_normalizer.ts";
import {
  REGIME_BOTH,
  REGIME_LIVE_IN_PLAY,
  REGIME_PREGAME,
  type SyndicateFollowEdge,
} from "./syndicate_bot_detector.ts";

export type SyndicateRegimeScope = "PREGAME_ONLY" | "LIVE_ONLY" | "DUAL_REGIME";

function classifyRegimeScope(mask: number): SyndicateRegimeScope {
  if ((mask & REGIME_BOTH) === REGIME_BOTH) return "DUAL_REGIME";
  return (mask & REGIME_LIVE_IN_PLAY) !== 0 ? "LIVE_ONLY" : "PREGAME_ONLY";
}

export const SYNDICATE_RINGS_MANIFEST_KEY =
  "manifests/syndicate-rings/latest" as const;
export const SYNDICATE_RINGS_SNAPSHOT_PREFIX =
  "snapshots/syndicate-rings" as const;
export const SYNDICATE_RINGS_GENERATION_PREFIX =
  "generations/syndicate-rings" as const;

export interface SyndicateRingMemberSummary {
  readonly customerRow: number;
  readonly role: "ORIGIN_LEADER" | "BRIDGE_RELAY" | "COPY_FOLLOWER";
  readonly outboundFollowsU32: number;
  readonly inboundFollowsU32: number;
  readonly minInboundLagMsU32: number;
  readonly regimeMask: number;
}

export interface SyndicateRingSummary {
  readonly ringIdU32: number;
  readonly regimeScope: SyndicateRegimeScope;
  readonly regimeMask: number;
  readonly memberCountU32: number;
  readonly totalFollowEdgesU32: number;
  readonly totalFollowHitsU32: number;
  readonly fastestReactionMsU32: number;
  readonly dominantPackedComboKey15: number;
  readonly members: readonly SyndicateRingMemberSummary[];
}

export interface SyndicateRingsSnapshotManifest {
  readonly domain: "[DOD Spine]";
  readonly r2_bucket: "sportsdesk-ops-reports";
  readonly manifest_key: typeof SYNDICATE_RINGS_MANIFEST_KEY;
  readonly generation_u32: number;
  readonly spine_generation_u32: number;
  readonly merkle_root_sha256: string;
  readonly data_window_max_epoch_ms: number;
  readonly r2_published_at_epoch_ms: number;
  readonly poison_bit: 0 | 1;
  readonly circuit_state: "CLOSED" | "OPEN";
  readonly unresolved_gap_cents: string;
  readonly active_edge_count_u32: number;
  readonly ring_count_u32: number;
  readonly rings: readonly SyndicateRingSummary[];
}

export interface SyndicateR2FlushResult {
  readonly snapshotKey: string;
  readonly generationKey: string;
  readonly merkleRootSha256: string;
  readonly activeEdgeCountU32: number;
  readonly ringCountU32: number;
  readonly newETag: string | null;
}

export interface SyndicateRingsStore {
  write(
    path: string,
    data: string | Uint8Array,
    options?: { readonly type?: string },
  ): Promise<number | undefined>;
  stat(path: string): Promise<{ readonly etag?: string }>;
  presign(
    path: string,
    options: { readonly method: "PUT"; readonly expiresIn: number },
  ): string;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

export class SyndicateAdjacencyRollupArena {
  readonly maxCustomers: number;
  readonly edgeCapacity: number;
  private readonly edgeMask: number;

  private readonly leaderRowPlusOneCol: Uint32Array;
  private readonly followerRowCol: Uint32Array;
  private readonly followCountU32Col: Uint32Array;
  private readonly sumLagMsU32Col: Uint32Array;
  private readonly minLagMsU32Col: Uint32Array;
  private readonly lastPackedComboKey15Col: Uint16Array;
  private readonly regimeMaskU8Col: Uint8Array;
  private readonly pregameCountCol: Uint32Array;
  private readonly liveCountCol: Uint32Array;
  private readonly pregameMinLagCol: Uint32Array;
  private readonly liveMinLagCol: Uint32Array;
  private readonly pregameKey15Col: Uint16Array;
  private readonly liveKey15Col: Uint16Array;

  readonly csrRowHeadU32Col: Uint32Array;
  readonly csrFollowerRowU32Col: Uint32Array;
  readonly csrFollowCountU32Col: Uint32Array;
  readonly csrAvgLagMsU32Col: Uint32Array;
  readonly csrMinLagMsU32Col: Uint32Array;
  readonly csrLastComboKey15Col: Uint16Array;
  readonly csrRegimeMaskU8Col: Uint8Array;

  private readonly rowWriteCursorCol: Uint32Array;
  private readonly inboundHitsCol: Uint32Array;
  private readonly outboundHitsCol: Uint32Array;
  private readonly minInboundLagCol: Uint32Array;
  private readonly nodeRegimeMaskCol: Uint8Array;
  private readonly visitedBitsetCol: Uint32Array;
  private readonly bfsQueueCol: Uint32Array;
  private readonly undirectedHeadCol: Int32Array;
  private readonly undirectedToCol: Uint32Array;
  private readonly undirectedNextCol: Int32Array;

  private activeEdgeCount = 0;

  constructor(maxCustomers: number, powerOfTwoEdgeCapacity = 16384) {
    if (!Number.isInteger(maxCustomers) || maxCustomers <= 0) {
      throw new RangeError(
        "ERR_DOD_BITFIELD_RANGE_OVERFLOW: maxCustomers must be positive",
      );
    }
    if (!isPowerOfTwo(powerOfTwoEdgeCapacity) || powerOfTwoEdgeCapacity < 64) {
      throw new RangeError(
        "ERR_DOD_BITFIELD_RANGE_OVERFLOW: edgeCapacity must be a power of two >= 64",
      );
    }
    this.maxCustomers = maxCustomers;
    this.edgeCapacity = powerOfTwoEdgeCapacity;
    this.edgeMask = powerOfTwoEdgeCapacity - 1;

    this.leaderRowPlusOneCol = new Uint32Array(powerOfTwoEdgeCapacity);
    this.followerRowCol = new Uint32Array(powerOfTwoEdgeCapacity);
    this.followCountU32Col = new Uint32Array(powerOfTwoEdgeCapacity);
    this.sumLagMsU32Col = new Uint32Array(powerOfTwoEdgeCapacity);
    this.minLagMsU32Col = new Uint32Array(powerOfTwoEdgeCapacity);
    this.lastPackedComboKey15Col = new Uint16Array(powerOfTwoEdgeCapacity);
    this.regimeMaskU8Col = new Uint8Array(powerOfTwoEdgeCapacity);
    this.pregameCountCol = new Uint32Array(powerOfTwoEdgeCapacity);
    this.liveCountCol = new Uint32Array(powerOfTwoEdgeCapacity);
    this.pregameMinLagCol = new Uint32Array(powerOfTwoEdgeCapacity);
    this.liveMinLagCol = new Uint32Array(powerOfTwoEdgeCapacity);
    this.pregameKey15Col = new Uint16Array(powerOfTwoEdgeCapacity);
    this.liveKey15Col = new Uint16Array(powerOfTwoEdgeCapacity);

    this.csrRowHeadU32Col = new Uint32Array(maxCustomers + 1);
    this.csrFollowerRowU32Col = new Uint32Array(powerOfTwoEdgeCapacity);
    this.csrFollowCountU32Col = new Uint32Array(powerOfTwoEdgeCapacity);
    this.csrAvgLagMsU32Col = new Uint32Array(powerOfTwoEdgeCapacity);
    this.csrMinLagMsU32Col = new Uint32Array(powerOfTwoEdgeCapacity);
    this.csrLastComboKey15Col = new Uint16Array(powerOfTwoEdgeCapacity);
    this.csrRegimeMaskU8Col = new Uint8Array(powerOfTwoEdgeCapacity);

    this.rowWriteCursorCol = new Uint32Array(maxCustomers);
    this.inboundHitsCol = new Uint32Array(maxCustomers);
    this.outboundHitsCol = new Uint32Array(maxCustomers);
    this.minInboundLagCol = new Uint32Array(maxCustomers);
    this.nodeRegimeMaskCol = new Uint8Array(maxCustomers);
    this.visitedBitsetCol = new Uint32Array((maxCustomers + 31) >>> 5);
    this.bfsQueueCol = new Uint32Array(maxCustomers);

    this.undirectedHeadCol = new Int32Array(maxCustomers);
    this.undirectedToCol = new Uint32Array(powerOfTwoEdgeCapacity * 2);
    this.undirectedNextCol = new Int32Array(powerOfTwoEdgeCapacity * 2);
  }

  get edgeCount(): number {
    return this.activeEdgeCount;
  }

  recordFollowEdge(edge: SyndicateFollowEdge): boolean {
    return this.recordFollowRaw(
      edge.leaderCustomerRow,
      edge.followerCustomerRow,
      edge.lagMsU32 ?? edge.lastLagMsU32 ?? edge.avgLagMsU32 ?? 0,
      edge.lastPackedComboKey15,
      edge.regimeBit ?? REGIME_PREGAME,
    );
  }

  recordFollowRaw(
    leaderRow: number,
    followerRow: number,
    lagMsU32: number,
    packedComboKey15: number,
    regimeBit: number = REGIME_PREGAME,
  ): boolean {
    if (
      leaderRow === followerRow ||
      leaderRow >>> 0 >= this.maxCustomers ||
      followerRow >>> 0 >= this.maxCustomers
    ) {
      return false;
    }
    const encodedLeader = (leaderRow + 1) >>> 0;
    const followerPlusOne = (followerRow + 1) >>> 0;
    const lag = lagMsU32 >>> 0;
    const mask = regimeBit & REGIME_BOTH;
    // Keyed by directed (leaderRow, followerRow); per-regime hit/lag/key columns allow
    // both combined CSR compaction (edgeCount = 1, regimeMask = 0b11) and strict regime slicing.
    let slot =
      (Math.imul(encodedLeader, 0x9e3779b1) ^
        Math.imul(followerPlusOne, 0x85ebca6b)) &
      this.edgeMask;

    for (let probe = 0; probe < this.edgeCapacity; probe += 1) {
      const existingLeader = this.leaderRowPlusOneCol[slot]!;
      if (existingLeader === 0) {
        if (this.activeEdgeCount >= (this.edgeCapacity * 3) >>> 2) {
          return false;
        }
        this.leaderRowPlusOneCol[slot] = encodedLeader;
        this.followerRowCol[slot] = followerRow;
        this.followCountU32Col[slot] = 1;
        this.sumLagMsU32Col[slot] = lag;
        this.minLagMsU32Col[slot] = lag;
        this.lastPackedComboKey15Col[slot] =
          packedComboKey15 & COMBO_KEY15_MASK;
        this.regimeMaskU8Col[slot] = mask;
        this.recordSlotRegime(
          slot,
          mask,
          lag,
          packedComboKey15 & COMBO_KEY15_MASK,
        );
        this.activeEdgeCount += 1;
        return true;
      }
      if (
        existingLeader === encodedLeader &&
        this.followerRowCol[slot] === followerRow
      ) {
        this.followCountU32Col[slot] = this.followCountU32Col[slot]! + 1;
        const nextSum = this.sumLagMsU32Col[slot]! + lag;
        this.sumLagMsU32Col[slot] =
          nextSum >= 0xffffffff ? 0xffffffff : nextSum;
        if (lag < this.minLagMsU32Col[slot]!) {
          this.minLagMsU32Col[slot] = lag;
        }
        this.lastPackedComboKey15Col[slot] =
          packedComboKey15 & COMBO_KEY15_MASK;
        this.regimeMaskU8Col[slot]! |= mask;
        this.recordSlotRegime(
          slot,
          mask,
          lag,
          packedComboKey15 & COMBO_KEY15_MASK,
        );
        return true;
      }
      slot = (slot + 1) & this.edgeMask;
    }
    return false;
  }

  private recordSlotRegime(
    slot: number,
    mask: number,
    lag: number,
    key15: number,
  ): void {
    if ((mask & REGIME_PREGAME) !== 0) {
      const prevCount = this.pregameCountCol[slot]!;
      this.pregameCountCol[slot] = prevCount + 1;
      if (prevCount === 0 || lag < this.pregameMinLagCol[slot]!) {
        this.pregameMinLagCol[slot] = lag;
      }
      this.pregameKey15Col[slot] = key15;
    }
    if ((mask & REGIME_LIVE_IN_PLAY) !== 0) {
      const prevCount = this.liveCountCol[slot]!;
      this.liveCountCol[slot] = prevCount + 1;
      if (prevCount === 0 || lag < this.liveMinLagCol[slot]!) {
        this.liveMinLagCol[slot] = lag;
      }
      this.liveKey15Col[slot] = key15;
    }
  }

  compactToCsr(regimeFilterMask: number = REGIME_BOTH): number {
    this.csrRowHeadU32Col.fill(0);
    const filterMask = regimeFilterMask & REGIME_BOTH;
    for (let slot = 0; slot < this.edgeCapacity; slot += 1) {
      const encodedLeader = this.leaderRowPlusOneCol[slot]!;
      if (encodedLeader === 0) continue;
      if (
        filterMask !== REGIME_BOTH &&
        (this.regimeMaskU8Col[slot]! & filterMask) === 0
      ) {
        continue;
      }
      this.csrRowHeadU32Col[encodedLeader]!++;
    }
    for (let row = 0; row < this.maxCustomers; row += 1) {
      this.csrRowHeadU32Col[row + 1] =
        this.csrRowHeadU32Col[row + 1]! + this.csrRowHeadU32Col[row]!;
      this.rowWriteCursorCol[row] = this.csrRowHeadU32Col[row]!;
    }
    const compactedTotal = this.csrRowHeadU32Col[this.maxCustomers]!;
    if (filterMask === REGIME_BOTH && compactedTotal !== this.activeEdgeCount) {
      throw new Error(
        `ERR_DOD_CSR_CONSERVATION_BREACH: Compacted CSR edge sum (${compactedTotal}) !== activeEdgeCount (${this.activeEdgeCount})`,
      );
    }
    for (let slot = 0; slot < this.edgeCapacity; slot += 1) {
      const encodedLeader = this.leaderRowPlusOneCol[slot]!;
      if (encodedLeader === 0) continue;
      const edgeRegime = this.regimeMaskU8Col[slot]!;
      if (filterMask !== REGIME_BOTH && (edgeRegime & filterMask) === 0) {
        continue;
      }
      const leaderRow = encodedLeader - 1;
      const dst = this.rowWriteCursorCol[leaderRow]!;
      this.rowWriteCursorCol[leaderRow] = dst + 1;
      const count =
        filterMask === REGIME_BOTH
          ? this.followCountU32Col[slot]!
          : filterMask === REGIME_LIVE_IN_PLAY
            ? this.liveCountCol[slot]!
            : this.pregameCountCol[slot]!;
      const minLag =
        filterMask === REGIME_BOTH
          ? this.minLagMsU32Col[slot]!
          : filterMask === REGIME_LIVE_IN_PLAY
            ? this.liveMinLagCol[slot]!
            : this.pregameMinLagCol[slot]!;
      const comboKey15 =
        filterMask === REGIME_BOTH
          ? this.lastPackedComboKey15Col[slot]!
          : filterMask === REGIME_LIVE_IN_PLAY
            ? this.liveKey15Col[slot]!
            : this.pregameKey15Col[slot]!;
      this.csrFollowerRowU32Col[dst] = this.followerRowCol[slot]!;
      this.csrFollowCountU32Col[dst] = count;
      this.csrAvgLagMsU32Col[dst] =
        count > 0 ? Math.floor(this.sumLagMsU32Col[slot]! / count) : 0;
      this.csrMinLagMsU32Col[dst] = minLag;
      this.csrLastComboKey15Col[dst] = comboKey15;
      this.csrRegimeMaskU8Col[dst] =
        filterMask === REGIME_BOTH ? edgeRegime : filterMask;
    }
    return compactedTotal;
  }

  extractTopSyndicateRings(
    minEdgeFollowCount = 2,
    topKRings = 25,
    regimeFilterMask: number = REGIME_BOTH,
  ): readonly SyndicateRingSummary[] {
    const filterMask = regimeFilterMask & REGIME_BOTH;
    this.compactToCsr(filterMask);

    this.inboundHitsCol.fill(0);
    this.outboundHitsCol.fill(0);
    this.minInboundLagCol.fill(0xffffffff);
    this.nodeRegimeMaskCol.fill(0);
    this.visitedBitsetCol.fill(0);
    this.undirectedHeadCol.fill(-1);

    let undirectedPtr = 0;
    const addUndirected = (u: number, v: number): void => {
      this.undirectedToCol[undirectedPtr] = v;
      this.undirectedNextCol[undirectedPtr] = this.undirectedHeadCol[u]!;
      this.undirectedHeadCol[u] = undirectedPtr;
      undirectedPtr += 1;
    };

    for (let leader = 0; leader < this.maxCustomers; leader += 1) {
      const start = this.csrRowHeadU32Col[leader]!;
      const end = this.csrRowHeadU32Col[leader + 1]!;
      for (let idx = start; idx < end; idx += 1) {
        const count = this.csrFollowCountU32Col[idx]!;
        if (count < minEdgeFollowCount) continue;
        const follower = this.csrFollowerRowU32Col[idx]!;
        const minLag = this.csrMinLagMsU32Col[idx]!;
        const edgeRegime = this.csrRegimeMaskU8Col[idx]! & filterMask;
        this.outboundHitsCol[leader] = this.outboundHitsCol[leader]! + count;
        this.inboundHitsCol[follower] = this.inboundHitsCol[follower]! + count;
        this.nodeRegimeMaskCol[leader]! |= edgeRegime;
        this.nodeRegimeMaskCol[follower]! |= edgeRegime;
        if (minLag < this.minInboundLagCol[follower]!) {
          this.minInboundLagCol[follower] = minLag;
        }
        addUndirected(leader, follower);
        addUndirected(follower, leader);
      }
    }

    const discoveredRings: SyndicateRingSummary[] = [];

    for (let seedRow = 0; seedRow < this.maxCustomers; seedRow += 1) {
      if (this.undirectedHeadCol[seedRow] === -1) continue;
      const wordIdx = seedRow >>> 5;
      const bitMask = 1 << (seedRow & 31);
      if ((this.visitedBitsetCol[wordIdx]! & bitMask) !== 0) continue;

      this.visitedBitsetCol[wordIdx] =
        this.visitedBitsetCol[wordIdx]! | bitMask;
      let qHead = 0;
      let qTail = 0;
      this.bfsQueueCol[qTail] = seedRow;
      qTail += 1;

      let totalHits = 0;
      let totalEdges = 0;
      let fastestReactionMs = 0xffffffff;
      let dominantComboKey15 = 0;
      let maxComboHits = 0;
      let ringRegimeMask = 0;

      while (qHead < qTail) {
        const curr = this.bfsQueueCol[qHead]!;
        qHead += 1;

        const csrStart = this.csrRowHeadU32Col[curr]!;
        const csrEnd = this.csrRowHeadU32Col[curr + 1]!;
        for (let idx = csrStart; idx < csrEnd; idx += 1) {
          const hits = this.csrFollowCountU32Col[idx]!;
          if (hits < minEdgeFollowCount) continue;
          totalEdges += 1;
          totalHits += hits;
          ringRegimeMask |= this.csrRegimeMaskU8Col[idx]! & filterMask;
          const minLag = this.csrMinLagMsU32Col[idx]!;
          if (minLag < fastestReactionMs) fastestReactionMs = minLag;
          if (hits > maxComboHits) {
            maxComboHits = hits;
            dominantComboKey15 = this.csrLastComboKey15Col[idx]!;
          }
        }

        for (
          let edge = this.undirectedHeadCol[curr]!;
          edge !== -1;
          edge = this.undirectedNextCol[edge]!
        ) {
          const neighbor = this.undirectedToCol[edge]!;
          const nWord = neighbor >>> 5;
          const nMask = 1 << (neighbor & 31);
          if ((this.visitedBitsetCol[nWord]! & nMask) === 0) {
            this.visitedBitsetCol[nWord] =
              this.visitedBitsetCol[nWord]! | nMask;
            this.bfsQueueCol[qTail] = neighbor;
            qTail += 1;
          }
        }
      }

      if (qTail < 2) continue;

      const members: SyndicateRingMemberSummary[] = [];
      for (let i = 0; i < qTail; i += 1) {
        const memberRow = this.bfsQueueCol[i]!;
        const outHits = this.outboundHitsCol[memberRow]!;
        const inHits = this.inboundHitsCol[memberRow]!;
        const role =
          inHits === 0 && outHits > 0
            ? "ORIGIN_LEADER"
            : outHits > 0 && inHits > 0
              ? "BRIDGE_RELAY"
              : "COPY_FOLLOWER";
        members.push({
          customerRow: memberRow,
          role,
          outboundFollowsU32: outHits,
          inboundFollowsU32: inHits,
          minInboundLagMsU32:
            inHits > 0 ? this.minInboundLagCol[memberRow]! : 0,
          regimeMask: this.nodeRegimeMaskCol[memberRow]!,
        });
      }

      members.sort((a, b) => {
        if (a.role === "ORIGIN_LEADER" && b.role !== "ORIGIN_LEADER") return -1;
        if (b.role === "ORIGIN_LEADER" && a.role !== "ORIGIN_LEADER") return 1;
        return (
          b.outboundFollowsU32 +
            b.inboundFollowsU32 -
            (a.outboundFollowsU32 + a.inboundFollowsU32) ||
          a.customerRow - b.customerRow
        );
      });

      discoveredRings.push({
        ringIdU32: members[0]!.customerRow,
        regimeScope: classifyRegimeScope(ringRegimeMask),
        regimeMask: ringRegimeMask,
        memberCountU32: qTail,
        totalFollowEdgesU32: totalEdges,
        totalFollowHitsU32: totalHits,
        fastestReactionMsU32:
          fastestReactionMs === 0xffffffff ? 0 : fastestReactionMs,
        dominantPackedComboKey15: dominantComboKey15,
        members,
      });
    }

    discoveredRings.sort((a, b) => b.totalFollowHitsU32 - a.totalFollowHitsU32);
    return discoveredRings.slice(0, topKRings);
  }

  resetInPlace(): void {
    this.leaderRowPlusOneCol.fill(0);
    this.followerRowCol.fill(0);
    this.followCountU32Col.fill(0);
    this.sumLagMsU32Col.fill(0);
    this.minLagMsU32Col.fill(0);
    this.lastPackedComboKey15Col.fill(0);
    this.regimeMaskU8Col.fill(0);
    this.pregameCountCol.fill(0);
    this.liveCountCol.fill(0);
    this.pregameMinLagCol.fill(0);
    this.liveMinLagCol.fill(0);
    this.pregameKey15Col.fill(0);
    this.liveKey15Col.fill(0);
    this.csrRowHeadU32Col.fill(0);
    this.csrRegimeMaskU8Col.fill(0);
    this.activeEdgeCount = 0;
  }
}

function createSyndicateCasRejectedError(
  message: string,
): Error & { readonly exitCode: 74 } {
  const err = new Error(message) as Error & { exitCode: 74 };
  err.exitCode = 74;
  return err;
}

export async function flushTopSyndicateRingsToR2(
  r2: SyndicateRingsStore,
  rollupArena: SyndicateAdjacencyRollupArena,
  params: {
    readonly nextGenerationU32: number;
    readonly spineGenerationU32: number;
    readonly expectedPrevETag: string;
    readonly dataWindowMaxEpochMs?: number;
    readonly minEdgeFollowCount?: number;
    readonly topKRings?: number;
    readonly flushEpochMs?: number;
    readonly fetchImpl?: typeof fetch;
  },
): Promise<SyndicateR2FlushResult> {
  const expectedPrevETag = params.expectedPrevETag;
  if (
    typeof expectedPrevETag !== "string" ||
    expectedPrevETag.trim().length === 0
  ) {
    throw createSyndicateCasRejectedError(
      `ERR_R2_MANIFEST_CAS_REJECTED: Missing expectedPrevETag for ${SYNDICATE_RINGS_MANIFEST_KEY}`,
    );
  }
  const trimmedExpectedETag = expectedPrevETag.trim();
  const isInitialCreate = trimmedExpectedETag === "*";
  if (isInitialCreate && params.nextGenerationU32 >>> 0 !== 1) {
    throw createSyndicateCasRejectedError(
      `ERR_R2_MANIFEST_CAS_REJECTED: Initial If-None-Match=* requires nextGenerationU32===1 (got ${params.nextGenerationU32})`,
    );
  }

  const flushEpochMs = params.flushEpochMs ?? Date.now();
  const dataWindowMaxEpochMs = params.dataWindowMaxEpochMs ?? flushEpochMs;
  const rings = rollupArena.extractTopSyndicateRings(
    params.minEdgeFollowCount ?? 2,
    params.topKRings ?? 25,
  );

  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(
    `gen:${params.nextGenerationU32}|spine:${params.spineGenerationU32}\n`,
  );
  for (const ring of rings) {
    hasher.update(
      `ring:${ring.ringIdU32}|members:${ring.memberCountU32}|hits:${ring.totalFollowHitsU32}|key:${ring.dominantPackedComboKey15}\n`,
    );
    for (const member of ring.members) {
      hasher.update(
        `  member:${member.customerRow}:${member.role}:out=${member.outboundFollowsU32}:in=${member.inboundFollowsU32}\n`,
      );
    }
  }
  const merkleRootSha256 = hasher.digest("hex");
  const merkle16 = merkleRootSha256.slice(0, 16);

  const manifest: SyndicateRingsSnapshotManifest = {
    domain: "[DOD Spine]",
    r2_bucket: "sportsdesk-ops-reports",
    manifest_key: SYNDICATE_RINGS_MANIFEST_KEY,
    generation_u32: params.nextGenerationU32,
    spine_generation_u32: params.spineGenerationU32,
    merkle_root_sha256: merkleRootSha256,
    data_window_max_epoch_ms: dataWindowMaxEpochMs,
    r2_published_at_epoch_ms: flushEpochMs,
    poison_bit: 0,
    circuit_state: "CLOSED",
    unresolved_gap_cents: "0",
    active_edge_count_u32: rollupArena.edgeCount,
    ring_count_u32: rings.length,
    rings,
  };
  const serialized = JSON.stringify(manifest);

  // Read the current ETag first: a stale expectation must not write orphan blobs.
  if (isInitialCreate) {
    let existingEtag = "";
    try {
      const current = await r2.stat(SYNDICATE_RINGS_MANIFEST_KEY);
      existingEtag = current.etag?.trim() ?? "";
    } catch {
      existingEtag = "";
    }
    if (existingEtag.length > 0) {
      throw createSyndicateCasRejectedError(
        `ERR_R2_MANIFEST_CAS_REJECTED: ${SYNDICATE_RINGS_MANIFEST_KEY} already exists at ${existingEtag} (expected absent for *)`,
      );
    }
  } else {
    const current = await r2.stat(SYNDICATE_RINGS_MANIFEST_KEY);
    if (current.etag !== trimmedExpectedETag) {
      throw createSyndicateCasRejectedError(
        `ERR_R2_MANIFEST_CAS_REJECTED: ${SYNDICATE_RINGS_MANIFEST_KEY} is at ${String(current.etag)} but expected ${trimmedExpectedETag}`,
      );
    }
  }

  const snapshotKey = `${SYNDICATE_RINGS_SNAPSHOT_PREFIX}/${flushEpochMs}-${merkle16}.json`;
  const generationKey = `${SYNDICATE_RINGS_GENERATION_PREFIX}/gen-${params.nextGenerationU32}-${merkle16}`;
  await Promise.all([
    r2.write(snapshotKey, serialized, { type: "application/json" }),
    r2.write(generationKey, serialized, { type: "application/json" }),
  ]);

  const doFetch = params.fetchImpl ?? fetch;
  const url = r2.presign(SYNDICATE_RINGS_MANIFEST_KEY, {
    method: "PUT",
    expiresIn: 60,
  });
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "PUT",
      headers: isInitialCreate
        ? { "If-None-Match": "*" }
        : { "If-Match": trimmedExpectedETag },
      body: serialized,
    });
  } catch (cause) {
    throw new Error(
      `ERR_R2_MANIFEST_CAS_TRANSPORT: PUT ${SYNDICATE_RINGS_MANIFEST_KEY} failed: ${String(cause)}`,
      { cause },
    );
  }
  if (response.status === 412) {
    throw createSyndicateCasRejectedError(
      `ERR_R2_MANIFEST_CAS_REJECTED: HTTP 412 promoting ${SYNDICATE_RINGS_MANIFEST_KEY} (expected ETag=${trimmedExpectedETag})`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `ERR_R2_MANIFEST_CAS_TRANSPORT: PUT ${SYNDICATE_RINGS_MANIFEST_KEY} returned HTTP ${response.status}`,
    );
  }

  const responseETag = response.headers.get("etag");
  const stored = await r2.stat(SYNDICATE_RINGS_MANIFEST_KEY);
  if (
    responseETag !== null &&
    stored.etag !== undefined &&
    responseETag !== stored.etag
  ) {
    throw new Error(
      `ERR_R2_MANIFEST_CAS_VERIFY: PUT returned ${responseETag} but stat() reads ${stored.etag}`,
    );
  }

  return {
    snapshotKey,
    generationKey,
    merkleRootSha256,
    activeEdgeCountU32: rollupArena.edgeCount,
    ringCountU32: rings.length,
    newETag: responseETag ?? stored.etag ?? null,
  };
}
