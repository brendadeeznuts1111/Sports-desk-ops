/**
 * @file rsk06_delay_recommender.ts
 * @description RSK-06 Live 10s-12s Delay Engine & GSLive/Fantasy402 Decoupled Evaluator (DOD6 v5.5).
 *
 * ARCHITECTURAL PARTITION INVARIANTS:
 * 1. Stream Provenance:
 *    - GSLive Partner 118 telemetry provides in-play velocity and betGroupIdNumeric (EP09_GSLIVE_118).
 *    - Fantasy402 ticket history provides wagerNumber and customer accounts (EP03_BET_TICKER).
 *    - The two watermark progressions are strictly separated and never conflated.
 * 2. Mutation Target Restriction:
 *    - GSLive has ZERO mutation ability (read-only telemetry).
 *    - Defensive delay clamps (Delay="10"|"11"|"12") route exclusively to cloud.fantasy402.com
 *      via Fantasy402ManagerWorker, using 11-char PaddedCustomerId and direct leaf agentID.
 * 3. Dynamic Capacity & Bitset Invariants (WM-2, BITS-1, BITS-2):
 *    - liveObservedCandidateCount = activeInPlayCustomerCount + shieldedVipCount
 *    - growthHeadroomCount = Math.max(64, liveObservedCandidateCount >>> 2)
 *    - derivedDelayArenaCapacity = Math.ceil((liveObservedCandidateCount + growthHeadroomCount) / 64) * 64
 *    - wordCount32 = derivedDelayArenaCapacity >>> 5
 *    - Pairwise disjointness across tier1Words32 (12s), tier2Words32 (11s), tier3Words32 (10s)
 *    - VIP shield orthogonality: ((T1 | T2 | T3) & shieldedVipWords32) === 0
 */

import {
  Fantasy402ManagerWorker,
  type PlayerClampResult,
} from "./f402_manager.ts";

export interface CandidateAccountTelemetry {
  readonly rowIndex: number;
  readonly customerLogin: string;
  readonly leafAgent: string;
  readonly inPlayVelocityScore: number; // e.g. bets in last 30s
  readonly isVipShielded: boolean;
  readonly currentDelaySeconds: number;
  readonly oddsSnipeConfidence: number; // [0..1]
  readonly syndicateTwinConfirmed: boolean;
}

export interface DelayArenaCapacityAudit {
  readonly liveObservedCandidateCount: number;
  readonly growthHeadroomCount: number;
  readonly derivedDelayArenaCapacity: number;
  readonly wordCount32: number;
}

export interface DelayEvaluationResult {
  readonly audit: DelayArenaCapacityAudit;
  readonly tier1Words32: Uint32Array; // 12s
  readonly tier2Words32: Uint32Array; // 11s
  readonly tier3Words32: Uint32Array; // 10s
  readonly shieldedVipWords32: Uint32Array;
  readonly tier1Count: number;
  readonly tier2Count: number;
  readonly tier3Count: number;
  readonly shieldedVipCount: number;
  readonly gsliveWatermarkBetGroupId: number;
  readonly f402WatermarkWagerNumber: number;
}

/**
 * Rich domain representation of DelayEvaluationResult with Bun.inspect.custom.
 */
export class DelayEvaluationReport implements DelayEvaluationResult {
  constructor(
    public readonly audit: DelayArenaCapacityAudit,
    public readonly tier1Words32: Uint32Array,
    public readonly tier2Words32: Uint32Array,
    public readonly tier3Words32: Uint32Array,
    public readonly shieldedVipWords32: Uint32Array,
    public readonly tier1Count: number,
    public readonly tier2Count: number,
    public readonly tier3Count: number,
    public readonly shieldedVipCount: number,
    public readonly gsliveWatermarkBetGroupId: number,
    public readonly f402WatermarkWagerNumber: number,
  ) {}

  [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const c = options?.colors === true;
    const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
    const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
    const green = (s: string) => (c ? `\x1b[32m${s}\x1b[39m` : s);
    const yellow = (s: string) => (c ? `\x1b[33m${s}\x1b[39m` : s);

    return [
      `${bold("DelayEvaluationReport")} (RSK-06 Live 10s-12s Engine)`,
      `  ${cyan("CapacityAudit (WM-2):")} observedCandidates=${this.audit.liveObservedCandidateCount} headroom=${this.audit.growthHeadroomCount} arenaCapacity=${this.audit.derivedDelayArenaCapacity} words32=${this.audit.wordCount32}`,
      `  ${cyan("Watermarks:")} GSLive_GID=${green(String(this.gsliveWatermarkBetGroupId))} (EP09) | F402_Wager=${green(String(this.f402WatermarkWagerNumber))} (EP03)`,
      `  ${cyan("Tiers:")} Tier1(12s)=${yellow(String(this.tier1Count))} Tier2(11s)=${yellow(String(this.tier2Count))} Tier3(10s)=${yellow(String(this.tier3Count))} VIP_Shield=${green(String(this.shieldedVipCount))}`,
    ].join("\n");
  }
}

/** Population count for 32-bit bitset words. */
export function popcountUint32Words(words: Uint32Array): number {
  let count = 0;
  for (let i = 0; i < words.length; i += 1) {
    let v = words[i]!;
    v -= (v >>> 1) & 0x55555555;
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    count += (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  }
  return count;
}

/**
 * Derives dynamic arena capacity and word count (WM-2).
 */
export function deriveDelayArenaCapacity(
  liveObservedCandidateCount: number,
): DelayArenaCapacityAudit {
  const safeCount = Math.max(0, Math.floor(liveObservedCandidateCount));
  const growthHeadroomCount = Math.max(64, safeCount >>> 2);
  const derivedDelayArenaCapacity =
    Math.ceil((safeCount + growthHeadroomCount) / 64) * 64;
  const wordCount32 = derivedDelayArenaCapacity >>> 5;

  return {
    liveObservedCandidateCount: safeCount,
    growthHeadroomCount,
    derivedDelayArenaCapacity,
    wordCount32,
  };
}

/**
 * Invariant Verification (BITS-2):
 * - Pairwise disjointness across T1, T2, T3
 * - VIP shield orthogonality
 * - Popcount bound
 */
export function verifyDelayBitsetInvariants(
  tier1: Uint32Array,
  tier2: Uint32Array,
  tier3: Uint32Array,
  shieldedVip: Uint32Array,
  audit: DelayArenaCapacityAudit,
): void {
  const words = tier1.length;
  if (
    tier2.length !== words ||
    tier3.length !== words ||
    shieldedVip.length !== words
  ) {
    throw new Error("All delay tier bitsets must share identical wordCount32");
  }

  for (let w = 0; w < words; w += 1) {
    const t1 = tier1[w]!;
    const t2 = tier2[w]!;
    const t3 = tier3[w]!;
    const vip = shieldedVip[w]!;

    if ((t1 & t2) !== 0) {
      throw new Error(
        `BITS-2 violation: Tier 1 (12s) and Tier 2 (11s) overlap at word ${w}`,
      );
    }
    if ((t1 & t3) !== 0) {
      throw new Error(
        `BITS-2 violation: Tier 1 (12s) and Tier 3 (10s) overlap at word ${w}`,
      );
    }
    if ((t2 & t3) !== 0) {
      throw new Error(
        `BITS-2 violation: Tier 2 (11s) and Tier 3 (10s) overlap at word ${w}`,
      );
    }
    if (((t1 | t2 | t3) & vip) !== 0) {
      throw new Error(
        `BITS-2 violation: Delay tiers overlap with VIP Shield at word ${w}`,
      );
    }
  }

  const totalPopcount =
    popcountUint32Words(tier1) +
    popcountUint32Words(tier2) +
    popcountUint32Words(tier3);

  if (totalPopcount > audit.derivedDelayArenaCapacity) {
    throw new Error(
      `Popcount ${totalPopcount} exceeds derived delay arena capacity ${audit.derivedDelayArenaCapacity}`,
    );
  }
}

/**
 * RSK-06 Live Delay Engine:
 * Ingests live candidate telemetry from GSLive velocity and Fantasy402 ticket history,
 * derives dynamic capacity, populates bitsets, and verifies invariants.
 */
export class Rsk06DelayRecommender {
  constructor(
    readonly worker: Fantasy402ManagerWorker = new Fantasy402ManagerWorker(),
  ) {}

  /**
   * Evaluates delay recommendations across candidates while strictly partitioning
   * GSLive watermark (betGroupIdNumeric) and Fantasy402 watermark (lastWagerNumber).
   */
  evaluateRecommendations(options: {
    candidates: readonly CandidateAccountTelemetry[];
    gsliveLastBetGroupIdNumeric: number;
    f402LastWagerNumber: number;
  }): DelayEvaluationResult {
    const { candidates, gsliveLastBetGroupIdNumeric, f402LastWagerNumber } =
      options;
    const audit = deriveDelayArenaCapacity(candidates.length);

    const tier1Words32 = new Uint32Array(audit.wordCount32);
    const tier2Words32 = new Uint32Array(audit.wordCount32);
    const tier3Words32 = new Uint32Array(audit.wordCount32);
    const shieldedVipWords32 = new Uint32Array(audit.wordCount32);

    const setBit = (arr: Uint32Array, bit: number) => {
      const w = bit >>> 5;
      if (w < arr.length) {
        arr[w] = (arr[w] ?? 0) | (1 << (bit & 31));
      }
    };

    for (const c of candidates) {
      const idx = c.rowIndex;
      if (idx >= audit.derivedDelayArenaCapacity) continue;

      if (c.isVipShielded) {
        setBit(shieldedVipWords32, idx);
        continue;
      }

      // Tier 1: Live execution sniper -> 12s delay
      if (c.oddsSnipeConfidence >= 0.85 && c.inPlayVelocityScore >= 5) {
        setBit(tier1Words32, idx);
        continue;
      }

      // Tier 2: Syndicate twin confirmed -> 11s delay
      if (c.syndicateTwinConfirmed) {
        setBit(tier2Words32, idx);
        continue;
      }

      // Tier 3: Verified live sharp -> 10s delay
      if (c.oddsSnipeConfidence >= 0.65 && c.currentDelaySeconds < 10) {
        setBit(tier3Words32, idx);
        continue;
      }
    }

    verifyDelayBitsetInvariants(
      tier1Words32,
      tier2Words32,
      tier3Words32,
      shieldedVipWords32,
      audit,
    );

    return new DelayEvaluationReport(
      audit,
      tier1Words32,
      tier2Words32,
      tier3Words32,
      shieldedVipWords32,
      popcountUint32Words(tier1Words32),
      popcountUint32Words(tier2Words32),
      popcountUint32Words(tier3Words32),
      popcountUint32Words(shieldedVipWords32),
      gsliveLastBetGroupIdNumeric,
      f402LastWagerNumber,
    );
  }

  [Bun.inspect.custom](
    _depth: number,
    options: { colors?: boolean } = {},
  ): string {
    const c = options?.colors === true;
    const bold = (s: string) => (c ? `\x1b[1m${s}\x1b[22m` : s);
    const cyan = (s: string) => (c ? `\x1b[36m${s}\x1b[39m` : s);
    return `${bold("Rsk06DelayRecommender")}(${cyan("target=")}"cloud.fantasy402.com", ${cyan("worker=")}${this.worker.constructor.name})`;
  }

  /**
   * Safely dispatches live delay recommendations to Fantasy402 Manager.
   * Maps bitset bits back to CustomerSpine rowIndex, obtains PaddedCustomerId,
   * and routes exclusively to cloud.fantasy402.com (never GSLive).
   */
  async dispatchRecommendedClamps(
    result: DelayEvaluationResult,
    candidates: readonly CandidateAccountTelemetry[],
    authHeaders?: Record<string, string>,
    fetchImpl?: typeof fetch,
  ): Promise<readonly PlayerClampResult[]> {
    const results: PlayerClampResult[] = [];
    const candidateMap = new Map<number, CandidateAccountTelemetry>();
    for (const c of candidates) {
      candidateMap.set(c.rowIndex, c);
    }

    const checkBit = (arr: Uint32Array, bit: number): boolean => {
      const w = bit >>> 5;
      return w < arr.length && (arr[w]! & (1 << (bit & 31))) !== 0;
    };

    for (let idx = 0; idx < result.audit.derivedDelayArenaCapacity; idx += 1) {
      const candidate = candidateMap.get(idx);
      if (!candidate) continue;

      let delayToApply: "10" | "11" | "12" | null = null;
      if (checkBit(result.tier1Words32, idx)) delayToApply = "12";
      else if (checkBit(result.tier2Words32, idx)) delayToApply = "11";
      else if (checkBit(result.tier3Words32, idx)) delayToApply = "10";

      if (delayToApply !== null) {
        // Enforces resolving back to CustomerSpine & Fantasy402 leaf agent
        const clampRes = await this.worker.clampLiveDelay(
          candidate.customerLogin,
          candidate.leafAgent,
          delayToApply,
          authHeaders,
          fetchImpl,
        );
        results.push(clampRes);
      }
    }

    return results;
  }
}
