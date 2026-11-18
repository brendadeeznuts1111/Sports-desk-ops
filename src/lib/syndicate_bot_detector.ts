/**
 * @file src/lib/syndicate_bot_detector.ts
 * @description Zero-allocation dual-regime leader/follower and bot-cadence tracker keyed by
 * (eventId32, SubSportComboPackedKey15, lineSig32). Ingest stores only integers in typed
 * arrays; the returned edge is a single reused view, so callers must copy immediately.
 */

import {
  COMBO_KEY15_MASK,
  MARKET_KIND_MASK,
  WAGER_TYPE_MASK,
  WAGER_TYPE_SHIFT,
  type SubSportComboPackedKey15,
} from "./portal_taxonomy_normalizer.ts";

const RING_HASH = 0x9e3779b1;
const EDGE_HASH = 0x85ebca6b;
const BURST_MS = 350;
export const LIVE_BROADCAST_SURGE_WINDOW_MS = 3_000 as const;
const SURGE_SLOTS = 1024;
const SURGE_SLOT_MASK = SURGE_SLOTS - 1;
const SURGE_MEMBER_CAP = 16;

export const LIVE_WAGER_TYPE_CODE3 = 7 as const;
export const LIVE_BOT_FOLLOW_WINDOW_MS = 1_500 as const;
export const PREGAME_API_BOT_WINDOW_MS = 5_000 as const;
export const PREGAME_TIP_CHANNEL_WINDOW_MS = 90_000 as const;
export const LIVE_BROADCAST_SURGE_ACCOUNT_CAP = 8 as const;
export const BROADCAST_SURGE_DISTINCT_THRESHOLD =
  LIVE_BROADCAST_SURGE_ACCOUNT_CAP;

export const REGIME_PREGAME = 0b01 as const;
export const REGIME_LIVE_IN_PLAY = 0b10 as const;
export const REGIME_BOTH = 0b11 as const;
export const REGIME_BIT_PREGAME = REGIME_PREGAME;
export const REGIME_BIT_LIVE = REGIME_LIVE_IN_PLAY;
export const REGIME_BIT_BOTH = REGIME_BOTH;

export type WagerRegime = "PREGAME" | "LIVE_IN_PLAY";
export type FollowClass =
  "LIVE_FEED_BOT" | "PREGAME_API_BOT" | "PREGAME_TIP_CHANNEL";

export interface SyndicateFollowEdge {
  leaderCustomerRow: number;
  followerCustomerRow: number;
  followCountU32: number;
  avgLagMsU32?: number;
  lastLagMsU32?: number;
  lagMsU32?: number;
  regime?: WagerRegime;
  regimeBit?: number;
  followClass?: FollowClass;
  lastPackedComboKey15: number;
}

export interface BotCadenceMetrics {
  totalTickets: number;
  subSecondBurstCount: number;
  subSecondBurstRatio: number;
  minInterArrivalMs: number;
  interArrivalVarianceMs2: number;
  distinctMarketKeys: number;
}

/**
 * Classifies a wager leg into `LIVE_IN_PLAY` when either the GSLive bridge flag is set
 * or the packed 15-bit combo key encodes `wagerType3 = 7` (in-play).
 */
export function classifyWagerRegime(
  packedComboKey15: SubSportComboPackedKey15,
  isGsLiveBridge: boolean,
): WagerRegime {
  if (isGsLiveBridge) return "LIVE_IN_PLAY";
  const wagerType3 = (packedComboKey15 >>> WAGER_TYPE_SHIFT) & WAGER_TYPE_MASK;
  return wagerType3 === LIVE_WAGER_TYPE_CODE3 ? "LIVE_IN_PLAY" : "PREGAME";
}

/**
 * Computes a 32-bit line signature tailored per regime:
 * - `LIVE_IN_PLAY`: price-elastic (ignores `linePoints100` tick drift; keys on side & marketKind).
 * - `PREGAME`: line-sensitive (hashes `linePoints100` alongside side & marketKind).
 */
export function computeRegimeLineSig32(
  regime: WagerRegime,
  sideCode2: number,
  marketKind2: number,
  linePoints100: number,
): number {
  const side = sideCode2 & 0x3;
  const market = marketKind2 & 0x3;
  if (regime === "LIVE_IN_PLAY") {
    return (0x8000_0000 | (market << 2) | side) >>> 0;
  }
  const points = Math.trunc(linePoints100) | 0;
  const mixed =
    Math.imul(points ^ 0x9e3779b1, 0x85ebca6b) ^ (market << 2) ^ side;
  return (mixed & 0x7fff_ffff) >>> 0 || 1;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}

function popcount32(value: number): number {
  let v = value;
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export class SyndicateTrackerArena {
  private readonly maxCustomers: number;
  private readonly ringSlots: number;
  private readonly ringMask: number;
  private readonly edgeSlots: number;
  private readonly edgeMask: number;

  private readonly ringEventId: Uint32Array;
  private readonly ringKey15: Uint16Array;
  private readonly ringLineSig: Uint32Array;
  private readonly ringLeaderRow: Uint32Array;
  private readonly ringFirstMs: Float64Array;
  private readonly ringHitCount: Uint32Array;
  private readonly ringRegimeBit: Uint8Array;

  private readonly lastBetMs: Float64Array;
  private readonly burstCount: Uint32Array;
  private readonly ticketCount: Uint32Array;
  private readonly minInterArrivalMs: Float64Array;
  private readonly interArrivalSumMs: Float64Array;
  private readonly interArrivalSumSqMs: Float64Array;
  private readonly interArrivalCount: Uint32Array;
  private readonly distinctComboKeyBitset: Uint32Array;

  private readonly edgeLeader1: Uint32Array;
  private readonly edgeFollower1: Uint32Array;
  private readonly edgeCount: Uint32Array;
  private readonly edgeLagSumMs: Float64Array;
  private readonly edgeLastKey: Uint16Array;

  private readonly surgeEventId: Uint32Array;
  private readonly surgeWindowStartMs: Float64Array;
  private readonly surgeDistinctCount: Uint16Array;
  private readonly surgeMembers: Uint32Array;
  private surgeSuppressedTotal = 0;

  private readonly legacyEdgeView: SyndicateFollowEdge = {
    leaderCustomerRow: 0,
    followerCustomerRow: 0,
    followCountU32: 0,
    avgLagMsU32: 0,
    lastLagMsU32: 0,
    lastPackedComboKey15: 0,
  };

  private readonly dualEdgeView: SyndicateFollowEdge = {
    leaderCustomerRow: 0,
    followerCustomerRow: 0,
    regime: "PREGAME",
    regimeBit: REGIME_PREGAME,
    followClass: "PREGAME_API_BOT",
    followCountU32: 0,
    lagMsU32: 0,
    lastPackedComboKey15: 0,
  };

  constructor(maxCustomers: number, ringSlots = 4096, edgeSlots = 8192) {
    if (!Number.isInteger(maxCustomers) || maxCustomers <= 0) {
      throw new RangeError("ERR_DOD_BITFIELD_RANGE_OVERFLOW: maxCustomers");
    }
    if (!isPowerOfTwo(ringSlots)) {
      throw new RangeError(
        "ERR_DOD_BITFIELD_RANGE_OVERFLOW: ringSlots must be a power of two",
      );
    }
    if (!isPowerOfTwo(edgeSlots)) {
      throw new RangeError(
        "ERR_DOD_BITFIELD_RANGE_OVERFLOW: edgeSlots must be a power of two",
      );
    }
    this.maxCustomers = maxCustomers;
    this.ringSlots = ringSlots;
    this.ringMask = ringSlots - 1;
    this.edgeSlots = edgeSlots;
    this.edgeMask = edgeSlots - 1;

    this.ringEventId = new Uint32Array(ringSlots);
    this.ringKey15 = new Uint16Array(ringSlots);
    this.ringLineSig = new Uint32Array(ringSlots);
    this.ringLeaderRow = new Uint32Array(ringSlots);
    this.ringFirstMs = new Float64Array(ringSlots);
    this.ringHitCount = new Uint32Array(ringSlots);
    this.ringRegimeBit = new Uint8Array(ringSlots);

    this.lastBetMs = new Float64Array(maxCustomers);
    this.burstCount = new Uint32Array(maxCustomers);
    this.ticketCount = new Uint32Array(maxCustomers);
    this.minInterArrivalMs = new Float64Array(maxCustomers);
    this.interArrivalSumMs = new Float64Array(maxCustomers);
    this.interArrivalSumSqMs = new Float64Array(maxCustomers);
    this.interArrivalCount = new Uint32Array(maxCustomers);
    this.distinctComboKeyBitset = new Uint32Array(maxCustomers * 1024);

    this.edgeLeader1 = new Uint32Array(edgeSlots);
    this.edgeFollower1 = new Uint32Array(edgeSlots);
    this.edgeCount = new Uint32Array(edgeSlots);
    this.edgeLagSumMs = new Float64Array(edgeSlots);
    this.edgeLastKey = new Uint16Array(edgeSlots);

    this.surgeEventId = new Uint32Array(SURGE_SLOTS);
    this.surgeWindowStartMs = new Float64Array(SURGE_SLOTS);
    this.surgeDistinctCount = new Uint16Array(SURGE_SLOTS);
    this.surgeMembers = new Uint32Array(SURGE_SLOTS * SURGE_MEMBER_CAP);
  }

  get broadcastSurgeSuppressedCount(): number {
    return this.surgeSuppressedTotal;
  }

  /**
   * Hot-path ingest supporting both legacy `(customerRow, eventId32, packedComboKey15, lineSig32, nowEpochMs, followWindowMs?)`
   * and dual-regime `(customerRow, eventId32, packedComboKey15, sideCode2, linePoints100, nowEpochMs, isGsLiveBridge)`.
   */
  observeWagerLeg(
    customerRow: number,
    eventId32: number,
    packedComboKey15: SubSportComboPackedKey15,
    lineSig32: number,
    nowEpochMs: number,
    followWindowMs?: number,
  ): SyndicateFollowEdge | null;
  observeWagerLeg(
    customerRow: number,
    eventId32: number,
    packedComboKey15: SubSportComboPackedKey15,
    sideCode2: number,
    linePoints100: number,
    nowEpochMs: number,
    isGsLiveBridge: boolean,
  ): SyndicateFollowEdge | null;
  observeWagerLeg(
    customerRow: number,
    eventId32: number,
    packedComboKey15: SubSportComboPackedKey15,
    arg4: number,
    arg5: number,
    arg6?: number,
    arg7?: boolean,
  ): SyndicateFollowEdge | null {
    const isDualRegime = typeof arg7 === "boolean";
    const nowEpochMs = isDualRegime ? (arg6 ?? 0) : arg5;
    const regime: WagerRegime = isDualRegime
      ? classifyWagerRegime(packedComboKey15, arg7)
      : "PREGAME";
    const followWindowMs = isDualRegime
      ? regime === "LIVE_IN_PLAY"
        ? LIVE_BOT_FOLLOW_WINDOW_MS
        : PREGAME_TIP_CHANNEL_WINDOW_MS
      : (arg6 ?? 15_000);
    const lineSig32 = isDualRegime
      ? computeRegimeLineSig32(
          regime,
          arg4,
          packedComboKey15 & MARKET_KIND_MASK,
          arg5,
        )
      : arg4;

    if (
      !Number.isInteger(customerRow) ||
      customerRow < 0 ||
      customerRow >= this.maxCustomers
    ) {
      throw new RangeError(
        `ERR_DOD_BITFIELD_RANGE_OVERFLOW: customerRow=${String(customerRow)}`,
      );
    }
    if (!Number.isInteger(eventId32) || eventId32 <= 0) {
      throw new RangeError(
        `ERR_DOD_BITFIELD_RANGE_OVERFLOW: eventId32=${String(eventId32)}`,
      );
    }
    if (
      !Number.isInteger(packedComboKey15) ||
      packedComboKey15 < 0 ||
      packedComboKey15 > COMBO_KEY15_MASK
    ) {
      throw new RangeError(
        `ERR_DOD_BITFIELD_RANGE_OVERFLOW: packedComboKey15=${String(packedComboKey15)}`,
      );
    }
    if (!Number.isFinite(nowEpochMs) || nowEpochMs <= 0) {
      throw new RangeError(
        `ERR_DOD_BITFIELD_RANGE_OVERFLOW: nowEpochMs=${String(nowEpochMs)}`,
      );
    }
    if (!Number.isFinite(followWindowMs) || followWindowMs <= 0) {
      throw new RangeError(
        `ERR_DOD_BITFIELD_RANGE_OVERFLOW: followWindowMs=${String(followWindowMs)}`,
      );
    }

    // 1. Per-customer cadence and market-breadth bitset.
    const previousMs = this.lastBetMs[customerRow]!;
    if (previousMs > 0) {
      const deltaMs = nowEpochMs - previousMs;
      if (deltaMs >= 0) {
        if (deltaMs < BURST_MS) this.burstCount[customerRow]!++;
        const interCount = this.interArrivalCount[customerRow]!;
        if (
          interCount === 0 ||
          deltaMs < this.minInterArrivalMs[customerRow]!
        ) {
          this.minInterArrivalMs[customerRow] = deltaMs;
        }
        this.interArrivalCount[customerRow] = interCount + 1;
        this.interArrivalSumMs[customerRow]! += deltaMs;
        this.interArrivalSumSqMs[customerRow]! += deltaMs * deltaMs;
      }
    }
    this.lastBetMs[customerRow] = nowEpochMs;
    this.ticketCount[customerRow]!++;

    const bitWord = (customerRow << 10) + (packedComboKey15 >>> 5);
    this.distinctComboKeyBitset[bitWord]! |= 1 << (packedComboKey15 & 31);

    // 2. TV broadcast-surge suppression for live events (>8 distinct accounts within 3,000ms).
    if (
      isDualRegime &&
      regime === "LIVE_IN_PLAY" &&
      this.checkAndRecordBroadcastSurge(eventId32, customerRow, nowEpochMs)
    ) {
      this.surgeSuppressedTotal++;
      return null;
    }

    // 3. Leader/follower ring.
    const lineSig = lineSig32 >>> 0;
    const regimeBit =
      regime === "LIVE_IN_PLAY" ? REGIME_LIVE_IN_PLAY : REGIME_PREGAME;
    let slot =
      (Math.imul(eventId32 ^ packedComboKey15, RING_HASH) ^ lineSig) &
      this.ringMask;
    for (let probe = 0; probe < this.ringSlots; probe += 1) {
      const slotEvent = this.ringEventId[slot]!;
      const firstMs = this.ringFirstMs[slot]!;
      const expired = slotEvent !== 0 && nowEpochMs - firstMs > followWindowMs;

      if (slotEvent === 0 || expired) {
        this.ringEventId[slot] = eventId32;
        this.ringKey15[slot] = packedComboKey15;
        this.ringLineSig[slot] = lineSig;
        this.ringLeaderRow[slot] = customerRow;
        this.ringFirstMs[slot] = nowEpochMs;
        this.ringHitCount[slot] = 1;
        this.ringRegimeBit[slot] = regimeBit;
        return null;
      }

      if (
        slotEvent === eventId32 &&
        this.ringKey15[slot] === packedComboKey15 &&
        this.ringLineSig[slot] === lineSig &&
        (!isDualRegime || this.ringRegimeBit[slot] === regimeBit)
      ) {
        const leaderRow = this.ringLeaderRow[slot]!;
        if (leaderRow === customerRow) return null;

        const lagMs = nowEpochMs - firstMs;
        if (lagMs < 0) return null;
        this.ringHitCount[slot]!++;

        const edgeIndex = this.upsertEdge(
          leaderRow,
          customerRow,
          lagMs,
          packedComboKey15,
        );
        if (edgeIndex < 0) return null;

        if (!isDualRegime) {
          this.legacyEdgeView.leaderCustomerRow = leaderRow;
          this.legacyEdgeView.followerCustomerRow = customerRow;
          this.legacyEdgeView.followCountU32 = this.edgeCount[edgeIndex]!;
          this.legacyEdgeView.avgLagMsU32 = Math.round(
            this.edgeLagSumMs[edgeIndex]! / this.edgeCount[edgeIndex]!,
          );
          this.legacyEdgeView.lastPackedComboKey15 =
            this.edgeLastKey[edgeIndex]!;
          return this.legacyEdgeView;
        }

        const followClass: FollowClass =
          regime === "LIVE_IN_PLAY"
            ? "LIVE_FEED_BOT"
            : lagMs <= PREGAME_API_BOT_WINDOW_MS
              ? "PREGAME_API_BOT"
              : "PREGAME_TIP_CHANNEL";
        this.dualEdgeView.leaderCustomerRow = leaderRow;
        this.dualEdgeView.followerCustomerRow = customerRow;
        this.dualEdgeView.regime = regime;
        this.dualEdgeView.regimeBit = regimeBit;
        this.dualEdgeView.followClass = followClass;
        this.dualEdgeView.followCountU32 = this.ringHitCount[slot]!;
        this.dualEdgeView.lagMsU32 = Math.round(lagMs);
        this.dualEdgeView.lastPackedComboKey15 = packedComboKey15;
        return this.dualEdgeView;
      }

      slot = (slot + 1) & this.ringMask;
    }
    return null;
  }

  private checkAndRecordBroadcastSurge(
    eventId32: number,
    customerRow: number,
    nowEpochMs: number,
  ): boolean {
    const member1 = customerRow + 1;
    let slot = Math.imul(eventId32, RING_HASH) & SURGE_SLOT_MASK;
    for (let probe = 0; probe < SURGE_SLOTS; probe += 1) {
      const storedEvent = this.surgeEventId[slot]!;
      const startMs = this.surgeWindowStartMs[slot]!;
      const expired =
        storedEvent !== 0 &&
        nowEpochMs - startMs > LIVE_BROADCAST_SURGE_WINDOW_MS;
      if (storedEvent === 0 || expired) {
        const oldCount = Math.min(
          this.surgeDistinctCount[slot]!,
          SURGE_MEMBER_CAP,
        );
        const base = slot * SURGE_MEMBER_CAP;
        for (let i = 0; i < oldCount; i += 1) {
          this.surgeMembers[base + i] = 0;
        }
        this.surgeEventId[slot] = eventId32;
        this.surgeWindowStartMs[slot] = nowEpochMs;
        this.surgeDistinctCount[slot] = 1;
        this.surgeMembers[base] = member1;
        return false;
      }
      if (storedEvent === eventId32) {
        const count = this.surgeDistinctCount[slot]!;
        const checkLen = Math.min(count, SURGE_MEMBER_CAP);
        const base = slot * SURGE_MEMBER_CAP;
        for (let i = 0; i < checkLen; i += 1) {
          if (this.surgeMembers[base + i] === member1) {
            return count > LIVE_BROADCAST_SURGE_ACCOUNT_CAP;
          }
        }
        if (count < SURGE_MEMBER_CAP) {
          this.surgeMembers[base + count] = member1;
        }
        const nextCount = count + 1;
        this.surgeDistinctCount[slot] = nextCount;
        return nextCount > LIVE_BROADCAST_SURGE_ACCOUNT_CAP;
      }
      slot = (slot + 1) & SURGE_SLOT_MASK;
    }
    return false;
  }

  private upsertEdge(
    leaderRow: number,
    followerRow: number,
    lagMs: number,
    packedComboKey15: number,
  ): number {
    const leader1 = leaderRow + 1;
    const follower1 = followerRow + 1;
    let index =
      (Math.imul(leaderRow ^ RING_HASH, EDGE_HASH) ^ followerRow) &
      this.edgeMask;
    for (let probe = 0; probe < this.edgeSlots; probe += 1) {
      const storedLeader = this.edgeLeader1[index]!;
      if (storedLeader === 0) {
        this.edgeLeader1[index] = leader1;
        this.edgeFollower1[index] = follower1;
        this.edgeCount[index] = 1;
        this.edgeLagSumMs[index] = lagMs;
        this.edgeLastKey[index] = packedComboKey15;
        return index;
      }
      if (storedLeader === leader1 && this.edgeFollower1[index] === follower1) {
        this.edgeCount[index]!++;
        this.edgeLagSumMs[index]! += lagMs;
        this.edgeLastKey[index] = packedComboKey15;
        return index;
      }
      index = (index + 1) & this.edgeMask;
    }
    return -1;
  }

  /** Directed leader->follower hit count; 0 when no edge was recorded. */
  getEdgeWeight(leaderRow: number, followerRow: number): number {
    const index = this.findEdge(leaderRow, followerRow);
    return index < 0 ? 0 : this.edgeCount[index]!;
  }

  getEdgeAvgLagMs(leaderRow: number, followerRow: number): number {
    const index = this.findEdge(leaderRow, followerRow);
    if (index < 0) return 0;
    const count = this.edgeCount[index]!;
    return count === 0 ? 0 : Math.round(this.edgeLagSumMs[index]! / count);
  }

  private findEdge(leaderRow: number, followerRow: number): number {
    const leader1 = leaderRow + 1;
    const follower1 = followerRow + 1;
    let index =
      (Math.imul(leaderRow ^ RING_HASH, EDGE_HASH) ^ followerRow) &
      this.edgeMask;
    for (let probe = 0; probe < this.edgeSlots; probe += 1) {
      const storedLeader = this.edgeLeader1[index]!;
      if (storedLeader === 0) return -1;
      if (storedLeader === leader1 && this.edgeFollower1[index] === follower1) {
        return index;
      }
      index = (index + 1) & this.edgeMask;
    }
    return -1;
  }

  getDistinctMarketKeys(customerRow: number): number {
    let distinct = 0;
    const base = customerRow << 10;
    for (let word = 0; word < 1024; word += 1) {
      distinct += popcount32(this.distinctComboKeyBitset[base + word]!);
    }
    return distinct;
  }

  /** Cold-path summary; allocates one object per call. */
  getBotCadenceMetrics(customerRow: number): BotCadenceMetrics {
    const total = this.ticketCount[customerRow]!;
    const bursts = this.burstCount[customerRow]!;
    const interCount = this.interArrivalCount[customerRow]!;
    const mean =
      interCount > 0 ? this.interArrivalSumMs[customerRow]! / interCount : 0;
    const variance =
      interCount > 0
        ? Math.max(
            0,
            this.interArrivalSumSqMs[customerRow]! / interCount - mean * mean,
          )
        : 0;
    return {
      totalTickets: total,
      subSecondBurstCount: bursts,
      subSecondBurstRatio: total > 0 ? bursts / total : 0,
      minInterArrivalMs:
        interCount > 0 ? this.minInterArrivalMs[customerRow]! : 0,
      interArrivalVarianceMs2: variance,
      distinctMarketKeys: this.getDistinctMarketKeys(customerRow),
    };
  }
}
