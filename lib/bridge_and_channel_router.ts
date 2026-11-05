/**
 * @fileoverview 1972-IBM Specification-Grade & DOD6 v5.4 Frozen Spec
 * Transport Ingestion Bridge vs. Signal Channel Demultiplexing Architecture.
 *
 * Enforces all P0 Naming & Memory Invariants (`specification-grade-naming`):
 *  1. Branded Unit Types: `Cents`, `SettledCents`, `LifetimeCents`, `BasisPoints`,
 *     `LineHundredths`, `EpochDays`, `DurationMilliseconds`, `RotationNumber`.
 *  2. Bit-Packed Unsigned Words & Handles: `BridgeChannelPackedWord32`,
 *     `CustomerPackedHandle32`, `CustomerPackedHandle64`, `CustomerPackedKey64`,
 *     `TransportBridgeBitMask32` (`BitSet32`).
 *  3. Explicit Sentinels: `NULL_CLV_SENTINEL = -2147483648`,
 *     `NULL_CUSTOMER_HANDLE32 = 0xFFFFFFFF`, `NULL_CUSTOMER_HANDLE64 = 0xFFFFFFFFFFFFFFFFn`,
 *     `NULL_BRIDGE_CHANNEL_WORD32 = 0xFFFFFFFF`, `EMPTY_R2_OBJECT_KEY_SENTINEL = ""`.
 *  4. Structure-of-Arrays (`BridgeChannelRouteColumnStore`) with `<metricName><Unit>Col`
 *     unsigned/fixed-point typed arrays and zero `boolean[]` / zero dynamic `T[]` on hot paths.
 *  5. Stack-Allocated `InlineCapacityList8<T>` for bounded parlay leg buffers.
 *  6. Structured `DodGateFailureError` (`{ gate, section, rowIdx, expected, actual }`).
 */

// ============================================================================
// 1. BRANDED UNIT TYPES, BIT-PACKED HANDLES & EXPLICIT SENTINELS
// ============================================================================

export type Cents = number & { readonly __brand: "Cents" };
export type SettledCents = number & { readonly __brand: "SettledCents" };
export type LifetimeCents = number & { readonly __brand: "LifetimeCents" };
export type BasisPoints = number & { readonly __brand: "BasisPoints" };
export type LineHundredths = number & { readonly __brand: "LineHundredths" };
export type EpochDays = number & { readonly __brand: "EpochDays" };
export type DurationMilliseconds = number & {
  readonly __brand: "DurationMilliseconds";
};
export type RotationNumber = number & { readonly __brand: "RotationNumber" };

export type BitSet32 = number & { readonly __brand: "BitSet32" };
export type TransportBridgeBitMask32 = number & {
  readonly __brand: "TransportBridgeBitMask32";
};
export type BridgeChannelPackedWord32 = number & {
  readonly __brand: "BridgeChannelPackedWord32";
};
export type CustomerPackedHandle32 = number & {
  readonly __brand: "CustomerPackedHandle32";
};
export type CustomerPackedHandle64 = bigint & {
  readonly __brand: "CustomerPackedHandle64";
};
export type CustomerPackedKey64 = bigint & {
  readonly __brand: "CustomerPackedKey64";
};
export type ComboPackedKey15 = number & {
  readonly __brand: "ComboPackedKey15";
};

export const NULL_CLV_SENTINEL = -2147483648 as LineHundredths;
export const NULL_CUSTOMER_HANDLE32 = 0xffffffff as CustomerPackedHandle32;
export const NULL_CUSTOMER_HANDLE64 =
  0xffffffffffffffffn as CustomerPackedHandle64;
export const NULL_BRIDGE_CHANNEL_WORD32 =
  0xffffffff as BridgeChannelPackedWord32;
export const EMPTY_R2_OBJECT_KEY_SENTINEL = "" as const;

export interface DodGateFailureDetails {
  readonly gate: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  readonly section: string;
  readonly rowIdx?: number | undefined;
  readonly expected: string | number | bigint;
  readonly actual: string | number | bigint;
}

export class DodGateFailureError extends Error {
  public readonly gate: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
  public readonly section: string;
  public readonly rowIdx?: number | undefined;
  public readonly expected: string | number | bigint;
  public readonly actual: string | number | bigint;

  constructor(details: DodGateFailureDetails) {
    super(
      `[GATE-0${details.gate}] Section=${details.section}` +
        (details.rowIdx !== undefined ? ` Row=${details.rowIdx}` : "") +
        ` Expected=${String(details.expected)} Actual=${String(details.actual)}`,
    );
    this.name = "DodGateFailureError";
    this.gate = details.gate;
    this.section = details.section;
    this.rowIdx = details.rowIdx;
    this.expected = details.expected;
    this.actual = details.actual;
  }
}

export const asCents = (v: number): Cents => Math.trunc(v) as Cents;
export const asSettledCents = (v: number): SettledCents =>
  Math.trunc(v) as SettledCents;
export const asLifetimeCents = (v: number): LifetimeCents =>
  Math.trunc(v) as LifetimeCents;
export const asBasisPoints = (v: number): BasisPoints =>
  Math.trunc(v) as BasisPoints;
export const asLineHundredths = (v: number): LineHundredths =>
  Math.trunc(v) as LineHundredths;
export const asEpochDays = (v: number): EpochDays => Math.trunc(v) as EpochDays;
export const asDurationMilliseconds = (v: number): DurationMilliseconds =>
  Math.trunc(v) as DurationMilliseconds;
export const asBitSet32 = (v: number): BitSet32 => (v >>> 0) as BitSet32;
export const asTransportBridgeBitMask32 = (
  v: number,
): TransportBridgeBitMask32 => (v >>> 0) as TransportBridgeBitMask32;

export function assertValidRotationNumber(
  rawRotation: number,
  rowIdx?: number,
): RotationNumber {
  const n = Math.trunc(rawRotation);
  if (n < 0 || n > 1_048_575) {
    throw new DodGateFailureError({
      gate: 3,
      section: "SEC_ROTATION_20BIT_NON_ALIASING",
      rowIdx,
      expected: "0..1048575 (20-bit unsigned RotationNumber)",
      actual: rawRotation,
    });
  }
  return n as RotationNumber;
}

export function safeClvAbsLineHundredths(clv: LineHundredths): LineHundredths {
  if (clv === NULL_CLV_SENTINEL) return asLineHundredths(0);
  return asLineHundredths(clv < 0 ? -clv : clv);
}

// ============================================================================
// 2. INLINE CAPACITY BUFFER (`InlineCapacityList8<T>` — ZERO HEAP ARRAY GROWTH)
// ============================================================================

export class InlineCapacityList8<T> {
  private s0: T | undefined = undefined;
  private s1: T | undefined = undefined;
  private s2: T | undefined = undefined;
  private s3: T | undefined = undefined;
  private s4: T | undefined = undefined;
  private s5: T | undefined = undefined;
  private s6: T | undefined = undefined;
  private s7: T | undefined = undefined;
  private count = 0;

  public get length(): number {
    return this.count;
  }

  public push(item: T): void {
    switch (this.count) {
      case 0:
        this.s0 = item;
        break;
      case 1:
        this.s1 = item;
        break;
      case 2:
        this.s2 = item;
        break;
      case 3:
        this.s3 = item;
        break;
      case 4:
        this.s4 = item;
        break;
      case 5:
        this.s5 = item;
        break;
      case 6:
        this.s6 = item;
        break;
      case 7:
        this.s7 = item;
        break;
      default:
        throw new DodGateFailureError({
          gate: 4,
          section: "SEC_INLINE_CAPACITY_LIST_8",
          expected: "<= 8 inline slots",
          actual: this.count + 1,
        });
    }
    this.count += 1;
  }

  public at(index: number): T {
    if (index < 0 || index >= this.count) {
      throw new DodGateFailureError({
        gate: 4,
        section: "SEC_INLINE_CAPACITY_LIST_8_BOUNDS",
        rowIdx: index,
        expected: `0..${Math.max(0, this.count - 1)}`,
        actual: index,
      });
    }
    switch (index) {
      case 0:
        return this.s0 as T;
      case 1:
        return this.s1 as T;
      case 2:
        return this.s2 as T;
      case 3:
        return this.s3 as T;
      case 4:
        return this.s4 as T;
      case 5:
        return this.s5 as T;
      case 6:
        return this.s6 as T;
      default:
        return this.s7 as T;
    }
  }
}

// ============================================================================
// 3. AXIS 1 — TRANSPORT INGESTION BRIDGE SPECIFICATION (PROVENANCE LAYER)
// ============================================================================

export type TransportBridgeId =
  // 5 Canonical Internal Sportsbook Live Bridges (R2 + /api/live-bets ws.subscriptions)
  | "BRIDGE_00_GSLIVE_WAGERS_BY_STATE"
  | "BRIDGE_01_F402_BET_TICKER_STREAM"
  | "BRIDGE_02_F402_PENDING_AND_GRADING"
  | "BRIDGE_03_GSLIVE_PARTNER118_TALLY"
  | "BRIDGE_04_F402_WEBLOG_ACCESS_OVERLAP"
  // 5 Canonical Cross-Venue Exchange Bridges (Polymarket 4-API + FastLane + Kalshi v2)
  | "BRIDGE_05_POLYMARKET_GAMMA_DISCOVERY"
  | "BRIDGE_06_POLYMARKET_CLOB_WEBSOCKET"
  | "BRIDGE_07_POLYGON_FASTLANE_ORDER_FILLED"
  | "BRIDGE_08_POLYMARKET_DATA_API_POSITIONS"
  | "BRIDGE_09_KALSHI_EXCHANGE_V2_STREAM";

export type TransportOriginDomain =
  | "ORIGIN_SPORTSBOOK_FANTASY402"
  | "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118"
  | "ORIGIN_EXCHANGE_POLYMARKET_CTF"
  | "ORIGIN_EXCHANGE_KALSHI_REGULATED";

export type WebSocketSubscriptionTopic =
  | "wagers-by-state"
  | "f402-bet-ticker"
  | "f402-pending"
  | "gslive-tally"
  | "f402-weblog"
  | "cross-venue-polymarket"
  | "cross-venue-kalshi";

export interface TransportBridgeSpecification {
  readonly bridgeId: TransportBridgeId;
  readonly bridgeOrdinal4: number; // 4-bit unsigned ordinal [0..9]
  readonly originDomain: TransportOriginDomain;
  readonly webSocketSubscriptionTopic: WebSocketSubscriptionTopic;
  readonly r2LatestObjectKey: string; // Uses EMPTY_R2_OBJECT_KEY_SENTINEL ("") when stream-only
  readonly upstreamWireEndpoint: string;
  readonly deduplicationWatermarkContract: string;
  readonly freshnessSlaDurationMs: DurationMilliseconds;
}

export const TRANSPORT_BRIDGE_SPECIFICATION_TABLE: Readonly<
  Record<TransportBridgeId, TransportBridgeSpecification>
> = {
  BRIDGE_00_GSLIVE_WAGERS_BY_STATE: {
    bridgeId: "BRIDGE_00_GSLIVE_WAGERS_BY_STATE",
    bridgeOrdinal4: 0,
    originDomain: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    webSocketSubscriptionTopic: "wagers-by-state",
    r2LatestObjectKey: "wagers-by-state/latest.json",
    upstreamWireEndpoint:
      "POST https://plive.sportswidgets.pro/manager-tools/ajax.php (state rollup)",
    deduplicationWatermarkContract: "stateCode:epochDaysAmericaChicago",
    freshnessSlaDurationMs: asDurationMilliseconds(90_000),
  },
  BRIDGE_01_F402_BET_TICKER_STREAM: {
    bridgeId: "BRIDGE_01_F402_BET_TICKER_STREAM",
    bridgeOrdinal4: 1,
    originDomain: "ORIGIN_SPORTSBOOK_FANTASY402",
    webSocketSubscriptionTopic: "f402-bet-ticker",
    r2LatestObjectKey: "f402-bet-ticker/latest.json",
    upstreamWireEndpoint:
      "POST /cloud/api/Manager/getBetTicker (Bun.JSONL.parseChunk stream)",
    deduplicationWatermarkContract: "wagerNumberWatermark (fail-closed)",
    freshnessSlaDurationMs: asDurationMilliseconds(15_000),
  },
  BRIDGE_02_F402_PENDING_AND_GRADING: {
    bridgeId: "BRIDGE_02_F402_PENDING_AND_GRADING",
    bridgeOrdinal4: 2,
    originDomain: "ORIGIN_SPORTSBOOK_FANTASY402",
    webSocketSubscriptionTopic: "f402-pending",
    r2LatestObjectKey: "f402-pending/latest.json",
    upstreamWireEndpoint:
      "POST /cloud/api/Manager/getPending & POST /cloud/api/Report/getGrading",
    deduplicationWatermarkContract:
      "${TicketNumber}-${WagerNumber}-${totalPicks}",
    freshnessSlaDurationMs: asDurationMilliseconds(15_000),
  },
  BRIDGE_03_GSLIVE_PARTNER118_TALLY: {
    bridgeId: "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
    bridgeOrdinal4: 3,
    originDomain: "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118",
    webSocketSubscriptionTopic: "gslive-tally",
    r2LatestObjectKey: "gslive-tally/latest.json",
    upstreamWireEndpoint:
      "POST https://plive.sportswidgets.pro/manager-tools/ajax.php (GsLiveFullBitwiseRow32B)",
    deduplicationWatermarkContract: "M.G<betGroupId>",
    freshnessSlaDurationMs: asDurationMilliseconds(30_000),
  },
  BRIDGE_04_F402_WEBLOG_ACCESS_OVERLAP: {
    bridgeId: "BRIDGE_04_F402_WEBLOG_ACCESS_OVERLAP",
    bridgeOrdinal4: 4,
    originDomain: "ORIGIN_SPORTSBOOK_FANTASY402",
    webSocketSubscriptionTopic: "f402-weblog",
    r2LatestObjectKey: "f402-weblog/latest.json",
    upstreamWireEndpoint:
      "POST /cloud/api/Manager/getWebLog (Modes A/B/C/I & Mode 6 causal overlap)",
    deduplicationWatermarkContract:
      "loginKey64:accessEpochSeconds:subnetPrefix",
    freshnessSlaDurationMs: asDurationMilliseconds(3_600_000),
  },
  BRIDGE_05_POLYMARKET_GAMMA_DISCOVERY: {
    bridgeId: "BRIDGE_05_POLYMARKET_GAMMA_DISCOVERY",
    bridgeOrdinal4: 5,
    originDomain: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    webSocketSubscriptionTopic: "cross-venue-polymarket",
    r2LatestObjectKey: EMPTY_R2_OBJECT_KEY_SENTINEL,
    upstreamWireEndpoint:
      "GET https://gamma-api.polymarket.com/markets?active=true",
    deduplicationWatermarkContract: "conditionId:clobTokenId",
    freshnessSlaDurationMs: asDurationMilliseconds(60_000),
  },
  BRIDGE_06_POLYMARKET_CLOB_WEBSOCKET: {
    bridgeId: "BRIDGE_06_POLYMARKET_CLOB_WEBSOCKET",
    bridgeOrdinal4: 6,
    originDomain: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    webSocketSubscriptionTopic: "cross-venue-polymarket",
    r2LatestObjectKey: EMPTY_R2_OBJECT_KEY_SENTINEL,
    upstreamWireEndpoint:
      "wss://ws-subscriptions-clob.polymarket.com/ws/market (Path A)",
    deduplicationWatermarkContract: "assetId:orderHash",
    freshnessSlaDurationMs: asDurationMilliseconds(118),
  },
  BRIDGE_07_POLYGON_FASTLANE_ORDER_FILLED: {
    bridgeId: "BRIDGE_07_POLYGON_FASTLANE_ORDER_FILLED",
    bridgeOrdinal4: 7,
    originDomain: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    webSocketSubscriptionTopic: "cross-venue-polymarket",
    r2LatestObjectKey: EMPTY_R2_OBJECT_KEY_SENTINEL,
    upstreamWireEndpoint:
      "eth_subscribe('logs') CTF 0x4bFb...982E & NegRisk 0xC5d5...80a (Path B)",
    deduplicationWatermarkContract: "transactionHash:logIndex",
    freshnessSlaDurationMs: asDurationMilliseconds(164),
  },
  BRIDGE_08_POLYMARKET_DATA_API_POSITIONS: {
    bridgeId: "BRIDGE_08_POLYMARKET_DATA_API_POSITIONS",
    bridgeOrdinal4: 8,
    originDomain: "ORIGIN_EXCHANGE_POLYMARKET_CTF",
    webSocketSubscriptionTopic: "cross-venue-polymarket",
    r2LatestObjectKey: EMPTY_R2_OBJECT_KEY_SENTINEL,
    upstreamWireEndpoint:
      "GET https://data-api.polymarket.com/positions & /trades",
    deduplicationWatermarkContract: "proxyWallet0x:conditionId",
    freshnessSlaDurationMs: asDurationMilliseconds(180_000),
  },
  BRIDGE_09_KALSHI_EXCHANGE_V2_STREAM: {
    bridgeId: "BRIDGE_09_KALSHI_EXCHANGE_V2_STREAM",
    bridgeOrdinal4: 9,
    originDomain: "ORIGIN_EXCHANGE_KALSHI_REGULATED",
    webSocketSubscriptionTopic: "cross-venue-kalshi",
    r2LatestObjectKey: EMPTY_R2_OBJECT_KEY_SENTINEL,
    upstreamWireEndpoint:
      "wss://trading-api.kalshi.com/trade-api/ws/v2 & REST /trade-api/v2/portfolio",
    deduplicationWatermarkContract: "marketTicker:tradeId",
    freshnessSlaDurationMs: asDurationMilliseconds(250),
  },
};

// ============================================================================
// 4. AXIS 2 — SIGNAL CHANNEL POLICY SPECIFICATION (STAGE 1 & 1B ROUTING LAYER)
// ============================================================================

export type Stage1DroppedChannelCode = "NON_SPORTS_DROP" | "BLOCKED";

export type Stage1FastPathControlChannelCode = "GATEWAY";

export type Stage1bSportsbookGroupableChannelCode =
  | "ALERT"
  | "Internet"
  | "GSLIVE"
  | "GSBUILDER"
  | "LIVE_CWS"
  | "CSLEVEL2"
  | "PHONE"
  | "HOUSE_BOOK";

export type Stage1bCrossVenueGroupableChannelCode =
  | "CROSS_VENUE_SHADOW_WALLET_LEAD"
  | "CROSS_VENUE_QUARANTINE_SCALP_EXIT"
  | "CROSS_VENUE_SYNDICATE_CLUSTER_CONFIRM"
  | "CROSS_VENUE_RFQ_COMBO_LAYOFF"
  | "CROSS_VENUE_KEY_NUMBER_MIDDLE";

export type ExtendedSignalChannelCode =
  | Stage1DroppedChannelCode
  | Stage1FastPathControlChannelCode
  | Stage1bSportsbookGroupableChannelCode
  | Stage1bCrossVenueGroupableChannelCode;

export type RoutablePolicyKind =
  | "equilibrium_vig_sweep"
  | "source_alert_zero_volume"
  | "target_twin_min_stake_to_win"
  | "gs118_live_join"
  | "gs118_builder_join"
  | "ezl_cws_live_redirect"
  | "syndicate_secondary_feed"
  | "phone_clerk_audit"
  | "house_agent_entry"
  | "cross_venue_shadow_wallet_lead"
  | "cross_venue_quarantine_scalp_exit"
  | "cross_venue_syndicate_cluster_confirm"
  | "cross_venue_rfq_combo_layoff"
  | "cross_venue_key_number_middle";

export type SignalPolicyKindDiscriminant =
  "non_sports_excluded" | "drop_before_grouping" | RoutablePolicyKind;

export type Stage1RoutingDisposition =
  | "DISPOSITION_STAGE1_DROP"
  | "DISPOSITION_STAGE1_CONTROL_PLANE_FAST_PATH"
  | "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE"
  | "DISPOSITION_STAGE1B_CROSS_VENUE_GROUPABLE";

export type TreasuryCapitalSiloAllocation =
  | "SILO_UNALLOCATED"
  | "SILO_1_MATCHED_BOOK_150K"
  | "SILO_2_PERIOD_AND_LIVE_RFQ_62K5"
  | "SILO_3_SHADOW_MIRROR_37K5";

/**
 * Bitwise flags stored in `channelBehaviorFlagsBitSet32` (zero boolean fields).
 */
export const CHANNEL_FLAG_ZERO_CANONICAL_VOLUME = 1 << 0; // 0x01
export const CHANNEL_FLAG_PROMOTES_TO_LIVE_ROTATION = 1 << 1; // 0x02
export const CHANNEL_FLAG_BYPASSES_STAGE1B_GROUPING = 1 << 2; // 0x04
export const CHANNEL_FLAG_STEER_ELIGIBLE_BUILDER = 1 << 3; // 0x08
export const CHANNEL_FLAG_QUARANTINE_180S_ELIGIBLE = 1 << 4; // 0x10

export interface SignalChannelPolicySpecification {
  readonly channelCode: ExtendedSignalChannelCode;
  readonly channelOrdinal5: number; // 5-bit unsigned ordinal [0..15]
  readonly kind: SignalPolicyKindDiscriminant;
  readonly routingDisposition: Stage1RoutingDisposition;
  readonly treasuryCapitalSilo: TreasuryCapitalSiloAllocation;
  readonly vigSurchargeBasisPoints: BasisPoints;
  readonly executionSlaDurationMs: DurationMilliseconds;
  readonly permittedBridgeBitMask32: TransportBridgeBitMask32;
  readonly channelBehaviorFlagsBitSet32: BitSet32;
  readonly neuronTokenIdentifier: string;
}

const encodeBridgeMask32 = (
  ...bridgeOrdinals: readonly number[]
): TransportBridgeBitMask32 => {
  let mask = 0;
  for (let i = 0; i < bridgeOrdinals.length; i++) {
    mask |= 1 << bridgeOrdinals[i]!;
  }
  return asTransportBridgeBitMask32(mask);
};

// Bridge Ordinal Constants [0..9]
const ORD_B00_STATE = 0;
const ORD_B01_TICKER = 1;
const ORD_B02_PENDING = 2;
const ORD_B03_GSLIVE = 3;
const ORD_B04_WEBLOG = 4;
const ORD_B05_PM_GAMMA = 5;
const ORD_B06_PM_CLOB = 6;
const ORD_B07_PM_FASTLANE = 7;
const ORD_B08_PM_DATA = 8;
const ORD_B09_KALSHI = 9;

export const SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE: Readonly<
  Record<ExtendedSignalChannelCode, SignalChannelPolicySpecification>
> = {
  NON_SPORTS_DROP: {
    channelCode: "NON_SPORTS_DROP",
    channelOrdinal5: 0,
    kind: "non_sports_excluded",
    routingDisposition: "DISPOSITION_STAGE1_DROP",
    treasuryCapitalSilo: "SILO_UNALLOCATED",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(0),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_ZERO_CANONICAL_VOLUME |
        CHANNEL_FLAG_BYPASSES_STAGE1B_GROUPING,
    ),
    neuronTokenIdentifier: "L19.N0510",
  },
  BLOCKED: {
    channelCode: "BLOCKED",
    channelOrdinal5: 1,
    kind: "drop_before_grouping",
    routingDisposition: "DISPOSITION_STAGE1_DROP",
    treasuryCapitalSilo: "SILO_UNALLOCATED",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(0),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
      ORD_B04_WEBLOG,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_ZERO_CANONICAL_VOLUME |
        CHANNEL_FLAG_BYPASSES_STAGE1B_GROUPING,
    ),
    neuronTokenIdentifier: "L19.N0518",
  },
  GATEWAY: {
    channelCode: "GATEWAY",
    channelOrdinal5: 2,
    kind: "equilibrium_vig_sweep",
    routingDisposition: "DISPOSITION_STAGE1_CONTROL_PLANE_FAST_PATH",
    treasuryCapitalSilo: "SILO_1_MATCHED_BOOK_150K",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(1_000),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_BYPASSES_STAGE1B_GROUPING,
    ),
    neuronTokenIdentifier: "L20.N1105",
  },
  ALERT: {
    channelCode: "ALERT",
    channelOrdinal5: 3,
    kind: "source_alert_zero_volume",
    routingDisposition: "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE",
    treasuryCapitalSilo: "SILO_1_MATCHED_BOOK_150K",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(250),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_ZERO_CANONICAL_VOLUME,
    ),
    neuronTokenIdentifier: "L21.N0884",
  },
  Internet: {
    channelCode: "Internet",
    channelOrdinal5: 4,
    kind: "target_twin_min_stake_to_win",
    routingDisposition: "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE",
    treasuryCapitalSilo: "SILO_1_MATCHED_BOOK_150K",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(1_500),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B00_STATE,
      ORD_B01_TICKER,
      ORD_B02_PENDING,
      ORD_B04_WEBLOG,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(0),
    neuronTokenIdentifier: "L18.N0204",
  },
  GSLIVE: {
    channelCode: "GSLIVE",
    channelOrdinal5: 5,
    kind: "gs118_live_join",
    routingDisposition: "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE",
    treasuryCapitalSilo: "SILO_2_PERIOD_AND_LIVE_RFQ_62K5",
    vigSurchargeBasisPoints: asBasisPoints(20),
    executionSlaDurationMs: asDurationMilliseconds(500),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B00_STATE,
      ORD_B01_TICKER,
      ORD_B02_PENDING,
      ORD_B03_GSLIVE,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_PROMOTES_TO_LIVE_ROTATION,
    ),
    neuronTokenIdentifier: "L23.N0412",
  },
  GSBUILDER: {
    channelCode: "GSBUILDER",
    channelOrdinal5: 6,
    kind: "gs118_builder_join",
    routingDisposition: "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE",
    treasuryCapitalSilo: "SILO_1_MATCHED_BOOK_150K",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(1_000),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B00_STATE,
      ORD_B01_TICKER,
      ORD_B02_PENDING,
      ORD_B03_GSLIVE,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_STEER_ELIGIBLE_BUILDER,
    ),
    neuronTokenIdentifier: "L22.N1402",
  },
  LIVE_CWS: {
    channelCode: "LIVE_CWS",
    channelOrdinal5: 7,
    kind: "ezl_cws_live_redirect",
    routingDisposition: "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE",
    treasuryCapitalSilo: "SILO_2_PERIOD_AND_LIVE_RFQ_62K5",
    vigSurchargeBasisPoints: asBasisPoints(20),
    executionSlaDurationMs: asDurationMilliseconds(500),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_PROMOTES_TO_LIVE_ROTATION,
    ),
    neuronTokenIdentifier: "L23.N0490",
  },
  CSLEVEL2: {
    channelCode: "CSLEVEL2",
    channelOrdinal5: 8,
    kind: "syndicate_secondary_feed",
    routingDisposition: "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE",
    treasuryCapitalSilo: "SILO_1_MATCHED_BOOK_150K",
    vigSurchargeBasisPoints: asBasisPoints(15),
    executionSlaDurationMs: asDurationMilliseconds(2_000),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(0),
    neuronTokenIdentifier: "L24.N2019",
  },
  PHONE: {
    channelCode: "PHONE",
    channelOrdinal5: 9,
    kind: "phone_clerk_audit",
    routingDisposition: "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE",
    treasuryCapitalSilo: "SILO_1_MATCHED_BOOK_150K",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(2_000),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
      ORD_B04_WEBLOG,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(0),
    neuronTokenIdentifier: "L18.N0310",
  },
  HOUSE_BOOK: {
    channelCode: "HOUSE_BOOK",
    channelOrdinal5: 10,
    kind: "house_agent_entry",
    routingDisposition: "DISPOSITION_STAGE1B_SPORTSBOOK_GROUPABLE",
    treasuryCapitalSilo: "SILO_1_MATCHED_BOOK_150K",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(2_000),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
      ORD_B04_WEBLOG,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(0),
    neuronTokenIdentifier: "L20.N1180",
  },
  CROSS_VENUE_SHADOW_WALLET_LEAD: {
    channelCode: "CROSS_VENUE_SHADOW_WALLET_LEAD",
    channelOrdinal5: 11,
    kind: "cross_venue_shadow_wallet_lead",
    routingDisposition: "DISPOSITION_STAGE1B_CROSS_VENUE_GROUPABLE",
    treasuryCapitalSilo: "SILO_3_SHADOW_MIRROR_37K5",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(164),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B06_PM_CLOB,
      ORD_B07_PM_FASTLANE,
      ORD_B08_PM_DATA,
      ORD_B09_KALSHI,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_QUARANTINE_180S_ELIGIBLE,
    ),
    neuronTokenIdentifier: "L24.N2101",
  },
  CROSS_VENUE_QUARANTINE_SCALP_EXIT: {
    channelCode: "CROSS_VENUE_QUARANTINE_SCALP_EXIT",
    channelOrdinal5: 12,
    kind: "cross_venue_quarantine_scalp_exit",
    routingDisposition: "DISPOSITION_STAGE1B_CROSS_VENUE_GROUPABLE",
    treasuryCapitalSilo: "SILO_UNALLOCATED",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(180_000),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B06_PM_CLOB,
      ORD_B07_PM_FASTLANE,
      ORD_B08_PM_DATA,
      ORD_B09_KALSHI,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(
      CHANNEL_FLAG_ZERO_CANONICAL_VOLUME |
        CHANNEL_FLAG_QUARANTINE_180S_ELIGIBLE,
    ),
    neuronTokenIdentifier: "L24.N2102",
  },
  CROSS_VENUE_SYNDICATE_CLUSTER_CONFIRM: {
    channelCode: "CROSS_VENUE_SYNDICATE_CLUSTER_CONFIRM",
    channelOrdinal5: 13,
    kind: "cross_venue_syndicate_cluster_confirm",
    routingDisposition: "DISPOSITION_STAGE1B_CROSS_VENUE_GROUPABLE",
    treasuryCapitalSilo: "SILO_3_SHADOW_MIRROR_37K5",
    vigSurchargeBasisPoints: asBasisPoints(25),
    executionSlaDurationMs: asDurationMilliseconds(250),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B06_PM_CLOB,
      ORD_B07_PM_FASTLANE,
      ORD_B08_PM_DATA,
      ORD_B09_KALSHI,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(0),
    neuronTokenIdentifier: "L24.N2103",
  },
  CROSS_VENUE_RFQ_COMBO_LAYOFF: {
    channelCode: "CROSS_VENUE_RFQ_COMBO_LAYOFF",
    channelOrdinal5: 14,
    kind: "cross_venue_rfq_combo_layoff",
    routingDisposition: "DISPOSITION_STAGE1B_CROSS_VENUE_GROUPABLE",
    treasuryCapitalSilo: "SILO_2_PERIOD_AND_LIVE_RFQ_62K5",
    vigSurchargeBasisPoints: asBasisPoints(0),
    executionSlaDurationMs: asDurationMilliseconds(1_000),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B05_PM_GAMMA,
      ORD_B06_PM_CLOB,
      ORD_B07_PM_FASTLANE,
      ORD_B09_KALSHI,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(0),
    neuronTokenIdentifier: "L24.N2104",
  },
  CROSS_VENUE_KEY_NUMBER_MIDDLE: {
    channelCode: "CROSS_VENUE_KEY_NUMBER_MIDDLE",
    channelOrdinal5: 15,
    kind: "cross_venue_key_number_middle",
    routingDisposition: "DISPOSITION_STAGE1B_CROSS_VENUE_GROUPABLE",
    treasuryCapitalSilo: "SILO_2_PERIOD_AND_LIVE_RFQ_62K5",
    vigSurchargeBasisPoints: asBasisPoints(20),
    executionSlaDurationMs: asDurationMilliseconds(250),
    permittedBridgeBitMask32: encodeBridgeMask32(
      ORD_B01_TICKER,
      ORD_B02_PENDING,
      ORD_B06_PM_CLOB,
      ORD_B07_PM_FASTLANE,
      ORD_B09_KALSHI,
    ),
    channelBehaviorFlagsBitSet32: asBitSet32(0),
    neuronTokenIdentifier: "L24.N2105",
  },
};

// ============================================================================
// 5. BIT-PACKED `BridgeChannelPackedWord32` & STRUCTURE-OF-ARRAYS COLUMN STORE
// ============================================================================

/**
 * Bit layout of `BridgeChannelPackedWord32`:
 *  - Bits [0..3]  (4 bits): `bridgeOrdinal4`  [0..9]
 *  - Bits [4..8]  (5 bits): `channelOrdinal5` [0..15]
 *  - Bits [9..13] (5 bits): `channelBehaviorFlagsBitSet32`
 */
export function encodeBridgeChannelPackedWord32(
  bridgeId: TransportBridgeId,
  channelCode: ExtendedSignalChannelCode,
  rowIdx?: number,
): BridgeChannelPackedWord32 {
  const bridgeSpec = TRANSPORT_BRIDGE_SPECIFICATION_TABLE[bridgeId];
  const channelSpec = SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE[channelCode];

  if (
    ((channelSpec.permittedBridgeBitMask32 >>> bridgeSpec.bridgeOrdinal4) &
      1) ===
    0
  ) {
    throw new DodGateFailureError({
      gate: 7,
      section: "SEC_BRIDGE_CHANNEL_INCIDENCE_MATRIX",
      rowIdx,
      expected: `Channel ${channelCode} permittedBridgeBitMask32=0x${channelSpec.permittedBridgeBitMask32.toString(16)}`,
      actual: `Disallowed TransportBridgeId=${bridgeId} (ordinal=${bridgeSpec.bridgeOrdinal4})`,
    });
  }

  const word =
    (bridgeSpec.bridgeOrdinal4 & 0x0f) |
    ((channelSpec.channelOrdinal5 & 0x1f) << 4) |
    ((channelSpec.channelBehaviorFlagsBitSet32 & 0x1f) << 9);

  return (word >>> 0) as BridgeChannelPackedWord32;
}

export function isTransportBridgePermittedForChannel(
  bridgeId: TransportBridgeId,
  channelCode: ExtendedSignalChannelCode,
): boolean {
  const bridgeSpec = TRANSPORT_BRIDGE_SPECIFICATION_TABLE[bridgeId];
  const channelSpec = SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE[channelCode];
  return (
    ((channelSpec.permittedBridgeBitMask32 >>> bridgeSpec.bridgeOrdinal4) &
      1) ===
    1
  );
}

/**
 * DOD6 v5.4 Structure-of-Arrays (SoA) Column Store for Bridge x Channel Routed Legs.
 * Strictly conforms to `<metricName><Unit>Col` suffix contract and unsigned handle rules.
 */
export class BridgeChannelRouteColumnStore {
  public readonly capacity: number;
  public readonly packedRouteWord32Col: Uint32Array;
  public readonly loginKey64Col: BigUint64Array;
  public readonly packedCustomerHandle32Col: Uint32Array;
  public readonly rotationNumberCol: Uint32Array;
  public readonly canonicalVolumeCentsCol: Int32Array;
  public readonly effectiveLineHundredthsCol: Int32Array;
  public readonly clvLineHundredthsCol: Int32Array;
  public readonly routeFlagsBitSet32Col: Uint32Array;

  constructor(capacity: number) {
    this.capacity = capacity;
    this.packedRouteWord32Col = new Uint32Array(capacity).fill(
      NULL_BRIDGE_CHANNEL_WORD32,
    );
    this.loginKey64Col = new BigUint64Array(capacity).fill(
      NULL_CUSTOMER_HANDLE64,
    );
    this.packedCustomerHandle32Col = new Uint32Array(capacity).fill(
      NULL_CUSTOMER_HANDLE32,
    );
    this.rotationNumberCol = new Uint32Array(capacity);
    this.canonicalVolumeCentsCol = new Int32Array(capacity);
    this.effectiveLineHundredthsCol = new Int32Array(capacity);
    this.clvLineHundredthsCol = new Int32Array(capacity).fill(
      NULL_CLV_SENTINEL,
    );
    this.routeFlagsBitSet32Col = new Uint32Array(capacity);
  }
}

// ============================================================================
// 6. SPECIFICATION-GRADE SEPARATED BRIDGE & CHANNEL DEMULTIPLEXER
// ============================================================================

export const INGEST_ROW_FLAG_TRACKED_SHADOW_WALLET = 1 << 0;
export const INGEST_ROW_FLAG_RFQ_COMBO_LAYOFF = 1 << 1;
export const INGEST_ROW_FLAG_CROSSES_KEY_NUMBER = 1 << 2;

export interface RawWireIngestEnvelope {
  readonly transportBridgeId: TransportBridgeId;
  readonly ticketWriterToken?: string;
  readonly placedOnToken?: string;
  readonly wagerTypeCode?: string;
  readonly shortDescriptionPrefix?: string;
  readonly ticketLegCount?: number;
  readonly rawBoardRotationNumber?: number;
  readonly amountWageredCents: Cents;
  readonly quarantineHoldDurationMs?: DurationMilliseconds;
  readonly distinctClusterWalletCount?: number;
  readonly ingestRowFlagsBitSet32?: BitSet32;
}

export interface SeparatedBridgeChannelEnvelope {
  readonly bridgeSpecification: TransportBridgeSpecification;
  readonly channelSpecification: SignalChannelPolicySpecification;
  readonly packedRouteWord32: BridgeChannelPackedWord32;
  readonly canonicalVolumeCents: Cents;
  readonly effectiveWagerTypeCode: string;
}

export function resolveSeparatedBridgeAndChannelEnvelope(
  envelope: RawWireIngestEnvelope,
  rowIdx?: number,
): SeparatedBridgeChannelEnvelope {
  if (envelope.rawBoardRotationNumber !== undefined) {
    assertValidRotationNumber(envelope.rawBoardRotationNumber, rowIdx);
  }

  const bridgeSpecification =
    TRANSPORT_BRIDGE_SPECIFICATION_TABLE[envelope.transportBridgeId];
  const channelCode = classifySignalChannelCode(
    envelope,
    bridgeSpecification.originDomain,
  );
  const channelSpecification =
    SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE[channelCode];
  const packedRouteWord32 = encodeBridgeChannelPackedWord32(
    envelope.transportBridgeId,
    channelCode,
    rowIdx,
  );

  const isZeroVolume =
    (channelSpecification.channelBehaviorFlagsBitSet32 &
      CHANNEL_FLAG_ZERO_CANONICAL_VOLUME) !==
    0;
  const canonicalVolumeCents = isZeroVolume
    ? asCents(0)
    : envelope.amountWageredCents;

  const promotesToLive =
    (channelSpecification.channelBehaviorFlagsBitSet32 &
      CHANNEL_FLAG_PROMOTES_TO_LIVE_ROTATION) !==
    0;
  const effectiveWagerTypeCode = promotesToLive
    ? "G"
    : (envelope.wagerTypeCode ?? "S");

  return {
    bridgeSpecification,
    channelSpecification,
    packedRouteWord32,
    canonicalVolumeCents,
    effectiveWagerTypeCode,
  };
}

export function classifySignalChannelCode(
  envelope: RawWireIngestEnvelope,
  originDomain: TransportOriginDomain,
): ExtendedSignalChannelCode {
  const rowFlags = envelope.ingestRowFlagsBitSet32 ?? asBitSet32(0);

  if (
    originDomain === "ORIGIN_EXCHANGE_POLYMARKET_CTF" ||
    originDomain === "ORIGIN_EXCHANGE_KALSHI_REGULATED"
  ) {
    if ((rowFlags & INGEST_ROW_FLAG_RFQ_COMBO_LAYOFF) !== 0) {
      return "CROSS_VENUE_RFQ_COMBO_LAYOFF";
    }
    if (
      envelope.quarantineHoldDurationMs !== undefined &&
      envelope.quarantineHoldDurationMs > 0 &&
      envelope.quarantineHoldDurationMs < 180_000 &&
      envelope.amountWageredCents <= 0
    ) {
      return "CROSS_VENUE_QUARANTINE_SCALP_EXIT";
    }
    if ((envelope.distinctClusterWalletCount ?? 0) >= 3) {
      return "CROSS_VENUE_SYNDICATE_CLUSTER_CONFIRM";
    }
    if ((rowFlags & INGEST_ROW_FLAG_CROSSES_KEY_NUMBER) !== 0) {
      return "CROSS_VENUE_KEY_NUMBER_MIDDLE";
    }
    return "CROSS_VENUE_SHADOW_WALLET_LEAD";
  }

  const wagerType = (envelope.wagerTypeCode ?? "").trim().toUpperCase();
  const writer = (envelope.ticketWriterToken ?? "").trim().toUpperCase();
  const placedOn = (envelope.placedOnToken ?? "").trim().toUpperCase();
  const rawTrigger = writer || placedOn;

  if (
    wagerType === "C" ||
    wagerType === "A" ||
    rawTrigger === "CASINO" ||
    rawTrigger === "VIRTUAL"
  ) {
    return "NON_SPORTS_DROP";
  }
  if (rawTrigger === "BLOCKED" || envelope.amountWageredCents <= 0) {
    return "BLOCKED";
  }
  if (rawTrigger === "GATEWAY") {
    return "GATEWAY";
  }
  if (rawTrigger === "ALERT") {
    return "ALERT";
  }
  if (rawTrigger === "GSBUILDER") {
    return "GSBUILDER";
  }
  if (rawTrigger === "GSLIVE") {
    const shortPrefix = (envelope.shortDescriptionPrefix ?? "")
      .trim()
      .charAt(0)
      .toUpperCase();
    if (
      shortPrefix === "C" ||
      (envelope.ticketLegCount !== undefined && envelope.ticketLegCount > 1)
    ) {
      return "GSBUILDER";
    }
    return "GSLIVE";
  }
  if (
    rawTrigger === "LIVEBETTINGCWS" ||
    rawTrigger === "EZL - INTERNET" ||
    rawTrigger === "EZLIVE" ||
    (envelope.rawBoardRotationNumber !== undefined &&
      envelope.rawBoardRotationNumber >= 9000)
  ) {
    return "LIVE_CWS";
  }
  if (rawTrigger === "CSLEVEL2") {
    return "CSLEVEL2";
  }
  if (
    rawTrigger === "PHONE" ||
    rawTrigger === "CALLCENTER" ||
    rawTrigger.startsWith("CLERK_")
  ) {
    return "PHONE";
  }
  if (
    rawTrigger === "AGENT" ||
    rawTrigger === "ADMIN" ||
    rawTrigger === "MANAGER" ||
    rawTrigger === "HOUSE"
  ) {
    return "HOUSE_BOOK";
  }
  if ((rowFlags & INGEST_ROW_FLAG_CROSSES_KEY_NUMBER) !== 0) {
    return "CROSS_VENUE_KEY_NUMBER_MIDDLE";
  }
  return "Internet";
}
