/**
 * @file lib/nsh_frame_schema.ts
 * @description 64-byte binary frame schema and router-to-blotter packing helpers
 * bridging `BridgeChannelPackedWord32` (`lib/bridge_and_channel_router.ts`) and
 * `design/tokens.toml` provenance tokens into the NSH blotter frame.
 *
 * Enforces the Naming Constitution:
 *  - Evergreen Rule: No hardcoded generation/version labels in active code,
 *    folder names, or canonical enums.
 *  - Frozen Rule: Frozen artifacts are referenced strictly via
 *    `(name, commitOrTag, dateIso)` and validated at boot/replay init only
 *    (never on the hot path).
 *  - Provenance Rule: Channel names explicitly state their source bridge
 *    (`FANTASY_402` vs `PARTNER_118` vs `POLYMARKET_CTF` vs `KALSHI_REGULATED`)
 *    and enforce `permittedBridgeBitMask32` before packing to prevent
 *    cross-contamination (`ERR_BRIDGE_CHANNEL_MISMATCH`).
 *  - Bitwise Rule: Every bit-packed field or variable explicitly states its
 *    type or bit-width (`...32`, `...64`, `...24`, `...16`, `...8`, `...Bps8`).
 */

import type {
  BridgeChannelPackedWord32,
  SignalChannelCode,
} from "../design/domain-branded-types.ts";
import {
  WRITER_LANE_WIRE_ID_BY_SIGNAL_CHANNEL,
  originDomainWireIdOf,
} from "./domain-enums.ts";
import {
  NULL_BRIDGE_CHANNEL_WORD32,
  SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  type ExtendedSignalChannelCode,
  type SeparatedBridgeChannelEnvelope,
  type SignalChannelPolicySpecification,
  type TransportBridgeSpecification,
  type TransportOriginDomain,
} from "./bridge_and_channel_router.ts";
import {
  ORIGIN_DOMAIN_REGISTRY,
  type OriginDomainId,
  type VenueId,
} from "./domain_venue_registry.ts";
export {
  ORIGIN_DOMAIN_REGISTRY,
  WRITER_LANE_REGISTRY,
  resolveOriginDomainForWriter,
  resolveVenueIdForOrigin,
  resolveWriterLaneId,
  type OriginDomainEntry,
  type OriginDomainId,
  type VenueId,
  type WriterLaneEntry,
  type WriterLaneId,
} from "./domain_venue_registry.ts";
import {
  NSH_BLOTTER_PUBLISH_TOPIC,
  NSH_FRAME_BYTE_LENGTH,
  NSH_FRAME_MAGIC,
  NSH_FRAME_VERSION,
  NSH_MESSAGE_TYPE,
  NshFrameCodecError,
  NshFrameWriter,
  broadcastFrame,
  packNshBinaryFrame,
  readNshBinaryFrame,
  readNshBinaryFrameFromArrayBuffer,
  type BroadcastFrameResult,
  type NshBroadcastDisposition,
  type NshFrameErrorCode,
  type NshMatchFrame,
  type NshMatchFrameInput,
  type NshMessageType,
  type NshPublishServer,
} from "./nsh_frame_codec.ts";

export {
  NSH_BLOTTER_PUBLISH_TOPIC,
  NSH_FRAME_BYTE_LENGTH,
  NSH_FRAME_MAGIC,
  NSH_FRAME_VERSION,
  NSH_MESSAGE_TYPE,
  NshFrameCodecError,
  NshFrameWriter,
  broadcastFrame,
  packNshBinaryFrame,
  readNshBinaryFrame,
  readNshBinaryFrameFromArrayBuffer,
};
export type {
  BroadcastFrameResult,
  NshBroadcastDisposition,
  NshFrameErrorCode,
  NshMatchFrame,
  NshMatchFrameInput,
  NshMessageType,
  NshPublishServer,
};

export const NSH_MAGIC_BYTE = NSH_FRAME_MAGIC;
export const NSH_VERSION = NSH_FRAME_VERSION;

// ============================================================================
// 1. STRICT 64-BYTE FRAME LAYOUT (CACHE-LINE ALIGNED)
// ============================================================================

/**
 * Single source of truth for the 64-byte frame. `NSH_FRAME_LAYOUT`, the writer,
 * the reader, the MCP `decode_nsh_frame` layout map and the offset table in
 * `docs/architecture/nsh_frame_compat.md` are all derived from this array.
 *
 * Offsets are declared explicitly — a protocol table is read, not computed — and
 * `buildFrameLayout` asserts at module load that the fields tile 0..63 with no
 * gap and no overlap, so a mis-edited offset fails at import instead of on the
 * wire.
 */
export interface NshFrameFieldSpec {
  readonly key: string;
  readonly offset: number;
  readonly size: number;
  /** Wire type, exactly as the writer emits it. */
  readonly type: "u8" | "u16" | "u32" | "u64" | "f64";
  readonly note: string;
}

export const NSH_FRAME_FIELD_SPEC = [
  { key: "HEADER_MAGIC", offset: 0, size: 1, type: "u8", note: '0x4E "N"' },
  {
    key: "HEADER_VERSION",
    offset: 1,
    size: 1,
    type: "u8",
    note: "frame version",
  },
  {
    key: "HEADER_MSG_TYPE",
    offset: 2,
    size: 1,
    type: "u8",
    note: "NshMessageType",
  },
  { key: "HEADER_RESERVED", offset: 3, size: 1, type: "u8", note: "zero" },
  {
    key: "PACKED_HANDLE_32",
    offset: 4,
    size: 4,
    type: "u32",
    note: "channel(4) | sla/10ms(8) | rowIndex(20)",
  },
  {
    key: "BET_GROUP_ID_64",
    offset: 8,
    size: 8,
    type: "u64",
    note: "bet group id",
  },
  { key: "STAKE_USDC", offset: 16, size: 8, type: "f64", note: "stake, USDC" },
  {
    key: "BOOK_ODDS",
    offset: 24,
    size: 8,
    type: "f64",
    note: "book decimal odds",
  },
  {
    key: "POLY_AVG_PRICE",
    offset: 32,
    size: 8,
    type: "f64",
    note: "Polymarket average price",
  },
  {
    key: "LIABILITY_DELTA",
    offset: 40,
    size: 8,
    type: "f64",
    note: "liability delta",
  },
  {
    key: "TIMESTAMP_EPOCH_MS",
    offset: 48,
    size: 8,
    type: "u64",
    note: "epoch milliseconds",
  },
  {
    key: "ORIGIN_DOMAIN_8",
    offset: 56,
    size: 1,
    type: "u8",
    note: "OriginDomainWireId",
  },
  {
    key: "WRITER_LANE_8",
    offset: 57,
    size: 1,
    type: "u8",
    note: "WriterLaneWireId",
  },
  { key: "RESERVED_8", offset: 58, size: 1, type: "u8", note: "zero" },
  {
    key: "FLAGS_BIT_SET_16",
    offset: 59,
    size: 2,
    type: "u16",
    note: "ANOM-01 bit flags",
  },
  {
    key: "SLIPPAGE_BPS_8",
    offset: 61,
    size: 1,
    type: "u8",
    note: "SOR-1 bounds",
  },
  {
    key: "RESERVED_PADDING_16",
    offset: 62,
    size: 2,
    type: "u16",
    note: "zero",
  },
] as const satisfies readonly NshFrameFieldSpec[];

export type NshFrameFieldKey = (typeof NSH_FRAME_FIELD_SPEC)[number]["key"];

export type NshFrameFieldSlot = {
  readonly offset: number;
  readonly size: number;
};

/**
 * Builds the offset map from `NSH_FRAME_FIELD_SPEC`, failing closed if the table
 * does not tile the frame exactly.
 */
function buildFrameLayout(
  spec: readonly NshFrameFieldSpec[],
): Readonly<Record<NshFrameFieldKey, NshFrameFieldSlot>> {
  const layout: Record<string, NshFrameFieldSlot> = {};
  let cursor = 0;
  for (const field of spec) {
    if (field.offset !== cursor) {
      throw new NshFrameCodecError(
        "invalid_reserved",
        `LT_FRAME_LAYOUT_GAP: field ${field.key} declares offset ${field.offset}, expected ${cursor}`,
      );
    }
    layout[field.key] = { offset: field.offset, size: field.size };
    cursor += field.size;
  }
  if (cursor !== NSH_FRAME_BYTE_LENGTH) {
    throw new NshFrameCodecError(
      "invalid_reserved",
      `LT_FRAME_LAYOUT_SIZE: fields tile ${cursor} bytes, frame is ${NSH_FRAME_BYTE_LENGTH}`,
    );
  }
  return Object.freeze(layout) as Readonly<
    Record<NshFrameFieldKey, NshFrameFieldSlot>
  >;
}

export const NSH_FRAME_LAYOUT = buildFrameLayout(NSH_FRAME_FIELD_SPEC);

export const NSH_FRAME_SIZE_CHECK_64: 64 = (NSH_FRAME_LAYOUT.RESERVED_PADDING_16
  .offset + NSH_FRAME_LAYOUT.RESERVED_PADDING_16.size) as 64;

// ============================================================================
// 2. FROZEN RULE: CANONICAL (name, commitOrTag, dateIso) ARTIFACT CITATIONS
//    Validated at boot / oracle replay initialization ONLY (never on hot path).
// ============================================================================

export interface FrozenArtifactCitation {
  readonly name: string;
  readonly commitOrTag: string;
  readonly dateIso: string;
}

export const TOKENS_SSOT_ARTIFACT_CITATION: FrozenArtifactCitation =
  Object.freeze({
    name: "design/tokens.toml",
    commitOrTag: "tokens-ssot-1.1.0",
    dateIso: "2026-11-10",
  });

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Boot-time / oracle-replay citation validator. Never invoke on the per-frame hot path.
 */
export function assertValidFrozenArtifactCitation(
  citation: FrozenArtifactCitation,
): true {
  if (
    !citation.name.trim() ||
    !citation.commitOrTag.trim() ||
    !ISO_DATE_REGEX.test(citation.dateIso)
  ) {
    throw new NshFrameCodecError(
      "invalid_reserved",
      `Frozen artifact citation must specify non-empty (name, commitOrTag, YYYY-MM-DD dateIso); got (${citation.name}, ${citation.commitOrTag}, ${citation.dateIso})`,
    );
  }
  return true;
}

// Validate once at module load time (0 hot-path cost).
assertValidFrozenArtifactCitation(TOKENS_SSOT_ARTIFACT_CITATION);

// ============================================================================
// 3. PROVENANCE RULE: SOURCE-BRIDGE QUALIFIED CHANNELS & ORDINALS
// ============================================================================

export type SourceBridgePrefix =
  "FANTASY_402" | "PARTNER_118" | "POLYMARKET_CTF" | "KALSHI_REGULATED";

export type BridgeQualifiedChannelCode =
  `${SourceBridgePrefix}_${Uppercase<ExtendedSignalChannelCode>}`;

/**
 * Canonical 4-bit transport bridge ordinals (`0..9`).
 */
export const BridgeOrdinal = Object.freeze({
  PARTNER_118_WAGERS_BY_STATE: 0,
  FANTASY_402: 1,
  FANTASY_402_BET_TICKER: 1,
  FANTASY_402_PENDING: 2,
  PARTNER_118: 3,
  PARTNER_118_TALLY: 3,
  FANTASY_402_WEBLOG: 4,
  POLYMARKET_GAMMA: 5,
  POLYMARKET_CLOB: 6,
  POLYGON_FASTLANE: 7,
  POLYMARKET_DATA: 8,
  KALSHI_EXCHANGE: 9,
} as const);

/**
 * High-byte provenance lock bits encoded in bridge-qualified `ChannelOrdinal` constants
 * so `ChannelOrdinal.PARTNER_118_GSLIVE` cannot be paired with `BridgeOrdinal.FANTASY_402`.
 */
const ORIGIN_PIN_SHIFT = 8;
const ORIGIN_PIN_NONE = 0;
const ORIGIN_PIN_FANTASY_402 = 1 << ORIGIN_PIN_SHIFT;
const ORIGIN_PIN_PARTNER_118 = 2 << ORIGIN_PIN_SHIFT;
const ORIGIN_PIN_POLYMARKET_CTF = 3 << ORIGIN_PIN_SHIFT;
const ORIGIN_PIN_KALSHI_REGULATED = 4 << ORIGIN_PIN_SHIFT;

/**
 * Canonical 5-bit channel ordinals (`0..15`) plus bridge-pinned provenance ordinals.
 */
export const ChannelOrdinal = Object.freeze({
  NON_SPORTS_DROP: 0,
  BLOCKED: 1,
  GATEWAY: 2,
  ALERT: 3,
  INTERNET: 4,
  GSLIVE: 5,
  GSBUILDER: 6,
  LIVE_CWS: 7,
  CSLEVEL2: 8,
  PHONE: 9,
  HOUSE_BOOK: 10,
  CROSS_VENUE_SHADOW_WALLET_LEAD: 11,
  CROSS_VENUE_QUARANTINE_SCALP_EXIT: 12,
  CROSS_VENUE_SYNDICATE_CLUSTER_CONFIRM: 13,
  CROSS_VENUE_RFQ_COMBO_LAYOFF: 14,
  CROSS_VENUE_KEY_NUMBER_MIDDLE: 15,

  // Source-bridge pinned provenance ordinals (Provenance Rule)
  FANTASY_402_ALERT: 3 | ORIGIN_PIN_FANTASY_402,
  FANTASY_402_INTERNET: 4 | ORIGIN_PIN_FANTASY_402,
  FANTASY_402_GSLIVE: 5 | ORIGIN_PIN_FANTASY_402,
  PARTNER_118_GSLIVE: 5 | ORIGIN_PIN_PARTNER_118,
  PARTNER_118_GSBUILDER: 6 | ORIGIN_PIN_PARTNER_118,
  POLYMARKET_CTF_SHADOW_WALLET_LEAD: 11 | ORIGIN_PIN_POLYMARKET_CTF,
  KALSHI_REGULATED_RFQ_COMBO_LAYOFF: 14 | ORIGIN_PIN_KALSHI_REGULATED,
} as const);

export function resolveSourceBridgePrefix(
  originDomain: TransportOriginDomain,
): SourceBridgePrefix {
  switch (originDomain) {
    case "ORIGIN_SPORTSBOOK_FANTASY402":
      return "FANTASY_402";
    case "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118":
      return "PARTNER_118";
    case "ORIGIN_EXCHANGE_POLYMARKET_CTF":
      return "POLYMARKET_CTF";
    case "ORIGIN_EXCHANGE_KALSHI_REGULATED":
      return "KALSHI_REGULATED";
  }
}

function originPinForDomain(originDomain: TransportOriginDomain): number {
  switch (originDomain) {
    case "ORIGIN_SPORTSBOOK_FANTASY402":
      return ORIGIN_PIN_FANTASY_402;
    case "ORIGIN_SPORTSBOOK_GSLIVE_PARTNER118":
      return ORIGIN_PIN_PARTNER_118;
    case "ORIGIN_EXCHANGE_POLYMARKET_CTF":
      return ORIGIN_PIN_POLYMARKET_CTF;
    case "ORIGIN_EXCHANGE_KALSHI_REGULATED":
      return ORIGIN_PIN_KALSHI_REGULATED;
  }
}

export function formatBridgeQualifiedChannelCode(
  originDomain: TransportOriginDomain,
  channelCode: ExtendedSignalChannelCode,
): BridgeQualifiedChannelCode {
  const prefix = resolveSourceBridgePrefix(originDomain);
  return `${prefix}_${channelCode.toUpperCase() as Uppercase<ExtendedSignalChannelCode>}`;
}

// ============================================================================
// 4. BITWISE RULE: EXPLICIT BIT-WIDTH HANDLES & 64-BYTE FRAME SCHEMA
// ============================================================================

/**
 * 32-bit packed blotter handle stored at byte offset 4:
 *  - Bits [28..31] (4 bits): `channelId4` (`0..15`, matches `channelOrdinal5`)
 *  - Bits [20..27] (8 bits): `slaDivide10Ms8` (`0..255`, SLA in 10ms units)
 *  - Bits [0..19]  (20 bits): `rowIndex20` (`0..1_048_575`)
 */
export type ChannelPackedHandle32 = number & {
  readonly __brand: "ChannelPackedHandle32";
};

export interface UnpackedChannelHandle32 {
  readonly channelId4: number;
  readonly slaDivide10Ms8: number;
  readonly rowIndex20: number;
  /** Compatibility aliases matching `NshMatchFrame`. */
  readonly channelId: number;
  readonly slaDivide10Ms: number;
  readonly rowIndex: number;
}

export interface DecodedBridgeChannelWord32 {
  readonly bridgeOrdinal4: number;
  readonly channelOrdinal5: number;
  readonly channelBehaviorFlagsBitSet5: number;
  /** Compatibility alias. */
  readonly channelBehaviorFlags5: number;
}

/**
 * Wire-level 64-byte frame layout (4 + 4 + 8 + 32 + 16 = 64 bytes) with explicit
 * bit-width and unit suffixes on every packed field.
 */
export interface NshBinaryFrame {
  // Header (4 bytes @ 0..3)
  readonly magicByte8: number;
  readonly versionByte8: number;
  readonly msgTypeByte8: NshMessageType;
  readonly reservedHeaderByte8: number;

  // Core Routing (4 bytes @ 4..7)
  readonly packedHandle32: ChannelPackedHandle32;

  // Identity (8 bytes @ 8..15)
  readonly betGroupId64: bigint;

  // Financial Payload (32 bytes @ 16..47)
  readonly stakeUsdcF64: number;
  readonly bookOddsF64: number;
  readonly polyAvgPriceF64: number;
  readonly liabilityDeltaF64: number;

  // Metadata / Provenance / Flags / Padding (16 bytes @ 48..63)
  readonly timestampEpochMs64: number; // 8 bytes @ 48..55
  readonly originDomainWireId8: number; // 1 byte  @ 56
  readonly writerLaneWireId8: number; // 1 byte  @ 57
  readonly reservedByte8: number; // 1 byte  @ 58 (0x00)
  readonly flagsBitSet16: number; // 2 bytes @ 59..60
  readonly slippageBps8: number; // 1 byte  @ 61
  readonly reservedPadding16: number; // 2 bytes @ 62..63 (0x0000)
}

const ROW_INDEX_20_MAX = 0xfffff;

const BRIDGE_SPEC_BY_ORDINAL: readonly TransportBridgeSpecification[] =
  Object.freeze(
    Object.values(TRANSPORT_BRIDGE_SPECIFICATION_TABLE).sort(
      (a, b) => a.bridgeOrdinal4 - b.bridgeOrdinal4,
    ),
  );

const CHANNEL_SPEC_BY_ORDINAL: readonly SignalChannelPolicySpecification[] =
  Object.freeze(
    Object.values(SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE).sort(
      (a, b) => a.channelOrdinal5 - b.channelOrdinal5,
    ),
  );

export const PROVENANCE_BY_CHANNEL_ORDINAL: readonly SignalChannelCode[] =
  Object.freeze([
    "BLOCKED", // 0: NON_SPORTS_DROP
    "BLOCKED", // 1: BLOCKED
    "GATEWAY", // 2: GATEWAY
    "ALERT", // 3: ALERT
    "Internet", // 4: Internet
    "GSLIVE", // 5: GSLIVE
    "GSBUILDER", // 6: GSBUILDER
    "GSLIVE", // 7: LIVE_CWS
    "CSLEVEL2", // 8: CSLEVEL2
    "Internet", // 9: PHONE
    "Internet", // 10: HOUSE_BOOK
    "ALERT", // 11: CROSS_VENUE_SHADOW_WALLET_LEAD
    "BLOCKED", // 12: CROSS_VENUE_QUARANTINE_SCALP_EXIT
    "ALERT", // 13: CROSS_VENUE_SYNDICATE_CLUSTER_CONFIRM
    "GSLIVE", // 14: CROSS_VENUE_RFQ_COMBO_LAYOFF
    "ALERT", // 15: CROSS_VENUE_KEY_NUMBER_MIDDLE
  ]);

export function provenanceForChannelOrdinal(
  channelOrdinal4: number,
): SignalChannelCode {
  if (
    !Number.isInteger(channelOrdinal4) ||
    channelOrdinal4 < 0 ||
    channelOrdinal4 >= PROVENANCE_BY_CHANNEL_ORDINAL.length
  ) {
    throw new NshFrameCodecError(
      "invalid_channel_id",
      `channelOrdinal4 must be an integer in [0, 15] (got ${String(channelOrdinal4)})`,
    );
  }
  return PROVENANCE_BY_CHANNEL_ORDINAL[channelOrdinal4]!;
}

export function packChannelHandle32(
  channelId4: number,
  slaDivide10Ms8: number,
  rowIndex20: number,
): ChannelPackedHandle32 {
  if (!Number.isInteger(channelId4) || channelId4 < 0 || channelId4 > 0xf) {
    throw new NshFrameCodecError(
      "invalid_channel_id",
      `channelId4 must be an integer in [0, 15] (got ${String(channelId4)})`,
    );
  }
  if (
    !Number.isInteger(slaDivide10Ms8) ||
    slaDivide10Ms8 < 0 ||
    slaDivide10Ms8 > 0xff
  ) {
    throw new NshFrameCodecError(
      "invalid_sla",
      `slaDivide10Ms8 must be an integer in [0, 255] (got ${String(slaDivide10Ms8)})`,
    );
  }
  if (
    !Number.isInteger(rowIndex20) ||
    rowIndex20 < 0 ||
    rowIndex20 > ROW_INDEX_20_MAX
  ) {
    throw new NshFrameCodecError(
      "invalid_row_index",
      `rowIndex20 must be an integer in [0, ${ROW_INDEX_20_MAX}] (got ${String(rowIndex20)})`,
    );
  }
  const packedWord32 =
    ((channelId4 & 0xf) << 28) |
    ((slaDivide10Ms8 & 0xff) << 20) |
    (rowIndex20 & ROW_INDEX_20_MAX);
  return (packedWord32 >>> 0) as ChannelPackedHandle32;
}

export function unpackChannelHandle32(
  packedHandle32: number,
): UnpackedChannelHandle32 {
  const word32 = packedHandle32 >>> 0;
  const channelId4 = (word32 >>> 28) & 0xf;
  const slaDivide10Ms8 = (word32 >>> 20) & 0xff;
  const rowIndex20 = word32 & ROW_INDEX_20_MAX;
  return {
    channelId4,
    slaDivide10Ms8,
    rowIndex20,
    channelId: channelId4,
    slaDivide10Ms: slaDivide10Ms8,
    rowIndex: rowIndex20,
  };
}

/**
 * A channel ordinal (`0..15`) is derived from the packed handle, never carried
 * as a separate field: bits `[28..31]` of the `ChannelPackedHandle32`.
 */
export function channelOrdinalFromFrame(packedHandle32: number): number {
  return ((packedHandle32 >>> 28) & 0xf) >>> 0;
}

/**
 * Unpacks a `BridgeChannelPackedWord32` produced by `encodeBridgeChannelPackedWord32`.
 */
export function decodeBridgeChannelPackedWord32(
  packedRouteWord32: BridgeChannelPackedWord32,
): DecodedBridgeChannelWord32 {
  if (
    !Number.isInteger(packedRouteWord32) ||
    packedRouteWord32 < 0 ||
    packedRouteWord32 > 0xffffffff
  ) {
    throw new NshFrameCodecError(
      "invalid_channel_id",
      `BridgeChannelPackedWord32 must be an unsigned 32-bit integer (got ${String(packedRouteWord32)})`,
    );
  }
  if (packedRouteWord32 === NULL_BRIDGE_CHANNEL_WORD32) {
    throw new NshFrameCodecError(
      "invalid_channel_id",
      "cannot decode NULL_BRIDGE_CHANNEL_WORD32 (0xFFFFFFFF)",
    );
  }
  const routeWord32 = packedRouteWord32 >>> 0;
  if (routeWord32 >>> 14 !== 0) {
    throw new NshFrameCodecError(
      "invalid_channel_id",
      `BridgeChannelPackedWord32 has non-zero reserved bits [14..31]: 0x${routeWord32.toString(16)}`,
    );
  }
  const channelBehaviorFlagsBitSet5 = (routeWord32 >>> 9) & 0x1f;
  return {
    bridgeOrdinal4: routeWord32 & 0x0f,
    channelOrdinal5: (routeWord32 >>> 4) & 0x1f,
    channelBehaviorFlagsBitSet5,
    channelBehaviorFlags5: channelBehaviorFlagsBitSet5,
  };
}

export interface RouteWordPairInput {
  readonly bridgeOrdinal4: number;
  readonly channelOrdinal5: number;
  readonly rowIndex20?: number;
}

function validateAndResolveOrdinals(
  bridgeOrdinal4: number,
  rawChannelOrdinal: number,
): {
  readonly channelId4: number;
  readonly slaDivide10Ms8: number;
  readonly channelId: number;
  readonly slaDivide10Ms: number;
  readonly provenance: SignalChannelCode;
  readonly sourceBridgePrefix: SourceBridgePrefix;
  readonly bridgeQualifiedChannelCode: BridgeQualifiedChannelCode;
  readonly originDomainId: OriginDomainId;
  readonly venueId: VenueId;
  readonly originBrandColorHex: string;
} {
  const channelOrdinal5 = rawChannelOrdinal & 0xff;
  const pinnedOrigin = rawChannelOrdinal & 0xff00;
  const bridgeSpec = BRIDGE_SPEC_BY_ORDINAL[bridgeOrdinal4];
  const channelSpec = CHANNEL_SPEC_BY_ORDINAL[channelOrdinal5];
  const provenance = PROVENANCE_BY_CHANNEL_ORDINAL[channelOrdinal5];
  if (!bridgeSpec || !channelSpec || !provenance || channelOrdinal5 > 0xf) {
    throw new NshFrameCodecError(
      "invalid_channel_id",
      `ERR_BRIDGE_CHANNEL_MISMATCH: invalid (bridgeOrdinal4=${bridgeOrdinal4}, channelOrdinal5=${channelOrdinal5})`,
    );
  }
  if (
    pinnedOrigin !== ORIGIN_PIN_NONE &&
    originPinForDomain(bridgeSpec.originDomain) !== pinnedOrigin
  ) {
    throw new NshFrameCodecError(
      "invalid_channel_id",
      `ERR_BRIDGE_CHANNEL_MISMATCH: cross-contamination between bridge ${bridgeSpec.bridgeId} (${bridgeSpec.originDomain}) and pinned channel ordinal 0x${rawChannelOrdinal.toString(16)}`,
    );
  }
  if (((channelSpec.permittedBridgeBitMask32 >>> bridgeOrdinal4) & 1) === 0) {
    throw new NshFrameCodecError(
      "invalid_channel_id",
      `ERR_BRIDGE_CHANNEL_MISMATCH: bridge ${bridgeSpec.bridgeId} (ordinal=${bridgeOrdinal4}) is not permitted for channel ${channelSpec.channelCode} (mask=0x${channelSpec.permittedBridgeBitMask32.toString(16)})`,
    );
  }
  const rawSlaDivide10 = Math.round(channelSpec.executionSlaDurationMs / 10);
  const slaDivide10Ms8 = Math.min(0xff, Math.max(0, rawSlaDivide10));
  const sourceBridgePrefix = resolveSourceBridgePrefix(bridgeSpec.originDomain);
  const bridgeQualifiedChannelCode = formatBridgeQualifiedChannelCode(
    bridgeSpec.originDomain,
    channelSpec.channelCode,
  );
  const originEntry = ORIGIN_DOMAIN_REGISTRY[bridgeSpec.originDomain];
  return {
    channelId4: channelOrdinal5,
    slaDivide10Ms8,
    channelId: channelOrdinal5,
    slaDivide10Ms: slaDivide10Ms8,
    provenance,
    sourceBridgePrefix,
    bridgeQualifiedChannelCode,
    originDomainId: originEntry.originDomainId,
    venueId: originEntry.venueId,
    originBrandColorHex: originEntry.brandColorHex,
  };
}

/**
 * Resolves the 4-bit channel ordinal, 8-bit SLA (in 10ms units, clamped to `0..255`),
 * `design/tokens.toml` `SignalChannelCode` provenance, and explicit source-bridge
 * qualified channel identifier (`FANTASY_402_*` vs `PARTNER_118_*`) from a
 * `BridgeChannelPackedWord32` or `{ bridgeOrdinal4, channelOrdinal5 }` pair.
 */
export function resolveRouteWordChannelAndSla(
  packedRouteWord32OrPair: BridgeChannelPackedWord32 | RouteWordPairInput,
): {
  readonly channelId4: number;
  readonly slaDivide10Ms8: number;
  readonly channelId: number;
  readonly slaDivide10Ms: number;
  readonly provenance: SignalChannelCode;
  readonly sourceBridgePrefix: SourceBridgePrefix;
  readonly bridgeQualifiedChannelCode: BridgeQualifiedChannelCode;
  readonly originDomainId: OriginDomainId;
  readonly venueId: VenueId;
  readonly originBrandColorHex: string;
} {
  if (typeof packedRouteWord32OrPair === "number") {
    const { bridgeOrdinal4, channelOrdinal5 } = decodeBridgeChannelPackedWord32(
      packedRouteWord32OrPair,
    );
    return validateAndResolveOrdinals(bridgeOrdinal4, channelOrdinal5);
  }
  return validateAndResolveOrdinals(
    packedRouteWord32OrPair.bridgeOrdinal4,
    packedRouteWord32OrPair.channelOrdinal5,
  );
}

/**
 * Converts a router `BridgeChannelPackedWord32` (or `{ bridgeOrdinal4, channelOrdinal5 }`)
 * + 20-bit `rowIndex20` into a `ChannelPackedHandle32` for byte offset 4 of the NSH frame.
 * Enforces `permittedBridgeBitMask32` and bridge-origin pins before packing (`ERR_BRIDGE_CHANNEL_MISMATCH`).
 */
export function packChannelHandleFromRouteWord32(
  packedRouteWord32OrPair: BridgeChannelPackedWord32 | RouteWordPairInput,
  rowIndex20 = 0,
): ChannelPackedHandle32 {
  const effectiveRowIndex20 =
    typeof packedRouteWord32OrPair === "object" &&
    packedRouteWord32OrPair.rowIndex20 !== undefined
      ? packedRouteWord32OrPair.rowIndex20
      : rowIndex20;
  const { channelId4, slaDivide10Ms8 } = resolveRouteWordChannelAndSla(
    packedRouteWord32OrPair,
  );
  return packChannelHandle32(channelId4, slaDivide10Ms8, effectiveRowIndex20);
}

export interface RouteEnvelopeNshPayload {
  readonly messageType?: NshMessageType;
  readonly rowIndex: number;
  readonly betGroupId: number | bigint;
  readonly stakeUsdc: number;
  readonly bookOdds: number;
  readonly polyAvgPrice: number;
  readonly liabilityDelta: number;
  readonly flags: number;
  readonly slippageBps: number;
  readonly timestampMs?: number;
}

/**
 * Packs a `SeparatedBridgeChannelEnvelope` (from `resolveSeparatedBridgeAndChannelEnvelope`)
 * and financial payload into a 64-byte NSH binary frame.
 * Validates `permittedBridgeBitMask32` before packing; never runs string/regex citation checks on the hot path.
 * Pass a reusable `NshFrameWriter` on hot paths to avoid per-frame allocations.
 */
export function packRouteEnvelopeToNshFrame(
  envelope: SeparatedBridgeChannelEnvelope,
  payload: RouteEnvelopeNshPayload,
  writer?: NshFrameWriter,
): Uint8Array {
  const { channelId4, slaDivide10Ms8, provenance, originDomainId } =
    resolveRouteWordChannelAndSla(envelope.packedRouteWord32);
  const frameInput: NshMatchFrameInput = {
    messageType: payload.messageType ?? NSH_MESSAGE_TYPE.TICKER_MATCH,
    channelId: channelId4,
    slaDivide10Ms: slaDivide10Ms8,
    rowIndex: payload.rowIndex,
    betGroupId: payload.betGroupId,
    stakeUsdc: payload.stakeUsdc,
    bookOdds: payload.bookOdds,
    polyAvgPrice: payload.polyAvgPrice,
    liabilityDelta: payload.liabilityDelta,
    originDomainWireId: originDomainWireIdOf(originDomainId),
    writerLaneWireId: WRITER_LANE_WIRE_ID_BY_SIGNAL_CHANNEL[provenance],
    flags: payload.flags,
    slippageBps: payload.slippageBps,
    ...(payload.timestampMs !== undefined
      ? { timestampMs: payload.timestampMs }
      : {}),
  };
  return writer ? writer.write(frameInput) : packNshBinaryFrame(frameInput);
}

/**
 * Packs an `NshMatchFrameInput` into a standalone 64-byte `ArrayBuffer`
 * suitable for WebSocket binary delivery (`ws.send(buffer, false)`) or `new DataView(buffer)`.
 */
export function packNshFrameToArrayBuffer(
  input: NshMatchFrameInput,
): ArrayBuffer {
  const bytes = packNshBinaryFrame(input);
  if (
    bytes.byteOffset === 0 &&
    bytes.buffer.byteLength === NSH_FRAME_BYTE_LENGTH
  ) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

// ============================================================================
// 5. EVERGREEN RULE: STATIC AUDITOR FOR GENERATION/VERSION LABELS
// ============================================================================

const FORBIDDEN_EVERGREEN_VERSION_LABEL_REGEX = new RegExp(
  `\\b(${["DOD" + "6", "v5\\.4", "v5\\.5", "v0\\.5\\.0"].join("|")})\\b`,
);

/**
 * Enforces the Naming Constitution Evergreen Rule on active code:
 * no hardcoded generation or version labels.
 */
export function auditNamingConstitutionCompliance(
  sourceText: string,
  moduleName = "nsh_frame_schema.ts",
): void {
  const match = FORBIDDEN_EVERGREEN_VERSION_LABEL_REGEX.exec(sourceText);
  if (match) {
    throw new NshFrameCodecError(
      "invalid_version",
      `Evergreen Rule violation in ${moduleName}: forbidden generation/version label '${match[0]}'`,
    );
  }
}
