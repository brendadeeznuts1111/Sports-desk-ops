/**
 * @file domain-branded-types.ts
 * @description Specification-Grade Domain Branded Primitives & Identity Guardrails (Bun v1.4+).
 *
 * Implements the 16 core Domain-Specific Branded Types for SportsDesk Operations and Fantasy402,
 * plus the transport/binary brands in section 6b:
 *  1.  Cents                - Strict integer cents (Math.round(d * 100)); SQLite storage unit.
 *  2.  Dollars              - Display-boundary float; never used in internal risk math.
 *  3.  CustomerIdentifier   - Trimmed uppercase bettor login without abbreviations.
 *  4.  PaddedCustomerId     - 11-char space-padded canonical ID for Fantasy402 Manager/updateByColumn.
 *  5.  AgentIdentifier      - Direct owning sub-agent identifier (never master BILLY666 on player writes).
 *  6.  TicketIdentifier     - Composite parent key ${login}|${wagerNumber}.
 *  7.  EpochSec             - Monotonic unix seconds integer for time-delta joins and SLA windows.
 *  8.  EpochMs              - Monotonic unix milliseconds for high-resolution latency evaluation.
 *  9.  ColorHexInt          - Single-parse 24-bit RGB packed integer (0x000000..0xFFFFFF) discarding alpha.
 *  10. BetGroupIdentifier   - Cross-book GS Buckeye Partner 118 join key matching /^M\.G\d+$/.
 *  11. ParlayLegCount       - Explicit proposition leg count integer strictly > 1 on GSBUILDER.
 *  12. RotationNumber       - 3-to-6 digit board rotation integer (100..999999).
 *  13. AmericanOdds         - American odds integer validated outside the [-99..+99] deadband.
 *  14. HalfPointLine        - Preserved half-point string with Unicode ½ (\u00BD) hook.
 *  15. SharpScore           - Empirical Bayes shrunk score [0.00..100.00] with N_min=8 shrinkage.
 *  16. BasisPoints          - Integer basis points (100 bps = 1.00%, 10,000 bps = 100%).
 */

// ============================================================================
// 1. BRAND DISCRIMINATOR & UNIVERSAL BRAND ENGINE (SSOT: lib/brand.ts)
// ============================================================================

// Re-exported, never redeclared. A local `__brand` symbol gives this module its own
// nominal identity, so a `Cents` branded here is not assignable to a `Cents` branded in
// lib/… or services/… — same concept, incompatible types. lib/brand.ts owns the engine.
import type { Brand } from "../lib/brand.ts";
export type { Brand };

// ============================================================================
// 1b. DIGEST & UTC INSTANT BRANDS (audit / provenance) — SSOT in lib/brand.ts
// ============================================================================

export type { IsoTime as IsoDateTimeUtc, Sha256Hex } from "../lib/brand.ts";
export {
  isoTime as isoDateTimeUtc,
  isIsoTime as isIsoDateTimeUtc,
  isSha256Hex,
  sha256FromDigest as sha256HexFromDigest,
} from "../lib/brand.ts";

// ============================================================================
// 2. MONETARY & VALUATION BRANDED PRIMITIVES
// ============================================================================

/**
 * Strict integer cents. Always Math.round() before construction.
 * Used exclusively for SQLite storage, ledger math, and risk accounting.
 */
export type Cents = Brand<number, "Cents">;

export function isCents(value: unknown): value is Cents {
  return typeof value === "number" && Number.isInteger(value);
}

export function assertCents(value: unknown): asserts value is Cents {
  if (!isCents(value)) {
    throw new TypeError(
      `Expected integer Cents primitive, received: ${String(value)}`,
    );
  }
}

export function parseAsCents(
  dollarsOrCents: number,
  isAlreadyCents: boolean = true,
): Cents {
  const normalized = isAlreadyCents
    ? Math.round(dollarsOrCents)
    : Math.round(dollarsOrCents * 100);
  return normalized as Cents;
}

/**
 * Display-boundary decimal dollars.
 * Permitted ONLY at human display surfaces and formatting layers; never in internal risk math.
 */
export type Dollars = Brand<number, "Dollars">;

export function isDollars(value: unknown): value is Dollars {
  return (
    typeof value === "number" && !Number.isNaN(value) && Number.isFinite(value)
  );
}

export function centsToDollars(centsValue: Cents): Dollars {
  assertCents(centsValue);
  return (centsValue / 100) as Dollars;
}

export function formatDollarsString(dollarsValue: Dollars): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(dollarsValue);
}

// ============================================================================
// 3. IDENTIFIER & DOWNLINE ENTITY BRANDED PRIMITIVES
// ============================================================================

/**
 * Trimmed uppercase customer login identifier (e.g. "RF2003", "BGD101", "MM800").
 */
export type CustomerIdentifier = Brand<string, "CustomerIdentifier">;

// Backward-compatible alias
export type CustomerId = CustomerIdentifier;

export function isCustomerIdentifier(
  value: unknown,
): value is CustomerIdentifier {
  return typeof value === "string" && /^[A-Z0-9_\-.]{2,32}$/.test(value.trim());
}

export function customerIdentifier(rawIdentifier: string): CustomerIdentifier {
  const trimmed = rawIdentifier.trim().toUpperCase();
  if (trimmed.length < 2) {
    throw new TypeError(
      `CustomerIdentifier cannot be shorter than 2 characters: '${rawIdentifier}'`,
    );
  }
  return trimmed as CustomerIdentifier;
}

/**
 * Space-padded 11-character canonical ID for Fantasy402 Manager/updateByColumn mutations.
 * Enforces exact 11-character invariant to prevent silent non-persisting Result: 0 drops.
 */
export type PaddedCustomerId = Brand<string, "PaddedCustomerId">;

export function isPaddedCustomerId(value: unknown): value is PaddedCustomerId {
  return (
    typeof value === "string" && value.length === 11 && value.trim().length > 0
  );
}

export function padCustomerIdCanonical(
  rawIdentifier: string,
): PaddedCustomerId {
  const trimmed = rawIdentifier.trim().toUpperCase();
  if (trimmed.length === 0 || trimmed.length > 11) {
    throw new RangeError(
      `PaddedCustomerId source length must be between 1 and 11 characters (got ${trimmed.length}): '${rawIdentifier}'`,
    );
  }
  return trimmed.padEnd(11, " ") as PaddedCustomerId;
}

/**
 * Direct owning sub-agent identifier (e.g. "CUB22HR", "BIGDAD", "ATEAM").
 */
export type AgentIdentifier = Brand<string, "AgentIdentifier">;

// Backward-compatible alias
export type AgentId = AgentIdentifier;

export function isAgentIdentifier(value: unknown): value is AgentIdentifier {
  return typeof value === "string" && /^[A-Z0-9_\-.]{2,32}$/.test(value.trim());
}

export function agentIdentifier(rawIdentifier: string): AgentIdentifier {
  const trimmed = rawIdentifier.trim().toUpperCase();
  if (trimmed.length < 2) {
    throw new TypeError(
      `AgentIdentifier cannot be shorter than 2 characters: '${rawIdentifier}'`,
    );
  }
  return trimmed as AgentIdentifier;
}

/**
 * Composite parent ticket identifier: `${Login.trim()}|${WagerNumber}`.
 */
export type TicketIdentifier = Brand<string, "TicketIdentifier">;

// Backward-compatible alias
export type TicketId = TicketIdentifier;

export function isTicketIdentifier(value: unknown): value is TicketIdentifier {
  return typeof value === "string" && /^[A-Z0-9_\-.]+\|\d+$/.test(value);
}

export function ticketIdentifier(
  loginIdentifier: string,
  wagerNumberIdentifier: string | number,
): TicketIdentifier {
  const cleanLogin = loginIdentifier.trim().toUpperCase();
  const cleanWagerNumber = String(wagerNumberIdentifier).trim();
  if (!cleanLogin || !cleanWagerNumber) {
    throw new TypeError(
      `TicketIdentifier components cannot be empty: login='${cleanLogin}', wagerNumber='${cleanWagerNumber}'`,
    );
  }
  return `${cleanLogin}|${cleanWagerNumber}` as TicketIdentifier;
}

/**
 * Cross-book GS Buckeye Partner 118 join key from M.G(\d+) header.
 */
export type BetGroupIdentifier = Brand<string, "BetGroupIdentifier">;

// Backward-compatible alias
export type BetGroupId = BetGroupIdentifier;

export function isBetGroupIdentifier(
  value: unknown,
): value is BetGroupIdentifier {
  return typeof value === "string" && /^M\.G\d+$/.test(value);
}

export function betGroupIdentifier(raw: string): BetGroupIdentifier {
  const match = raw.match(/M\.G(\d+)/);
  if (!match) {
    throw new TypeError(
      `Invalid BetGroupIdentifier format (must contain 'M.G<digits>'): '${raw}'`,
    );
  }
  return `M.G${match[1]}` as BetGroupIdentifier;
}

export function extractBetGroupIdentifier(
  rawDescription: string,
): BetGroupIdentifier | null {
  const match = rawDescription.match(/M\.G(\d+)/);
  return match ? (`M.G${match[1]}` as BetGroupIdentifier) : null;
}

// ============================================================================
// 4. TEMPORAL & TIMESTAMP BRANDED PRIMITIVES
// ============================================================================

/**
 * Whole seconds Unix epoch timestamp (Math.floor(ms / 1000)).
 * Used for ALERT twin gapDurationSeconds and <=300s Weblog joins.
 */
export type EpochSec = Brand<number, "EpochSec">;

export function isEpochSec(value: unknown): value is EpochSec {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < 4102444800
  ); // < Year 2100
}

export function parseAsEpochSec(dateOrMs: number | string | Date): EpochSec {
  if (typeof dateOrMs === "number") {
    const sec =
      dateOrMs > 10000000000
        ? Math.floor(dateOrMs / 1000)
        : Math.floor(dateOrMs);
    return sec as EpochSec;
  }
  const ms =
    typeof dateOrMs === "string" ? Date.parse(dateOrMs) : dateOrMs.getTime();
  return Math.floor(ms / 1000) as EpochSec;
}

/**
 * High-precision milliseconds Unix epoch timestamp.
 */
export type EpochMs = Brand<number, "EpochMs">;

export function isEpochMs(value: unknown): value is EpochMs {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function parseAsEpochMs(dateOrMs: number | string | Date): EpochMs {
  if (typeof dateOrMs === "number") {
    return Math.floor(dateOrMs) as EpochMs;
  }
  const ms =
    typeof dateOrMs === "string" ? Date.parse(dateOrMs) : dateOrMs.getTime();
  return Math.floor(ms) as EpochMs;
}

// ============================================================================
// 5. COLOR, ANNOTATION & RENDERING BRANDED PRIMITIVES
// ============================================================================

/**
 * Single-parse 24-bit packed RGB integer derived from Bun.color(c, "number") or CSS hex.
 * Strict domain invariant: 0x000000 <= color <= 0xFFFFFF (0..16777215). Alpha is discarded by design.
 */
export type ColorHexInt = Brand<number, "ColorHexInt">;

export function isColorHexInt(value: unknown): value is ColorHexInt {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0x000000 &&
    value <= 0xffffff
  );
}

export function assertColorHexInt(
  value: unknown,
): asserts value is ColorHexInt {
  if (!isColorHexInt(value)) {
    throw new RangeError(
      `ColorHexInt must be a 24-bit integer between 0x000000 and 0xFFFFFF (got: ${String(value)})`,
    );
  }
}

export function parseAsColorHexInt(cssOrNumber: string | number): ColorHexInt {
  if (typeof cssOrNumber === "number") {
    const masked =
      cssOrNumber > 0xffffff
        ? (cssOrNumber >>> 8) & 0xffffff
        : cssOrNumber & 0xffffff;
    return masked as ColorHexInt;
  }

  const clean = cssOrNumber.trim();

  // 1. Primary: Native Bun.color parser (Bun v1.4+)
  if (typeof Bun !== "undefined") {
    try {
      const parsed = Bun.color(clean, "number");
      if (parsed !== null) {
        return parsed as ColorHexInt;
      }
    } catch {
      // Fall through to manual parsing
    }
  }

  // 2. Strict hex parsing fallback
  if (clean.startsWith("#")) {
    const hexDigits = clean.slice(1);
    if (hexDigits.length === 6) {
      return parseInt(hexDigits, 16) as ColorHexInt;
    }
    if (hexDigits.length === 8) {
      return parseInt(hexDigits.slice(0, 6), 16) as ColorHexInt;
    }
    if (hexDigits.length === 3) {
      const expanded = hexDigits
        .split("")
        .map((ch) => ch + ch)
        .join("");
      return parseInt(expanded, 16) as ColorHexInt;
    }
  }

  const fallback =
    parseInt(clean.replace(/[^0-9a-fA-F]/g, "").slice(0, 6), 16) || 0;
  return fallback as ColorHexInt;
}

export function parseAsColorCssString(cssOrNumber: string | number): string {
  if (typeof Bun !== "undefined") {
    try {
      const css = Bun.color(cssOrNumber, "css");
      if (typeof css === "string" && css.length > 0) {
        return css;
      }
    } catch {
      // Fallback
    }
  }
  const hexInt = parseAsColorHexInt(cssOrNumber);
  return colorHexIntToHexString(hexInt);
}

export function colorHexIntToRgbChannels(color: ColorHexInt): {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
} {
  assertColorHexInt(color);
  return {
    red: (color >> 16) & 0xff,
    green: (color >> 8) & 0xff,
    blue: color & 0xff,
  };
}

export function colorHexIntToHexString(color: ColorHexInt): string {
  assertColorHexInt(color);
  return `#${color.toString(16).padStart(6, "0")}`;
}

// ============================================================================
// 6. WAGERING, ROTATION & MARKET SPECIFICATION BRANDED PRIMITIVES
// ============================================================================

export type ParlayLegCount = Brand<number, "ParlayLegCount">;

export function isParlayLegCount(value: unknown): value is ParlayLegCount {
  return typeof value === "number" && Number.isInteger(value) && value > 1;
}

export function parlayLegCount(rawCount: number): ParlayLegCount {
  const integerCount = Math.floor(rawCount);
  if (integerCount <= 1) {
    throw new RangeError(
      `ParlayLegCount must be strictly greater than 1 (got: ${rawCount})`,
    );
  }
  return integerCount as ParlayLegCount;
}

export type RotationNumber = Brand<number, "RotationNumber">;

export function isRotationNumber(value: unknown): value is RotationNumber {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 999999
  );
}

export function rotationNumber(rawNumber: number | string): RotationNumber {
  const parsed =
    typeof rawNumber === "string"
      ? parseInt(rawNumber, 10)
      : Math.floor(rawNumber);
  if (!isRotationNumber(parsed)) {
    throw new RangeError(
      `RotationNumber must be an integer between 100 and 999999 (got: ${rawNumber})`,
    );
  }
  return parsed as RotationNumber;
}

export type AmericanOdds = Brand<number, "AmericanOdds">;

export function isAmericanOdds(value: unknown): value is AmericanOdds {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    (value <= -100 || value >= 100)
  );
}

export function parseAmericanOdds(rawOdds: number | string): AmericanOdds {
  let val: number;
  if (typeof rawOdds === "string") {
    const clean = rawOdds.replace("+", "").trim();
    val = parseInt(clean, 10);
  } else {
    val = Math.floor(rawOdds);
  }

  if (val > -100 && val < 100) {
    throw new RangeError(
      `AmericanOdds cannot reside in invalid [-99..+99] deadband (got: ${val})`,
    );
  }
  return val as AmericanOdds;
}

export type HalfPointLine = Brand<string, "HalfPointLine">;

export function isHalfPointLine(value: unknown): value is HalfPointLine {
  return typeof value === "string" && value.length > 0;
}

export function formatHalfPointLine(rawLine: string | number): HalfPointLine {
  if (typeof rawLine === "number") {
    const sign = rawLine > 0 ? "+" : "";
    const whole = Math.trunc(rawLine);
    const hasHalf = Math.abs(rawLine % 1) === 0.5;
    if (hasHalf) {
      return `${sign}${whole === 0 && rawLine < 0 ? "-" : whole !== 0 ? whole : ""}\u00BD` as HalfPointLine;
    }
    return `${sign}${rawLine}` as HalfPointLine;
  }

  const normalized = rawLine
    .trim()
    .replace(/\.5\b/g, "\u00BD")
    .replace(/1\/2/g, "\u00BD");
  return normalized as HalfPointLine;
}

export type SharpScore = Brand<number, "SharpScore">;

export function isSharpScore(value: unknown): value is SharpScore {
  return typeof value === "number" && value >= 0 && value <= 100;
}

export function computeBayesSharp(
  rawScore: number,
  ticketCount: number,
): SharpScore {
  const n = Math.max(0, ticketCount);
  const weight = n / (n + 25.0);
  const shrunk = weight * rawScore + (1.0 - weight) * 50.0;
  const bounded = Math.min(100.0, Math.max(0.0, shrunk));
  return Number(bounded.toFixed(2)) as SharpScore;
}

export type BasisPoints = Brand<number, "BasisPoints">;

export function isBasisPoints(value: unknown): value is BasisPoints {
  return typeof value === "number" && Number.isInteger(value);
}

export function parseAsBasisPoints(
  ratioOrBps: number,
  isAlreadyBps: boolean = false,
): BasisPoints {
  const val = isAlreadyBps
    ? Math.round(ratioOrBps)
    : Math.round(ratioOrBps * 10000);
  return val as BasisPoints;
}

export function basisPointsToPercentage(bps: BasisPoints): number {
  return bps / 100;
}

// ============================================================================
// 6b. TRANSPORT BRIDGE, PACKED HANDLES & BINARY DOMAIN BRANDS
// ============================================================================

export type SettledCents = Brand<number, "SettledCents">;
export type LifetimeCents = Brand<number, "LifetimeCents">;
export type LineHundredths = Brand<number, "LineHundredths">;
export type EpochDays = Brand<number, "EpochDays">;
export type DurationMilliseconds = Brand<number, "DurationMilliseconds">;
export type BitSet32 = Brand<number, "BitSet32">;
export type TransportBridgeBitMask32 = Brand<
  number,
  "TransportBridgeBitMask32"
>;
export type BridgeChannelPackedWord32 = Brand<
  number,
  "BridgeChannelPackedWord32"
>;
export type CustomerPackedHandle32 = Brand<number, "CustomerPackedHandle32">;
export type CustomerPackedHandle64 = Brand<bigint, "CustomerPackedHandle64">;
export type CustomerPackedKey64 = Brand<bigint, "CustomerPackedKey64">;
export type ComboPackedKey15 = Brand<number, "ComboPackedKey15">;

export function asSettledCents(value: number): SettledCents {
  return Math.trunc(value) as SettledCents;
}

export function asLifetimeCents(value: number): LifetimeCents {
  return Math.trunc(value) as LifetimeCents;
}

export function asLineHundredths(value: number): LineHundredths {
  return Math.trunc(value) as LineHundredths;
}

export function asEpochDays(value: number): EpochDays {
  return Math.trunc(value) as EpochDays;
}

export function asDurationMilliseconds(value: number): DurationMilliseconds {
  return Math.trunc(value) as DurationMilliseconds;
}

export function asBitSet32(value: number): BitSet32 {
  return (value >>> 0) as BitSet32;
}

export function asTransportBridgeBitMask32(
  value: number,
): TransportBridgeBitMask32 {
  return (value >>> 0) as TransportBridgeBitMask32;
}

export function asBridgeChannelPackedWord32(
  value: number,
): BridgeChannelPackedWord32 {
  return (value >>> 0) as BridgeChannelPackedWord32;
}

export function asCustomerPackedHandle32(
  value: number,
): CustomerPackedHandle32 {
  return (value >>> 0) as CustomerPackedHandle32;
}

export function asCustomerPackedHandle64(
  value: bigint,
): CustomerPackedHandle64 {
  return BigInt.asUintN(64, value) as CustomerPackedHandle64;
}

export function asCustomerPackedKey64(value: bigint): CustomerPackedKey64 {
  return BigInt.asUintN(64, value) as CustomerPackedKey64;
}

export function asComboPackedKey15(value: number): ComboPackedKey15 {
  return (value & 0x7fff) as ComboPackedKey15;
}

// ============================================================================
// 6c. SCHEMA, JSON & VALIDATION BRANDS (SSOT: lib/brand.ts)
// ============================================================================

export type {
  JsonText,
  SqlColumnName,
  SqlDomain,
  SqlIndexName,
  SqlTableName,
} from "../lib/brand.ts";
export {
  jsonText,
  sqlCol,
  sqlDomain,
  sqlIndex,
  sqlTable,
} from "../lib/brand.ts";

// ============================================================================
// 7. QWEN3.5-4B NEURON REGISTRY & DECOUPLED THREE-AXIS SCHEMAS (LAYERS 18-28)
// ============================================================================

export type SignalChannelCode =
  | "NON_SPORTS"
  | "Internet"
  | "BLOCKED"
  | "GATEWAY"
  | "ALERT"
  | "GSBUILDER"
  | "GSLIVE"
  | "CSLEVEL2"
  | "LIVEBETTINGCWS"
  | "PHONE"
  | "HOUSE";

export type SignalChannelStatus =
  "ACTIVE" | "DROPPED" | "ALERT" | "STEERABLE" | "CRITICAL" | "SUPPRESSED";

export type DecisionMoveFlag =
  | "STEAM_CONVERGENCE"
  | "SHRINKAGE_SHARP"
  | "LIQUIDITY_HALT"
  | "TERMINAL_ENFORCE";

export type TriggerPredicateKind =
  | "ADVERSE_SELECTION"
  | "CLV_MARGIN_DECAY"
  | "ORDER_BOOK_EXHAUSTION"
  | "TERMINAL_DEFICIT_ESCALATION";

export type MitigationActionKind =
  | "DYNAMIC_REPRICE"
  | "SHRINKAGE_RECALIBRATE"
  | "CIRCUIT_BREAKER_HALT"
  | "MANAGER_LIMIT_CLAMP";

export const TOKEN_GATES = {
  minBodyContrastRatioMilli: 4500,
  minAaaSlateContrastMilli: 7000,
  minUiComponentContrastMilli: 3000,
  minCrossStateDeltaE00Milli: 7000,
  minFreshVsStaleDeltaE00Milli: 40000,
} as const;

export const SOURCE_BRIDGE_IDS = {
  INGEST_STAGE1_DROP: 0,
  FANTASY_402_BRIDGE_3AB: 1,
  PARTNER_118_BRIDGE_3C: 2,
} as const;

export type SourceBridgeId2 =
  (typeof SOURCE_BRIDGE_IDS)[keyof typeof SOURCE_BRIDGE_IDS];

/**
 * Axis 1 Transport SLA Discriminated Union.
 * Eliminates synthetic "0 ms" latency sentinels: sentinel drops represent an un-executed filtering policy.
 */
export type TransportSla =
  | { readonly kind: "latency"; readonly latencySlaMs: number }
  | { readonly kind: "sentinel_drop" };

/**
 * Axis 2 Algorithmic Threshold Discriminated Union.
 * Zero unbranded IEEE-754 floats: shrinkage thresholds use branded integer BasisPoints.
 */
export type RouteThreshold =
  | { readonly kind: "consensus_lag"; readonly maxLagMs: number }
  | {
      readonly kind: "bayes_shrinkage";
      readonly tauStarBasisPoints: BasisPoints;
      readonly minTickets: number;
    }
  | { readonly kind: "liquidity_depth"; readonly minDepthCents: Cents }
  | {
      readonly kind: "composite_risk_gate";
      readonly minToxicityScore: number;
      readonly maxHoldRateBasisPoints: BasisPoints;
      readonly maxDeficitCents: Cents;
    };

/**
 * Axis 1: Ingestion Signal Channels (Layers 17-24D).
 */
export interface IngestionChannelDefinition {
  readonly channelId: number;
  readonly sourceBridgeId: SourceBridgeId2;
  readonly canonicalProvenance: string;
  readonly layerId: `L${string}.N${string}`;
  readonly tokenName: string;
  readonly legacyTokenName?: `--sd-${string}`;
  readonly hex: string;
  readonly legacyWireHex?: string;
  readonly channelCode: SignalChannelCode;
  readonly wireAliases: readonly string[];
  readonly signalTier: string;
  readonly transportUri: string;
  readonly sla: TransportSla;
  readonly slaTensOfMs: number;
  readonly channelStatus: SignalChannelStatus;
  readonly volumeRule: string;
  readonly operationalRole: string;
}

/**
 * Axis 2: Risk Decision & Route Continuum (Layers 25-28).
 */
export interface RouteCircuitDefinition {
  readonly routeId: number;
  readonly layerId: `L${number}.N${string}`;
  readonly tokenName: string;
  readonly hex: string;
  readonly routeName: string;
  readonly moveFlag: DecisionMoveFlag;
  readonly triggerKind: TriggerPredicateKind;
  readonly threshold: RouteThreshold;
  readonly mitigationKind: MitigationActionKind;
  readonly operationalRole: string;
}

/**
 * Axis 3: Telemetry Viewports & Rendering Surfaces.
 */
export interface SurfaceDefinition {
  readonly layerId: "SURFACE.DOM" | "SURFACE.CLI";
  readonly tokenName: string;
  readonly hex: string;
  readonly surfaceName: string;
  readonly targetViewport: string;
  readonly protocol: string;
  readonly colorDepth: string;
  readonly operationalRole: string;
}

export type AnyQwenNeuronDefinition =
  IngestionChannelDefinition | RouteCircuitDefinition | SurfaceDefinition;

/**
 * Ingestion Signal Channels (Layers 17-24D).
 * Generated directly from tokens.toml.
 */
export const INGESTION_CHANNELS: readonly IngestionChannelDefinition[] = [
  {
    channelId: 0,
    sourceBridgeId: 0,
    canonicalProvenance: "INGEST_NON_SPORTS_DROP",
    layerId: "L17.N0000",
    tokenName: "--sd-tier-drop",
    hex: "#94a3b8",
    channelCode: "NON_SPORTS",
    wireAliases: ["CASINO", "VIRTUAL", "WAGER_TYPE_C", "WAGER_TYPE_A"],
    signalTier: "SIGNAL_STAGE1_DROP",
    transportUri: "portal://ingest/non-sports-drop",
    sla: { kind: "sentinel_drop" },
    slaTensOfMs: 0,
    channelStatus: "DROPPED",
    volumeRule: "STAGE1_DROP (canonicalVolumeCents = 0)",
    operationalRole: "Non-Sports Casino & Virtual Stage 1 Drop",
  },
  {
    channelId: 1,
    sourceBridgeId: 1,
    canonicalProvenance: "FANTASY_402_INTERNET_L18",
    layerId: "L18.N0204",
    tokenName: "--sd-tier-retail",
    hex: "#29b6f6",
    legacyWireHex: "#1d84b5",
    channelCode: "Internet",
    wireAliases: ["Internet", "INTERNET", "MOBILE", "WAP"],
    signalTier: "SIGNAL_INTERNET",
    transportUri: "portal://ticker/live-stream",
    sla: { kind: "latency", latencySlaMs: 1500 },
    slaTensOfMs: 150,
    channelStatus: "ACTIVE",
    volumeRule: "TARGET_TWIN (gapDurationSeconds = Internet - ALERT)",
    operationalRole: "Retail Pregame Baseline Gate",
  },
  {
    channelId: 2,
    sourceBridgeId: 1,
    canonicalProvenance: "FANTASY_402_BLOCKED_L19",
    layerId: "L19.N0518",
    tokenName: "--sd-tier-blocked",
    hex: "#8fa3bf",
    legacyWireHex: "#64748b",
    channelCode: "BLOCKED",
    wireAliases: ["BLOCKED"],
    signalTier: "SIGNAL_SENTINEL_DROP",
    transportUri: "portal://pending/noise-filter",
    sla: { kind: "sentinel_drop" },
    slaTensOfMs: 0,
    channelStatus: "DROPPED",
    volumeRule:
      "DROP_BEFORE_GROUPING (index sharp intent; drop before exposure sum)",
    operationalRole: "Blocked Sentinel & Zero-Stake Filter",
  },
  {
    channelId: 3,
    sourceBridgeId: 1,
    canonicalProvenance: "FANTASY_402_GATEWAY_L20",
    layerId: "L20.N1105",
    tokenName: "--sd-tier-gateway",
    legacyTokenName: "--sd-theme-emerald",
    hex: "#22d39a",
    legacyWireHex: "#10b981",
    channelCode: "GATEWAY",
    wireAliases: ["GATEWAY"],
    signalTier: "SIGNAL_EQUILIBRIUM_GATE",
    transportUri: "portal://gateway/equilibrium-gate",
    sla: { kind: "latency", latencySlaMs: 1000 },
    slaTensOfMs: 100,
    channelStatus: "ACTIVE",
    volumeRule: "EQUILIBRIUM_SWEEP (+15c/+20c vig persist read-backs)",
    operationalRole: "Equilibrium Confirm & Vig Gate",
  },
  {
    channelId: 4,
    sourceBridgeId: 1,
    canonicalProvenance: "FANTASY_402_ALERT_L21",
    layerId: "L21.N0884",
    tokenName: "--sd-tier-alert",
    hex: "#ff7878",
    legacyWireHex: "#ef4444",
    channelCode: "ALERT",
    wireAliases: ["ALERT"],
    signalTier: "SIGNAL_ALERT_TWIN",
    transportUri: "portal://ticker/alert-twins",
    sla: { kind: "latency", latencySlaMs: 250 },
    slaTensOfMs: 25,
    channelStatus: "ALERT",
    volumeRule: "SOURCE_ALERT (canonicalVolumeCents = 0; skip Bayes scoring)",
    operationalRole: "Syndicate Sub-acct Syntax & Twin Buffer",
  },
  {
    channelId: 5,
    sourceBridgeId: 2,
    canonicalProvenance: "PARTNER_118_GSBUILDER_L22",
    layerId: "L22.N1402",
    tokenName: "--sd-tier-steam",
    hex: "#f59e0b",
    channelCode: "GSBUILDER",
    wireAliases: ["GSBUILDER"],
    signalTier: "SIGNAL_SGP_BUILDER",
    transportUri: "portal://ticker/sgp-builder",
    sla: { kind: "latency", latencySlaMs: 1000 },
    slaTensOfMs: 100,
    channelStatus: "STEERABLE",
    volumeRule:
      "GS118_JOIN (joined via G<id> / M.G<betGroupId>; steerable via --steer)",
    operationalRole: "Steam / Line Chase Phrasing & SGP Builder",
  },
  {
    channelId: 6,
    sourceBridgeId: 2,
    canonicalProvenance: "PARTNER_118_GSLIVE_L23",
    layerId: "L23.N0412",
    tokenName: "--sd-tier-whale",
    hex: "#4ade80",
    legacyWireHex: "#28a745",
    channelCode: "GSLIVE",
    wireAliases: ["GSLIVE"],
    signalTier: "SIGNAL_GS_INPLAY",
    transportUri: "portal://ticker/gs-partner-118",
    sla: { kind: "latency", latencySlaMs: 500 },
    slaTensOfMs: 50,
    channelStatus: "CRITICAL",
    volumeRule:
      "GS118_JOIN (forces rotationGrade='LIVE'; extracts G<id> / M.G<id>; +20c tax)",
    operationalRole: "Whale Sizing Anomaly & In-Play Live Move",
  },
  {
    channelId: 7,
    sourceBridgeId: 1,
    canonicalProvenance: "FANTASY_402_CSLEVEL2_L24",
    layerId: "L24.N2019",
    tokenName: "--sd-tier-rec-bias",
    hex: "#7dd3fc",
    legacyWireHex: "#38bdf8",
    channelCode: "CSLEVEL2",
    wireAliases: ["CSLEVEL2"],
    signalTier: "SIGNAL_SYNDICATE_L2",
    transportUri: "portal://ticker/cslevel2-feed",
    sla: { kind: "latency", latencySlaMs: 2000 },
    slaTensOfMs: 200,
    channelStatus: "SUPPRESSED",
    volumeRule:
      "NONE (secondary syndicate/tennis/prop feed; steerable via --steer)",
    operationalRole: "Recreational Longshot Bias Ingestion",
  },
  {
    channelId: 8,
    sourceBridgeId: 1,
    canonicalProvenance: "FANTASY_402_LIVE_CWS",
    layerId: "L24B.N2110",
    tokenName: "--sd-tier-live-cws",
    hex: "#67e8f9",
    channelCode: "LIVEBETTINGCWS",
    wireAliases: ["LIVEBETTINGCWS", "EZLIVE"],
    signalTier: "SIGNAL_F402_INPLAY",
    transportUri: "portal://ticker/f402-live-cws",
    sla: { kind: "latency", latencySlaMs: 750 },
    slaTensOfMs: 75,
    channelStatus: "ACTIVE",
    volumeRule: "F402_INPLAY (promotes WagerType='G' and rotationGrade='LIVE')",
    operationalRole: "Fantasy402 Native In-Play Feed",
  },
  {
    channelId: 9,
    sourceBridgeId: 1,
    canonicalProvenance: "FANTASY_402_PHONE",
    layerId: "L24C.N2204",
    tokenName: "--sd-tier-phone",
    hex: "#a5b4fc",
    channelCode: "PHONE",
    wireAliases: ["PHONE", "CLERK"],
    signalTier: "SIGNAL_CLERK_ASSISTED",
    transportUri: "portal://ticker/clerk-phone",
    sla: { kind: "latency", latencySlaMs: 1500 },
    slaTensOfMs: 150,
    channelStatus: "ACTIVE",
    volumeRule: "AUDIT_MODE_2_10 (preserves clerkOperatorIdentifier)",
    operationalRole: "Clerk-Assisted Phone Ticket Ingestion",
  },
  {
    channelId: 10,
    sourceBridgeId: 1,
    canonicalProvenance: "FANTASY_402_HOUSE_BOOK",
    layerId: "L24D.N2308",
    tokenName: "--sd-tier-house",
    hex: "#e2e8f0",
    channelCode: "HOUSE",
    wireAliases: ["AGENT", "ADMIN", "HOUSE"],
    signalTier: "SIGNAL_HOUSE_LEDGER",
    transportUri: "portal://ticker/house-ledger",
    sla: { kind: "latency", latencySlaMs: 1500 },
    slaTensOfMs: 150,
    channelStatus: "ACTIVE",
    volumeRule: "AUDIT_MODE_2_10 (routes to Mode 2 & Mode 10 audit ledgers)",
    operationalRole: "Agent / Admin / House Transfer & Offset Ledger",
  },
];

/** Plane 2 latency SLA (ms) per lane — derived from `INGESTION_CHANNELS` / tokens.toml SSOT. */
export const SIGNAL_SLA_MS: Readonly<
  Record<SignalChannelCode, number | undefined>
> = Object.fromEntries(
  INGESTION_CHANNELS.map((c) => [
    c.channelCode,
    c.sla.kind === "latency" ? c.sla.latencySlaMs : undefined,
  ]),
) as Record<SignalChannelCode, number | undefined>;

/**
 * Packed channel-handle word: [4b channelId | 8b slaTensOfMs | 20b rowIndex].
 * Generated, dependency-free writer. `lib/nsh_frame_schema.ts` keeps the validating
 * codec wrapper for frame I/O; the bit layout here is the single generated copy.
 */
export type ChannelPackedHandle32 = Brand<number, "ChannelPackedHandle32">;

export function packChannelHandle32(
  channelId4: number,
  slaTensOfMs8: number,
  rowIndex20: number,
): ChannelPackedHandle32 {
  if (!Number.isInteger(channelId4) || channelId4 < 0 || channelId4 > 0xf) {
    throw new RangeError(
      `channelId4 must be an integer in [0, 15] (got ${String(channelId4)})`,
    );
  }
  if (
    !Number.isInteger(slaTensOfMs8) ||
    slaTensOfMs8 < 0 ||
    slaTensOfMs8 > 0xff
  ) {
    throw new RangeError(
      `slaTensOfMs8 must be an integer in [0, 255] (got ${String(slaTensOfMs8)})`,
    );
  }
  if (!Number.isInteger(rowIndex20) || rowIndex20 < 0 || rowIndex20 > 0xfffff) {
    throw new RangeError(
      `rowIndex20 must be an integer in [0, 1048575] (got ${String(rowIndex20)})`,
    );
  }
  const packedWord32 =
    ((channelId4 & 0xf) << 28) |
    ((slaTensOfMs8 & 0xff) << 20) |
    (rowIndex20 & 0xfffff);
  return (packedWord32 >>> 0) as ChannelPackedHandle32;
}

/**
 * One metadata word per ingestion channel, in `INGESTION_CHANNELS` order. The row index is 0:
 * this column carries channel provenance + SLA, not a customer row.
 */
export const CHANNEL_META_PACKED32_COL: Uint32Array = Uint32Array.from(
  INGESTION_CHANNELS.map((channel) =>
    packChannelHandle32(channel.channelId, channel.slaTensOfMs, 0),
  ),
);

/**
 * Decision & Route Continuum (Layers 25-28).
 * Generated directly from tokens.toml.
 */
export const ROUTE_CIRCUITS: readonly RouteCircuitDefinition[] = [
  {
    routeId: 0,
    layerId: "L25.N1882",
    tokenName: "--sd-route-devig",
    hex: "#22d3ee",
    routeName: "Route 04 Devig Consensus",
    moveFlag: "STEAM_CONVERGENCE",
    triggerKind: "ADVERSE_SELECTION",
    threshold: { kind: "consensus_lag", maxLagMs: 5000 },
    mitigationKind: "DYNAMIC_REPRICE",
    operationalRole: "Steam Convergence & Consensus Price Arbitration",
  },
  {
    routeId: 1,
    layerId: "L26.N3104",
    tokenName: "--sd-route-sharp",
    hex: "#c892ff",
    routeName: "Route 02 Sharp Shrinkage",
    moveFlag: "SHRINKAGE_SHARP",
    triggerKind: "CLV_MARGIN_DECAY",
    threshold: {
      kind: "bayes_shrinkage",
      tauStarBasisPoints: parseAsBasisPoints(6800, true),
      minTickets: 8,
    },
    mitigationKind: "SHRINKAGE_RECALIBRATE",
    operationalRole: "Bayesian Sharp Detection & Margin Decay Guard",
  },
  {
    routeId: 2,
    layerId: "L27.N0912",
    tokenName: "--sd-route-pending",
    hex: "#fb923c",
    routeName: "Route 01 Liquidity Breaker",
    moveFlag: "LIQUIDITY_HALT",
    triggerKind: "ORDER_BOOK_EXHAUSTION",
    threshold: { kind: "liquidity_depth", minDepthCents: parseAsCents(100000) },
    mitigationKind: "CIRCUIT_BREAKER_HALT",
    operationalRole: "Liquidity Exhaustion Protection & Breaker Trip",
  },
  {
    routeId: 3,
    layerId: "L28.N2501",
    tokenName: "--sd-route-manager",
    hex: "#ff758f",
    routeName: "Route 03 Manager Terminal",
    moveFlag: "TERMINAL_ENFORCE",
    triggerKind: "TERMINAL_DEFICIT_ESCALATION",
    threshold: {
      kind: "composite_risk_gate",
      minToxicityScore: 80,
      maxHoldRateBasisPoints: parseAsBasisPoints(-5000, true),
      maxDeficitCents: parseAsCents(10000000),
    },
    mitigationKind: "MANAGER_LIMIT_CLAMP",
    operationalRole: "Terminal Risk Containment & Manager Write-Gate",
  },
];

/**
 * Telemetry Viewports & Rendering Surfaces.
 * Generated directly from tokens.toml.
 */
export const TELEMETRY_SURFACES: readonly SurfaceDefinition[] = [
  {
    layerId: "SURFACE.DOM",
    tokenName: "--sd-surface-bg",
    hex: "#070b14",
    surfaceName: "Dark Obsidian Shell",
    targetViewport: "1440x900 (Desktop) / 375x812 (Mobile)",
    protocol: "W3C DOM / Canvas WebGL",
    colorDepth: "24-bit TrueColor RGB",
    operationalRole: "Main Dashboard DOM Surface Background",
  },
  {
    layerId: "SURFACE.CLI",
    tokenName: "--sd-surface-cli",
    hex: "#04070e",
    surfaceName: "Deterministic Dark ANSI",
    targetViewport: "DirectColor VT (Ghostty / xterm-direct)",
    protocol: "ANSI 24-bit TrueColor (\\x1b[38;2;R;G;Bm)",
    colorDepth: "24-bit TrueColor RGB",
    operationalRole: "CLI Terminal Telemetry Surface Background",
  },
];

/**
 * Dashboard UI chrome tokens (cards, borders, focus rings, text). Not neurons:
 * excluded from the pairwise ΔE00 floor, gated by role-specific WCAG contrast instead.
 */
export interface UiTokenDefinition {
  readonly tokenName: string;
  readonly hex: string;
  readonly role:
    | "surface"
    | "border"
    | "border_hairline"
    | "border_interactive"
    | "focus"
    | "text";
  readonly stateSlot?: string;
  readonly description: string;
}

export const UI_TOKENS: readonly UiTokenDefinition[] = [
  {
    tokenName: "--sd-surface-card",
    hex: "#0b1120",
    role: "surface",
    stateSlot: "rest",
    description: "Cards, panels, table bodies",
  },
  {
    tokenName: "--sd-surface-elevated",
    hex: "#121c31",
    role: "surface",
    stateSlot: "elevated",
    description: "Elevated drawers, modals, and floating popovers",
  },
  {
    tokenName: "--sd-surface-hover",
    hex: "#19263d",
    role: "surface",
    stateSlot: "hover",
    description: "Hovered cards, interactive controls, and table rows",
  },
  {
    tokenName: "--sd-surface-raised",
    hex: "#202f4a",
    role: "surface",
    stateSlot: "raised",
    description: "Raised headers, toolbar strips, and inspector sub-cards",
  },
  {
    tokenName: "--sd-surface-selected",
    hex: "#0f3a5d",
    role: "surface",
    stateSlot: "selected",
    description: "Active BitSet32 roving tab slot and selected DataTable row",
  },
  {
    tokenName: "--sd-surface-border",
    hex: "#243247",
    role: "border_hairline",
    description: "Decorative hairlines and non-interactive structural dividers",
  },
  {
    tokenName: "--sd-border-strong",
    hex: "#7085a1",
    role: "border_interactive",
    description:
      "Emphasized panel borders, active control outlines, and keycaps",
  },
  {
    tokenName: "--sd-focus-ring",
    hex: "#38bdf8",
    role: "focus",
    description: "Keyboard roving tabindex and modal restore focus ring",
  },
  {
    tokenName: "--sd-focus-ring-offset",
    hex: "#070b14",
    role: "border_hairline",
    description:
      "2px inner separation ring isolating focus_ring from active fills",
  },
  {
    tokenName: "--sd-text-primary",
    hex: "#f1f5f9",
    role: "text",
    description: "Body copy and headings",
  },
  {
    tokenName: "--sd-text-secondary",
    hex: "#cbd5e1",
    role: "text",
    description: "Subheadings, metric values, and active controls",
  },
  {
    tokenName: "--sd-text-muted",
    hex: "#94a3b8",
    role: "text",
    description: "Secondary copy, labels, disabled hints, and table headers",
  },
];

export interface SlaStateDefinition {
  readonly stateId: string;
  readonly tokenName: string;
  readonly fgHex: string;
  readonly bgHex: string;
  readonly borderHex: string;
  readonly description: string;
}

export interface SlaCssTokenDefinition {
  readonly stateId: string;
  readonly tokenName: string;
  readonly hex: string;
  readonly role: "fg" | "bg" | "border";
}

export const SLA_STATES: readonly SlaStateDefinition[] = [
  {
    stateId: "SLA_FRESH",
    tokenName: "--sd-sla-fresh",
    fgHex: "#34d399",
    bgHex: "#0a2922",
    borderHex: "#10b981",
    description: "Publish age and upstream data_window_max_epoch_ms within SLA",
  },
  {
    stateId: "SLA_WARN",
    tokenName: "--sd-sla-warn",
    fgHex: "#38bdf8",
    bgHex: "#0c2438",
    borderHex: "#29b6f6",
    description: "Half-window aging advisory; polling active",
  },
  {
    stateId: "SLA_STALE",
    tokenName: "--sd-sla-stale",
    fgHex: "#fbbf24",
    bgHex: "#2b200c",
    borderHex: "#f59e0b",
    description: "BLK_R2_PUBLISH_STALE or BLK_R2_WINDOW_LAG_STALE breached",
  },
  {
    stateId: "SLA_POISON",
    tokenName: "--sd-sla-poison",
    fgHex: "#fca5a5",
    bgHex: "#2d161d",
    borderHex: "#ff7878",
    description:
      "STALE_SNAPSHOT_POISON_BIT set or Class A HTML-on-200 quarantine",
  },
];

export const SLA_CSS_TOKENS: readonly SlaCssTokenDefinition[] = [
  {
    stateId: "SLA_FRESH",
    tokenName: "--sd-sla-fresh",
    hex: "#34d399",
    role: "fg",
  },
  {
    stateId: "SLA_FRESH",
    tokenName: "--sd-sla-fresh-bg",
    hex: "#0a2922",
    role: "bg",
  },
  {
    stateId: "SLA_FRESH",
    tokenName: "--sd-sla-fresh-border",
    hex: "#10b981",
    role: "border",
  },
  {
    stateId: "SLA_WARN",
    tokenName: "--sd-sla-warn",
    hex: "#38bdf8",
    role: "fg",
  },
  {
    stateId: "SLA_WARN",
    tokenName: "--sd-sla-warn-bg",
    hex: "#0c2438",
    role: "bg",
  },
  {
    stateId: "SLA_WARN",
    tokenName: "--sd-sla-warn-border",
    hex: "#29b6f6",
    role: "border",
  },
  {
    stateId: "SLA_STALE",
    tokenName: "--sd-sla-stale",
    hex: "#fbbf24",
    role: "fg",
  },
  {
    stateId: "SLA_STALE",
    tokenName: "--sd-sla-stale-bg",
    hex: "#2b200c",
    role: "bg",
  },
  {
    stateId: "SLA_STALE",
    tokenName: "--sd-sla-stale-border",
    hex: "#f59e0b",
    role: "border",
  },
  {
    stateId: "SLA_POISON",
    tokenName: "--sd-sla-poison",
    hex: "#fca5a5",
    role: "fg",
  },
  {
    stateId: "SLA_POISON",
    tokenName: "--sd-sla-poison-bg",
    hex: "#2d161d",
    role: "bg",
  },
  {
    stateId: "SLA_POISON",
    tokenName: "--sd-sla-poison-border",
    hex: "#ff7878",
    role: "border",
  },
];

export const BET_LEG_BIT_POSITIONS = {
  IS_LIVE_LEG: 0,
  IS_ALT_SPREAD_PLUS_5000: 1,
  IS_SPLIT_MARKET_EXEMPT: 2,
  IS_SIGNAL_DONOR_EXEMPT: 3,
  IS_PARTNER_118_SKIN: 4,
  IS_SAME_GAME_CORRELATED: 5,
} as const;

export const BET_LEG_BITMASKS = {
  IS_LIVE_LEG: 0x00000001 as BitSet32,
  IS_ALT_SPREAD_PLUS_5000: 0x00000002 as BitSet32,
  IS_SPLIT_MARKET_EXEMPT: 0x00000004 as BitSet32,
  IS_SIGNAL_DONOR_EXEMPT: 0x00000008 as BitSet32,
  IS_PARTNER_118_SKIN: 0x00000010 as BitSet32,
  IS_SAME_GAME_CORRELATED: 0x00000020 as BitSet32,
} as const;

export const UI_STATE_BIT_POSITIONS = {
  MODAL_OPEN_BIT: 0,
  INSPECTOR_DRAWER_BIT: 1,
  FILTER_LOCK_BIT: 2,
  ARIA_LIVE_COALESCE_BIT: 3,
  FOCUS_RING_VISIBLE_BIT: 4,
  STALE_SNAPSHOT_POISON_BIT: 30,
} as const;

export const UI_STATE_BITMASKS = {
  MODAL_OPEN_BIT: 0x00000001 as BitSet32,
  INSPECTOR_DRAWER_BIT: 0x00000002 as BitSet32,
  FILTER_LOCK_BIT: 0x00000004 as BitSet32,
  ARIA_LIVE_COALESCE_BIT: 0x00000008 as BitSet32,
  FOCUS_RING_VISIBLE_BIT: 0x00000010 as BitSet32,
  STALE_SNAPSHOT_POISON_BIT: 0x40000000 as BitSet32,
} as const;

export interface OperatorKeymapSlot {
  readonly slotIndex: number;
  readonly bitMask: BitSet32;
  readonly keyCode: string;
  readonly keycap: string;
  readonly forensicMode: number;
  readonly label: string;
}

export const OPERATOR_KEYMAP: readonly OperatorKeymapSlot[] = [
  {
    slotIndex: 0,
    bitMask: 0x0001 as BitSet32,
    keyCode: "Digit1",
    keycap: "1",
    forensicMode: 1,
    label: "Live Ticker",
  },
  {
    slotIndex: 1,
    bitMask: 0x0002 as BitSet32,
    keyCode: "Digit2",
    keycap: "2",
    forensicMode: 2,
    label: "Clerk & House Audit",
  },
  {
    slotIndex: 2,
    bitMask: 0x0004 as BitSet32,
    keyCode: "Digit3",
    keycap: "3",
    forensicMode: 3,
    label: "Pending Exposure",
  },
  {
    slotIndex: 3,
    bitMask: 0x0008 as BitSet32,
    keyCode: "Digit4",
    keycap: "4",
    forensicMode: 4,
    label: "Parlay & Combo Ladder",
  },
  {
    slotIndex: 4,
    bitMask: 0x0010 as BitSet32,
    keyCode: "Digit5",
    keycap: "5",
    forensicMode: 5,
    label: "Partner 118 GSLive",
  },
  {
    slotIndex: 5,
    bitMask: 0x0020 as BitSet32,
    keyCode: "Digit6",
    keycap: "6",
    forensicMode: 6,
    label: "WebLog & IP Tracker",
  },
  {
    slotIndex: 6,
    bitMask: 0x0040 as BitSet32,
    keyCode: "Digit7",
    keycap: "7",
    forensicMode: 7,
    label: "Sharp Shrinkage",
  },
  {
    slotIndex: 7,
    bitMask: 0x0080 as BitSet32,
    keyCode: "Digit8",
    keycap: "8",
    forensicMode: 8,
    label: "Delay Bitsets (10-12s)",
  },
  {
    slotIndex: 8,
    bitMask: 0x0100 as BitSet32,
    keyCode: "Digit9",
    keycap: "9",
    forensicMode: 9,
    label: "Cross-Market Hedge",
  },
  {
    slotIndex: 9,
    bitMask: 0x0200 as BitSet32,
    keyCode: "Digit0",
    keycap: "0",
    forensicMode: 10,
    label: "Reconciliation & Ledger",
  },
];

/**
 * Slot-indexed bit column for the 10-key operator keymap:
 * `KEYMAP_SLOTS[slotIndex] === OPERATOR_KEYMAP[slotIndex].bitMask` (1 << slotIndex).
 * The array order is the bijection itself; do not sort or compact it.
 */
export const KEYMAP_SLOTS: Uint32Array = Uint32Array.from([
  1, 2, 4, 8, 16, 32, 64, 128, 256, 512,
]);

/**
 * Complete registry across all decoupled axes (Ingestion + Routes + Surfaces).
 */
export const ALL_QWEN_TOKENS: readonly AnyQwenNeuronDefinition[] = [
  ...INGESTION_CHANNELS,
  ...ROUTE_CIRCUITS,
  ...TELEMETRY_SURFACES,
];
