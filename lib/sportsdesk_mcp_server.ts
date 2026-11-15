/**
 * @file lib/sportsdesk_mcp_server.ts
 * @description Native Bun StreamableHTTP Model Context Protocol (`/mcp`) server and
 * read-only spine toolset for `sportsdesk-ops`.
 *
 * Directly imports the TypeScript spine modules (zero IPC, zero cross-language serialization):
 *  - `get_channel_provenance`: `lib/provenance_palette.ts`, `design/domain-branded-types.ts`, `lib/domain_venue_registry.ts`
 *  - `get_bridge_channel_catalog`: `lib/bridge_and_channel_router.ts`, `lib/nsh_frame_schema.ts`
 *  - `check_sor_slippage`: `lib/execution_decision.ts` + SOR-1 200 bps / NSH u8 frame bounds
 *  - `decode_nsh_frame`: `lib/nsh_frame_codec.ts`, `lib/nsh_frame_schema.ts`
 *  - `get_trading_desk_kpis_and_sport_tree`: `lib/sport_taxonomy.ts` + top KPI strip & live sport tree
 *  - `get_live_line_trading_board`: `lib/layoff_risk_engine.ts` + live line ladder & multi-match cards
 *  - `get_active_bet_blotter`: `lib/live_wagers.ts`, `lib/provenance_palette.ts` + read-only blotter & OTC snapshots
 *  - `get_liability_and_polymarket_liquidity`: `lib/execution_decision.ts` + book liability vs Polymarket CLOB depth
 *
 * Supports both stateful `Mcp-Session-Id` StreamableHTTP sessions (default) and
 * per-request `--stateless` operation, gated by constant-time `SPORTSDESK_ADMIN_TOKEN`
 * Bearer authentication unless explicitly disabled for local CLI inspection.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  INGESTION_CHANNELS,
  isColorHexInt,
  parseAsColorHexInt,
  type ColorHexInt,
  type SignalChannelCode,
} from "../design/domain-branded-types.ts";
import {
  DodGateFailureError,
  NULL_BRIDGE_CHANNEL_WORD32,
  SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
  TRANSPORT_BRIDGE_SPECIFICATION_TABLE,
  asBitSet32,
  asCents,
  asDurationMilliseconds,
  encodeBridgeChannelPackedWord32,
  isTransportBridgePermittedForChannel,
  resolveSeparatedBridgeAndChannelEnvelope,
  type BridgeChannelPackedWord32,
  type ExtendedSignalChannelCode,
  type RawWireIngestEnvelope,
  type SignalChannelPolicySpecification,
  type TransportBridgeId,
  type TransportBridgeSpecification,
} from "./bridge_and_channel_router.ts";
import {
  ORIGIN_DOMAIN_REGISTRY,
  sentinelChannelEntryFor,
  writerLaneEntryForChannel,
  WRITER_LANE_REGISTRY,
  resolveWriterChannel,
  resolveWriterLaneId,
  type OriginDomainEntry,
  type WriterLaneEntry,
} from "./domain_venue_registry.ts";
import {
  DEFAULT_SPORT_TIERS,
  policyFromEnv,
  tierForPolicy,
  walkBook,
} from "./execution_decision.ts";
import {
  detectKeyNumberCrossing,
  evaluateBetterVenue,
} from "./layoff_risk_engine.ts";
import { isTickerNoise, writerOf } from "./live_wagers.ts";
import {
  NSH_FRAME_BYTE_LENGTH,
  NSH_FRAME_MAGIC,
  NSH_FRAME_VERSION,
  NSH_MESSAGE_TYPE,
  NshFrameCodecError,
  readNshBinaryFrame,
} from "./nsh_frame_codec.ts";
import {
  NSH_FRAME_LAYOUT,
  decodeBridgeChannelPackedWord32,
  packChannelHandle32,
  provenanceForChannelOrdinal,
  resolveRouteWordChannelAndSla,
  resolveSourceBridgePrefix,
  unpackChannelHandle32,
} from "./nsh_frame_schema.ts";
import {
  PROVENANCE_CHANNEL_CODES,
  provenanceCodeForColor,
  provenanceColorFor,
  provenanceCssFor,
  provenanceCssForColor,
} from "./provenance_palette.ts";
import { SPORT_CATEGORIES, sportCategoryFor } from "./sport_taxonomy.ts";

export const DEFAULT_MCP_WORKSPACE_ROOT: string = fileURLToPath(
  new URL("..", import.meta.url),
);

export const SPORTSDESK_MCP_SERVER_NAME = "sportsdesk-ops" as const;
export const SPORTSDESK_MCP_SERVER_VERSION = "1.0.0" as const;

/** Default soft-limit slippage warning threshold (25 bps) before SOR-1 hard rejection. */
export const SOR_DEFAULT_SOFT_LIMIT_BPS = 25 as const;
/** SOR-1 execution ceiling encoded into the 1-byte `slippageBps8` NSH frame slot. */
export const SOR1_MAX_SLIPPAGE_BPS = 200 as const;
/** Hardware width ceiling of `slippageBps8` at byte offset 61 of the 64-byte NSH frame. */
export const NSH_FRAME_SLIPPAGE_U8_MAX = 255 as const;

export class SportsdeskMcpWireError extends Error {
  readonly errorCode: string;

  constructor(errorCode: string, message: string) {
    super(message);
    this.name = "SportsdeskMcpWireError";
    this.errorCode = errorCode;
  }
}

export const MCP_DEV_DEFAULT_CORS_ORIGINS = [
  "dsh-app://app",
  "http://localhost:3080",
  "http://127.0.0.1:3080",
] as const;

export function resolveMcpAllowedOrigins(
  isDevelopment: boolean,
  envOrigins: string | undefined = Bun.env.SPORTSDESK_ALLOWED_ORIGINS,
): string[] {
  const allowedOrigins = (envOrigins ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin !== "");

  if (isDevelopment && allowedOrigins.length === 0) {
    allowedOrigins.push(...MCP_DEV_DEFAULT_CORS_ORIGINS);
  }
  return allowedOrigins;
}

const DEFAULT_MAX_MCP_SESSIONS = 256;
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;
/** Stay below Bun.serve's 10s default socket idleTimeout so GET /mcp SSE streams stay alive. */
const DEFAULT_SSE_KEEPALIVE_MS = 8_000;
const MAX_ECMA_DATE_TIMESTAMP_MS = 8_640_000_000_000_000;
const INITIAL_SSE_FLUSH_BYTES = new TextEncoder().encode(": keepalive\n\n");

const MCP_ALLOW_METHODS = "GET, POST, DELETE, OPTIONS";
const MCP_ALLOW_HEADERS =
  "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID, X-Requested-With";
const MCP_EXPOSE_HEADERS = "Mcp-Session-Id, Mcp-Protocol-Version";

const PROVENANCE_CHANNEL_ENUM_VALUES = [
  "NON_SPORTS",
  "Internet",
  "BLOCKED",
  "GATEWAY",
  "ALERT",
  "GSBUILDER",
  "GSLIVE",
  "CSLEVEL2",
  "LIVEBETTINGCWS",
  "PHONE",
  "HOUSE",
] as const satisfies readonly SignalChannelCode[];

const TRANSPORT_BRIDGE_ENUM_VALUES = [
  "BRIDGE_00_GSLIVE_WAGERS_BY_STATE",
  "BRIDGE_01_F402_BET_TICKER_STREAM",
  "BRIDGE_02_F402_PENDING_AND_GRADING",
  "BRIDGE_03_GSLIVE_PARTNER118_TALLY",
  "BRIDGE_04_F402_WEBLOG_ACCESS_OVERLAP",
  "BRIDGE_05_POLYMARKET_GAMMA_DISCOVERY",
  "BRIDGE_06_POLYMARKET_CLOB_WEBSOCKET",
  "BRIDGE_07_POLYGON_FASTLANE_ORDER_FILLED",
  "BRIDGE_08_POLYMARKET_DATA_API_POSITIONS",
  "BRIDGE_09_KALSHI_EXCHANGE_V2_STREAM",
] as const satisfies readonly TransportBridgeId[];

const EXTENDED_CHANNEL_ENUM_VALUES = [
  "NON_SPORTS_DROP",
  "BLOCKED",
  "GATEWAY",
  "ALERT",
  "Internet",
  "GSLIVE",
  "GSBUILDER",
  "LIVE_CWS",
  "CSLEVEL2",
  "PHONE",
  "HOUSE_BOOK",
  "CROSS_VENUE_SHADOW_WALLET_LEAD",
  "CROSS_VENUE_QUARANTINE_SCALP_EXIT",
  "CROSS_VENUE_SYNDICATE_CLUSTER_CONFIRM",
  "CROSS_VENUE_RFQ_COMBO_LAYOFF",
  "CROSS_VENUE_KEY_NUMBER_MIDDLE",
] as const satisfies readonly ExtendedSignalChannelCode[];

const MESSAGE_TYPE_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [NSH_MESSAGE_TYPE.TICKER_MATCH]: "TICKER_MATCH",
  [NSH_MESSAGE_TYPE.LIABILITY_UPDATE]: "LIABILITY_UPDATE",
  [NSH_MESSAGE_TYPE.ORDERBOOK_DELTA]: "ORDERBOOK_DELTA",
});

const ORDERED_BRIDGES: readonly TransportBridgeSpecification[] = Object.freeze(
  Object.values(TRANSPORT_BRIDGE_SPECIFICATION_TABLE).sort(
    (a, b) => a.bridgeOrdinal4 - b.bridgeOrdinal4,
  ),
);

const ORDERED_CHANNELS: readonly SignalChannelPolicySpecification[] =
  Object.freeze(
    Object.values(SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE).sort(
      (a, b) => a.channelOrdinal5 - b.channelOrdinal5,
    ),
  );

// ============================================================================
// 1. TOOL SCHEMAS & PURE HANDLERS
// ============================================================================

const ORIGIN_DOMAIN_ITEM_SCHEMA = z.object({
  originDomainId: z.string(),
  venueId: z.string(),
  displayLabel: z.string(),
  brandColorHex: z.string(),
  defaultTokenCode: z.string(),
});

const WRITER_LANE_ITEM_SCHEMA = z.object({
  writerLaneId: z.string(),
  originDomainId: z.string(),
  venueId: z.string(),
  tokenProvenanceCode: z.string(),
  provenanceLabel: z.string(),
  signalChannelCode: z.string(),
  brandColorHex: z.string(),
});

function serializeOriginDomainEntry(entry: OriginDomainEntry) {
  return {
    originDomainId: entry.originDomainId,
    venueId: entry.venueId,
    displayLabel: entry.displayLabel,
    brandColorHex: entry.brandColorHex,
    defaultTokenCode: entry.defaultTokenCode,
  };
}

const SENTINEL_CHANNEL_ITEM_SCHEMA = z.object({
  sentinelId: z.string(),
  provenanceLabel: z.string(),
  signalChannelCode: z.string().nullable(),
  laneId: z.string().nullable(),
  brandColorHex: z.string(),
  isMoneyExcluded: z.literal(true),
});

function serializeWriterLaneEntry(entry: WriterLaneEntry) {
  return {
    writerLaneId: entry.writerLaneId,
    originDomainId: entry.originDomainId,
    venueId: entry.venueId,
    tokenProvenanceCode: entry.tokenProvenanceCode,
    provenanceLabel: entry.provenanceLabel,
    signalChannelCode: entry.signalChannelCode,
    brandColorHex: entry.brandColorHex,
  };
}

const PROVENANCE_CHANNEL_ITEM_SCHEMA = z.object({
  channelCode: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES),
  colorHexInt: z.number().int().min(0).max(0xffffff),
  colorCss: z.string(),
  layerId: z.string(),
  tokenName: z.string(),
  signalTier: z.string(),
  transportUri: z.string(),
  slaKind: z.enum(["latency", "sentinel_drop"]),
  slaMs: z.number().int().nullable(),
  channelStatus: z.string(),
  volumeRule: z.string(),
  operationalRole: z.string(),
});

const ROUTING_CHANNEL_PROVENANCE_SCHEMA = z.object({
  channelOrdinal: z.number().int().min(0).max(15),
  channelCode: z.enum(EXTENDED_CHANNEL_ENUM_VALUES),
  provenanceChannelCode: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES),
  colorHexInt: z.number().int().min(0).max(0xffffff),
  colorCss: z.string(),
  neuronTokenIdentifier: z.string(),
  kind: z.string(),
  routingDisposition: z.string(),
  treasuryCapitalSilo: z.string(),
  executionSlaDurationMs: z.number().int(),
  slaDivide10Ms8: z.number().int(),
  permittedBridgeBitMask32: z.number().int(),
  permittedBridges: z.array(z.enum(TRANSPORT_BRIDGE_ENUM_VALUES)),
  permittedOriginDomains: z.array(ORIGIN_DOMAIN_ITEM_SCHEMA),
});

const BRIDGE_PROVENANCE_RESOLUTION_SCHEMA = z.object({
  bridgeOrdinal: z.number().int().min(0).max(9),
  bridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
  originDomainId: z.string(),
  venueId: z.string(),
  displayLabel: z.string(),
  brandColorHex: z.string(),
  sourceBridgePrefix: z.string(),
  bridgeQualifiedChannelCode: z.string().nullable(),
  packedRouteWord32: z.number().int().nullable(),
});

export const GET_CHANNEL_PROVENANCE_INPUT = {
  channelOrdinal: z
    .number()
    .int()
    .min(0)
    .max(15)
    .optional()
    .describe(
      "4-bit routing channel ordinal (0..15, e.g. 5=GSLIVE, 7=LIVE_CWS, 14=CROSS_VENUE_RFQ_COMBO_LAYOFF)",
    ),
  bridgeOrdinal: z
    .number()
    .int()
    .min(0)
    .max(9)
    .optional()
    .describe(
      "Optional 4-bit transport bridge ordinal (0..9) for bridge-pinned origin domain resolution",
    ),
  channelCode: z
    .enum(EXTENDED_CHANNEL_ENUM_VALUES)
    .optional()
    .describe(
      "Canonical 11-entry ingestion provenance channel code or 16-entry ExtendedSignalChannelCode to inspect",
    ),
  writer: z
    .string()
    .min(1)
    .max(64)
    .regex(/\S/, "writer must contain at least one non-whitespace character")
    .optional()
    .describe(
      "Raw ticket writer or venue alias (for example partner118, inet, polymarket, kalshi)",
    ),
  color: z
    .union([z.string().min(1).max(16), z.number().int().min(0).max(0xffffff)])
    .optional()
    .describe(
      "Packed 24-bit RGB integer (0..16777215) or #RRGGBB / 0xRRGGBB hex string for reverse lookup",
    ),
};

const GET_CHANNEL_PROVENANCE_OUTPUT = {
  channels: z.array(PROVENANCE_CHANNEL_ITEM_SCHEMA),
  matchedChannel: PROVENANCE_CHANNEL_ITEM_SCHEMA.nullable(),
  routingChannel: ROUTING_CHANNEL_PROVENANCE_SCHEMA.nullable(),
  bridgeResolution: BRIDGE_PROVENANCE_RESOLUTION_SCHEMA.nullable(),
  resolvedOriginDomain: ORIGIN_DOMAIN_ITEM_SCHEMA.nullable(),
  writerResolution: z
    .object({
      rawWriter: z.string(),
      writerLaneId: z.string(),
      originDomainId: z.string(),
      venueId: z.string(),
      tokenProvenanceCode: z.string(),
      provenanceLabel: z.string(),
      brandColorHex: z.string(),
    })
    .nullable(),
  colorLookup: z
    .object({
      colorHexInt: z.number().int().min(0).max(0xffffff),
      colorCss: z.string(),
      matchedChannelCode: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES).nullable(),
    })
    .nullable(),
  originDomains: z.array(ORIGIN_DOMAIN_ITEM_SCHEMA),
};

type GetChannelProvenanceInput = z.infer<
  z.ZodObject<typeof GET_CHANNEL_PROVENANCE_INPUT>
>;

function parseColorLookupInput(raw: string | number): ColorHexInt {
  if (typeof raw === "number") {
    if (!isColorHexInt(raw)) {
      throw new SportsdeskMcpWireError(
        "invalid_provenance_query",
        `Color integer must be within 24-bit RGB [0, 0xFFFFFF], got ${String(raw)}`,
      );
    }
    return raw;
  }
  const trimmed = raw.trim();
  if (/^0x[0-9a-fA-F]{1,6}$/i.test(trimmed)) {
    const parsed = Number.parseInt(trimmed.slice(2), 16);
    if (!isColorHexInt(parsed)) {
      throw new SportsdeskMcpWireError(
        "invalid_provenance_query",
        `Invalid 24-bit hex color literal: ${raw}`,
      );
    }
    return parsed;
  }
  const hexMatch = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (!hexMatch?.[1]) {
    throw new SportsdeskMcpWireError(
      "invalid_provenance_query",
      `Invalid 24-bit hex color '${raw}': expected #RRGGBB, 0xRRGGBB, or RRGGBB`,
    );
  }
  return parseAsColorHexInt(`#${hexMatch[1]}`);
}

function serializeProvenanceChannel(
  channel: (typeof INGESTION_CHANNELS)[number],
) {
  return {
    channelCode: channel.channelCode,
    colorHexInt: provenanceColorFor(channel.channelCode) as number,
    colorCss: provenanceCssFor(channel.channelCode),
    layerId: channel.layerId,
    tokenName: channel.tokenName,
    signalTier: channel.signalTier,
    transportUri: channel.transportUri,
    slaKind: channel.sla.kind,
    slaMs: channel.sla.kind === "latency" ? channel.sla.latencySlaMs : null,
    channelStatus: channel.channelStatus,
    volumeRule: channel.volumeRule,
    operationalRole: channel.operationalRole,
  };
}

function resolveRoutingChannelSpecFromQuery(
  channelOrdinal: number | undefined,
  channelCode: ExtendedSignalChannelCode | undefined,
): SignalChannelPolicySpecification | null {
  let byOrdinal: SignalChannelPolicySpecification | null = null;
  if (channelOrdinal !== undefined) {
    if (
      !Number.isInteger(channelOrdinal) ||
      channelOrdinal < 0 ||
      channelOrdinal >= ORDERED_CHANNELS.length
    ) {
      throw new SportsdeskMcpWireError(
        "invalid_provenance_query",
        `channelOrdinal must be an integer in [0, 15], got ${String(channelOrdinal)}`,
      );
    }
    byOrdinal = ORDERED_CHANNELS[channelOrdinal] ?? null;
  }

  let byCode: SignalChannelPolicySpecification | null = null;
  if (channelCode !== undefined) {
    const spec = Object.hasOwn(
      SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE,
      channelCode,
    )
      ? SIGNAL_CHANNEL_POLICY_SPECIFICATION_TABLE[channelCode]
      : undefined;
    if (!spec) {
      throw new SportsdeskMcpWireError(
        "invalid_provenance_query",
        `Unknown ExtendedSignalChannelCode '${String(channelCode)}'`,
      );
    }
    byCode = spec;
  }

  if (
    byOrdinal !== null &&
    byCode !== null &&
    byOrdinal.channelCode !== byCode.channelCode
  ) {
    throw new SportsdeskMcpWireError(
      "invalid_provenance_query",
      `Conflicting channelOrdinal=${byOrdinal.channelOrdinal5} (${byOrdinal.channelCode}) and channelCode='${byCode.channelCode}' (ordinal=${byCode.channelOrdinal5})`,
    );
  }

  return byOrdinal ?? byCode;
}

export function runGetChannelProvenanceTool(
  input: GetChannelProvenanceInput,
): CallToolResult {
  try {
    const allSerialized = INGESTION_CHANNELS.map(serializeProvenanceChannel);
    const resolvedChannelSpec = resolveRoutingChannelSpecFromQuery(
      input.channelOrdinal,
      input.channelCode,
    );

    let routingChannel: z.infer<
      typeof ROUTING_CHANNEL_PROVENANCE_SCHEMA
    > | null = null;
    if (resolvedChannelSpec !== null) {
      const provenanceChannelCode = provenanceForChannelOrdinal(
        resolvedChannelSpec.channelOrdinal5,
      );
      const permittedBridgeSpecs = ORDERED_BRIDGES.filter((br) =>
        isTransportBridgePermittedForChannel(
          br.bridgeId,
          resolvedChannelSpec.channelCode,
        ),
      );
      const seenOriginIds: string[] = [];
      const permittedOriginDomains: Array<
        ReturnType<typeof serializeOriginDomainEntry>
      > = [];
      for (const bridgeSpec of permittedBridgeSpecs) {
        if (!seenOriginIds.includes(bridgeSpec.originDomain)) {
          seenOriginIds.push(bridgeSpec.originDomain);
          permittedOriginDomains.push(
            serializeOriginDomainEntry(
              ORIGIN_DOMAIN_REGISTRY[bridgeSpec.originDomain],
            ),
          );
        }
      }
      const rawSlaDivide10 = Math.round(
        (resolvedChannelSpec.executionSlaDurationMs as number) / 10,
      );
      routingChannel = {
        channelOrdinal: resolvedChannelSpec.channelOrdinal5,
        channelCode: resolvedChannelSpec.channelCode,
        provenanceChannelCode,
        colorHexInt: provenanceColorFor(provenanceChannelCode) as number,
        colorCss: provenanceCssFor(provenanceChannelCode),
        neuronTokenIdentifier: resolvedChannelSpec.neuronTokenIdentifier,
        kind: resolvedChannelSpec.kind,
        routingDisposition: resolvedChannelSpec.routingDisposition,
        treasuryCapitalSilo: resolvedChannelSpec.treasuryCapitalSilo,
        executionSlaDurationMs:
          resolvedChannelSpec.executionSlaDurationMs as number,
        slaDivide10Ms8: Math.min(0xff, Math.max(0, rawSlaDivide10)),
        permittedBridgeBitMask32:
          resolvedChannelSpec.permittedBridgeBitMask32 as number,
        permittedBridges: permittedBridgeSpecs.map((br) => br.bridgeId),
        permittedOriginDomains,
      };
    }

    let bridgeSpec: TransportBridgeSpecification | null = null;
    let bridgeResolution: z.infer<
      typeof BRIDGE_PROVENANCE_RESOLUTION_SCHEMA
    > | null = null;
    if (input.bridgeOrdinal !== undefined) {
      if (
        !Number.isInteger(input.bridgeOrdinal) ||
        input.bridgeOrdinal < 0 ||
        input.bridgeOrdinal >= ORDERED_BRIDGES.length
      ) {
        throw new SportsdeskMcpWireError(
          "invalid_provenance_query",
          `bridgeOrdinal must be an integer in [0, 9], got ${String(input.bridgeOrdinal)}`,
        );
      }
      bridgeSpec = ORDERED_BRIDGES[input.bridgeOrdinal]!;
      const originEntry = ORIGIN_DOMAIN_REGISTRY[bridgeSpec.originDomain];
      if (resolvedChannelSpec !== null) {
        const routeResolved = resolveRouteWordChannelAndSla({
          bridgeOrdinal4: bridgeSpec.bridgeOrdinal4,
          channelOrdinal5: resolvedChannelSpec.channelOrdinal5,
        });
        const packedWord = encodeBridgeChannelPackedWord32(
          bridgeSpec.bridgeId,
          resolvedChannelSpec.channelCode,
        );
        bridgeResolution = {
          bridgeOrdinal: bridgeSpec.bridgeOrdinal4,
          bridgeId: bridgeSpec.bridgeId,
          originDomainId: originEntry.originDomainId,
          venueId: originEntry.venueId,
          displayLabel: originEntry.displayLabel,
          brandColorHex: originEntry.brandColorHex,
          sourceBridgePrefix: routeResolved.sourceBridgePrefix,
          bridgeQualifiedChannelCode: routeResolved.bridgeQualifiedChannelCode,
          packedRouteWord32: packedWord as number,
        };
      } else {
        bridgeResolution = {
          bridgeOrdinal: bridgeSpec.bridgeOrdinal4,
          bridgeId: bridgeSpec.bridgeId,
          originDomainId: originEntry.originDomainId,
          venueId: originEntry.venueId,
          displayLabel: originEntry.displayLabel,
          brandColorHex: originEntry.brandColorHex,
          sourceBridgePrefix: resolveSourceBridgePrefix(
            bridgeSpec.originDomain,
          ),
          bridgeQualifiedChannelCode: null,
          packedRouteWord32: null,
        };
      }
    }

    const filteredChannels =
      routingChannel !== null
        ? allSerialized.filter(
            (c) => c.channelCode === routingChannel.provenanceChannelCode,
          )
        : allSerialized;

    let writerResolution: {
      rawWriter: string;
      writerLaneId: string;
      originDomainId: string;
      venueId: string;
      tokenProvenanceCode: string;
      provenanceLabel: string;
      brandColorHex: string;
    } | null = null;
    let writerOriginEntry: OriginDomainEntry | null = null;

    if (input.writer !== undefined) {
      if (input.writer.trim() === "") {
        throw new SportsdeskMcpWireError(
          "invalid_provenance_query",
          "writer must be a non-empty, non-whitespace string",
        );
      }
      const laneId = resolveWriterLaneId(input.writer);
      const lane = WRITER_LANE_REGISTRY[laneId];
      writerOriginEntry = ORIGIN_DOMAIN_REGISTRY[lane.originDomainId];
      writerResolution = {
        rawWriter: input.writer,
        ...serializeWriterLaneEntry(lane),
      };
    }

    let colorLookup: {
      colorHexInt: number;
      colorCss: string;
      matchedChannelCode: SignalChannelCode | null;
    } | null = null;

    if (input.color !== undefined) {
      const parsedColor = parseColorLookupInput(input.color);
      colorLookup = {
        colorHexInt: parsedColor as number,
        colorCss: provenanceCssForColor(parsedColor),
        matchedChannelCode: provenanceCodeForColor(parsedColor),
      };
    }

    const matchedChannel =
      routingChannel !== null
        ? (allSerialized.find(
            (c) => c.channelCode === routingChannel.provenanceChannelCode,
          ) ?? null)
        : colorLookup?.matchedChannelCode
          ? (allSerialized.find(
              (c) => c.channelCode === colorLookup.matchedChannelCode,
            ) ?? null)
          : writerResolution !== null &&
              PROVENANCE_CHANNEL_CODES.includes(
                writerResolution.provenanceLabel as SignalChannelCode,
              )
            ? (allSerialized.find(
                (c) => c.channelCode === writerResolution.provenanceLabel,
              ) ?? null)
            : null;

    const resolvedOriginDomain =
      bridgeSpec !== null
        ? serializeOriginDomainEntry(
            ORIGIN_DOMAIN_REGISTRY[bridgeSpec.originDomain],
          )
        : routingChannel !== null &&
            routingChannel.permittedOriginDomains.length === 1
          ? (routingChannel.permittedOriginDomains[0] ?? null)
          : routingChannel === null && writerOriginEntry !== null
            ? serializeOriginDomainEntry(writerOriginEntry)
            : null;

    const payload = {
      channels: filteredChannels,
      matchedChannel,
      routingChannel,
      bridgeResolution,
      resolvedOriginDomain,
      writerResolution,
      colorLookup,
      originDomains: Object.values(ORIGIN_DOMAIN_REGISTRY).map(
        serializeOriginDomainEntry,
      ),
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    if (error instanceof NshFrameCodecError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: error.code,
              message: error.message,
            }),
          },
        ],
      };
    }
    const errorCode =
      error instanceof SportsdeskMcpWireError
        ? error.errorCode
        : "invalid_provenance_query";
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCode,
            message,
          }),
        },
      ],
    };
  }
}

const ROUTE_METADATA_SCHEMA = z.object({
  channelId4: z.number().int(),
  slaDivide10Ms8: z.number().int(),
  provenance: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES),
  sourceBridgePrefix: z.string(),
  bridgeQualifiedChannelCode: z.string(),
  originDomainId: z.string(),
  venueId: z.string(),
  originBrandColorHex: z.string(),
});

export const GET_BRIDGE_CHANNEL_CATALOG_INPUT = {
  bridgeId: z
    .enum(TRANSPORT_BRIDGE_ENUM_VALUES)
    .optional()
    .describe("Optional TransportBridgeId filter or route-pair input"),
  channelCode: z
    .enum(EXTENDED_CHANNEL_ENUM_VALUES)
    .optional()
    .describe("Optional ExtendedSignalChannelCode filter or route-pair input"),
  packedRouteWord32: z
    .number()
    .int()
    .min(0)
    .max(0xffffffff)
    .optional()
    .describe("Optional 32-bit unsigned BridgeChannelPackedWord32 to decode"),
  envelope: z
    .object({
      transportBridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
      amountWageredCents: z.number().int(),
      ticketWriterToken: z.string().optional(),
      placedOnToken: z.string().optional(),
      wagerTypeCode: z.string().optional(),
      shortDescriptionPrefix: z.string().optional(),
      ticketLegCount: z.number().int().min(1).max(64).optional(),
      rawBoardRotationNumber: z.number().int().optional(),
      quarantineHoldDurationMs: z.number().int().min(0).optional(),
      distinctClusterWalletCount: z.number().int().min(0).optional(),
      ingestRowFlagsBitSet32: z
        .number()
        .int()
        .min(0)
        .max(0xffffffff)
        .optional(),
    })
    .optional()
    .describe(
      "Optional raw wire ingest envelope to demultiplex into (bridge, channel, packedRouteWord32)",
    ),
};

const GET_BRIDGE_CHANNEL_CATALOG_OUTPUT = {
  bridges: z.array(
    z.object({
      bridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
      bridgeOrdinal4: z.number().int(),
      originDomain: z.string(),
      webSocketSubscriptionTopic: z.string(),
      r2LatestObjectKey: z.string(),
      upstreamWireEndpoint: z.string(),
      deduplicationWatermarkContract: z.string(),
      freshnessSlaDurationMs: z.number().int(),
      permittedChannels: z.array(z.enum(EXTENDED_CHANNEL_ENUM_VALUES)),
    }),
  ),
  channels: z.array(
    z.object({
      channelCode: z.enum(EXTENDED_CHANNEL_ENUM_VALUES),
      channelOrdinal5: z.number().int(),
      kind: z.string(),
      routingDisposition: z.string(),
      treasuryCapitalSilo: z.string(),
      vigSurchargeBasisPoints: z.number().int(),
      executionSlaDurationMs: z.number().int(),
      permittedBridgeBitMask32: z.number().int(),
      channelBehaviorFlagsBitSet32: z.number().int(),
      neuronTokenIdentifier: z.string(),
      permittedBridges: z.array(z.enum(TRANSPORT_BRIDGE_ENUM_VALUES)),
    }),
  ),
  routeCheck: z
    .object({
      bridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
      channelCode: z.enum(EXTENDED_CHANNEL_ENUM_VALUES),
      permitted: z.boolean(),
      packedRouteWord32: z.number().int().nullable(),
      routeMetadata: ROUTE_METADATA_SCHEMA.nullable(),
    })
    .nullable(),
  decodedWord: z
    .object({
      packedRouteWord32: z.number().int(),
      bridgeOrdinal4: z.number().int(),
      channelOrdinal5: z.number().int(),
      channelBehaviorFlagsBitSet5: z.number().int(),
      routeMetadata: ROUTE_METADATA_SCHEMA,
    })
    .nullable(),
  demuxedEnvelope: z
    .object({
      bridgeId: z.enum(TRANSPORT_BRIDGE_ENUM_VALUES),
      channelCode: z.enum(EXTENDED_CHANNEL_ENUM_VALUES),
      packedRouteWord32: z.number().int(),
      canonicalVolumeCents: z.number().int(),
      effectiveWagerTypeCode: z.string(),
      routeMetadata: ROUTE_METADATA_SCHEMA,
    })
    .nullable(),
};

type GetBridgeChannelCatalogInput = z.infer<
  z.ZodObject<typeof GET_BRIDGE_CHANNEL_CATALOG_INPUT>
>;

function serializeRouteMetadata(word32: BridgeChannelPackedWord32) {
  const resolved = resolveRouteWordChannelAndSla(word32);
  return {
    channelId4: resolved.channelId4,
    slaDivide10Ms8: resolved.slaDivide10Ms8,
    provenance: resolved.provenance,
    sourceBridgePrefix: resolved.sourceBridgePrefix,
    bridgeQualifiedChannelCode: resolved.bridgeQualifiedChannelCode,
    originDomainId: resolved.originDomainId,
    venueId: resolved.venueId,
    originBrandColorHex: resolved.originBrandColorHex,
  };
}

export function runGetBridgeChannelCatalogTool(
  input: GetBridgeChannelCatalogInput,
): CallToolResult {
  try {
    const selectedBridges =
      input.bridgeId !== undefined
        ? ORDERED_BRIDGES.filter((b) => b.bridgeId === input.bridgeId)
        : ORDERED_BRIDGES;

    const selectedChannels =
      input.channelCode !== undefined
        ? ORDERED_CHANNELS.filter((c) => c.channelCode === input.channelCode)
        : ORDERED_CHANNELS;

    const bridges = selectedBridges.map((bridge) => ({
      bridgeId: bridge.bridgeId,
      bridgeOrdinal4: bridge.bridgeOrdinal4,
      originDomain: bridge.originDomain,
      webSocketSubscriptionTopic: bridge.webSocketSubscriptionTopic,
      r2LatestObjectKey: bridge.r2LatestObjectKey,
      upstreamWireEndpoint: bridge.upstreamWireEndpoint,
      deduplicationWatermarkContract: bridge.deduplicationWatermarkContract,
      freshnessSlaDurationMs: bridge.freshnessSlaDurationMs as number,
      permittedChannels: ORDERED_CHANNELS.filter((ch) =>
        isTransportBridgePermittedForChannel(bridge.bridgeId, ch.channelCode),
      ).map((ch) => ch.channelCode),
    }));

    const channels = selectedChannels.map((channel) => ({
      channelCode: channel.channelCode,
      channelOrdinal5: channel.channelOrdinal5,
      kind: channel.kind,
      routingDisposition: channel.routingDisposition,
      treasuryCapitalSilo: channel.treasuryCapitalSilo,
      vigSurchargeBasisPoints: channel.vigSurchargeBasisPoints as number,
      executionSlaDurationMs: channel.executionSlaDurationMs as number,
      permittedBridgeBitMask32: channel.permittedBridgeBitMask32 as number,
      channelBehaviorFlagsBitSet32:
        channel.channelBehaviorFlagsBitSet32 as number,
      neuronTokenIdentifier: channel.neuronTokenIdentifier,
      permittedBridges: ORDERED_BRIDGES.filter((br) =>
        isTransportBridgePermittedForChannel(br.bridgeId, channel.channelCode),
      ).map((br) => br.bridgeId),
    }));

    let routeCheck: z.infer<
      typeof GET_BRIDGE_CHANNEL_CATALOG_OUTPUT.routeCheck
    > = null;
    if (input.bridgeId !== undefined && input.channelCode !== undefined) {
      const permitted = isTransportBridgePermittedForChannel(
        input.bridgeId,
        input.channelCode,
      );
      if (permitted) {
        const word = encodeBridgeChannelPackedWord32(
          input.bridgeId,
          input.channelCode,
        );
        routeCheck = {
          bridgeId: input.bridgeId,
          channelCode: input.channelCode,
          permitted: true,
          packedRouteWord32: word as number,
          routeMetadata: serializeRouteMetadata(word),
        };
      } else {
        routeCheck = {
          bridgeId: input.bridgeId,
          channelCode: input.channelCode,
          permitted: false,
          packedRouteWord32: null,
          routeMetadata: null,
        };
      }
    }

    let decodedWord: z.infer<
      typeof GET_BRIDGE_CHANNEL_CATALOG_OUTPUT.decodedWord
    > = null;
    if (input.packedRouteWord32 !== undefined) {
      if (
        !Number.isInteger(input.packedRouteWord32) ||
        input.packedRouteWord32 < 0 ||
        input.packedRouteWord32 > 0xffffffff
      ) {
        throw new NshFrameCodecError(
          "invalid_channel_id",
          `packedRouteWord32 must be an unsigned 32-bit integer (got ${String(input.packedRouteWord32)})`,
        );
      }
      const brandedWord = (input.packedRouteWord32 >>>
        0) as BridgeChannelPackedWord32;
      if (brandedWord === NULL_BRIDGE_CHANNEL_WORD32) {
        throw new NshFrameCodecError(
          "invalid_channel_id",
          "cannot decode NULL_BRIDGE_CHANNEL_WORD32 (0xFFFFFFFF)",
        );
      }
      const unpacked = decodeBridgeChannelPackedWord32(brandedWord);
      const routeMetadata = serializeRouteMetadata(brandedWord);
      const resolvedBridgeSpec = ORDERED_BRIDGES[unpacked.bridgeOrdinal4];
      const resolvedChannelSpec = ORDERED_CHANNELS[unpacked.channelOrdinal5];
      if (!resolvedBridgeSpec || !resolvedChannelSpec) {
        throw new NshFrameCodecError(
          "invalid_channel_id",
          `packedRouteWord32 0x${brandedWord.toString(16)} references out-of-range ordinals`,
        );
      }
      const canonicalWord = encodeBridgeChannelPackedWord32(
        resolvedBridgeSpec.bridgeId,
        resolvedChannelSpec.channelCode,
      );
      if (canonicalWord !== brandedWord) {
        throw new NshFrameCodecError(
          "invalid_channel_id",
          `packedRouteWord32 0x${brandedWord.toString(16)} has non-canonical behavior flags (expected 0x${canonicalWord.toString(16)})`,
        );
      }
      decodedWord = {
        packedRouteWord32: brandedWord as number,
        bridgeOrdinal4: unpacked.bridgeOrdinal4,
        channelOrdinal5: unpacked.channelOrdinal5,
        channelBehaviorFlagsBitSet5: unpacked.channelBehaviorFlagsBitSet5,
        routeMetadata,
      };
    }

    let demuxedEnvelope: z.infer<
      typeof GET_BRIDGE_CHANNEL_CATALOG_OUTPUT.demuxedEnvelope
    > = null;
    if (input.envelope !== undefined) {
      const wireEnvelope: RawWireIngestEnvelope = {
        transportBridgeId: input.envelope.transportBridgeId,
        amountWageredCents: asCents(input.envelope.amountWageredCents),
        ...(input.envelope.ticketWriterToken !== undefined
          ? { ticketWriterToken: input.envelope.ticketWriterToken }
          : {}),
        ...(input.envelope.placedOnToken !== undefined
          ? { placedOnToken: input.envelope.placedOnToken }
          : {}),
        ...(input.envelope.wagerTypeCode !== undefined
          ? { wagerTypeCode: input.envelope.wagerTypeCode }
          : {}),
        ...(input.envelope.shortDescriptionPrefix !== undefined
          ? { shortDescriptionPrefix: input.envelope.shortDescriptionPrefix }
          : {}),
        ...(input.envelope.ticketLegCount !== undefined
          ? { ticketLegCount: input.envelope.ticketLegCount }
          : {}),
        ...(input.envelope.rawBoardRotationNumber !== undefined
          ? { rawBoardRotationNumber: input.envelope.rawBoardRotationNumber }
          : {}),
        ...(input.envelope.quarantineHoldDurationMs !== undefined
          ? {
              quarantineHoldDurationMs: asDurationMilliseconds(
                input.envelope.quarantineHoldDurationMs,
              ),
            }
          : {}),
        ...(input.envelope.distinctClusterWalletCount !== undefined
          ? {
              distinctClusterWalletCount:
                input.envelope.distinctClusterWalletCount,
            }
          : {}),
        ...(input.envelope.ingestRowFlagsBitSet32 !== undefined
          ? {
              ingestRowFlagsBitSet32: asBitSet32(
                input.envelope.ingestRowFlagsBitSet32,
              ),
            }
          : {}),
      };
      const resolved = resolveSeparatedBridgeAndChannelEnvelope(wireEnvelope);
      demuxedEnvelope = {
        bridgeId: resolved.bridgeSpecification.bridgeId,
        channelCode: resolved.channelSpecification.channelCode,
        packedRouteWord32: resolved.packedRouteWord32 as number,
        canonicalVolumeCents: resolved.canonicalVolumeCents as number,
        effectiveWagerTypeCode: resolved.effectiveWagerTypeCode,
        routeMetadata: serializeRouteMetadata(resolved.packedRouteWord32),
      };
    }

    const payload = {
      bridges,
      channels,
      routeCheck,
      decodedWord,
      demuxedEnvelope,
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    if (error instanceof DodGateFailureError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: `GATE_0${error.gate}_${error.section}`,
              gate: error.gate,
              section: error.section,
              message: error.message,
            }),
          },
        ],
      };
    }
    if (error instanceof NshFrameCodecError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: error.code,
              message: error.message,
            }),
          },
        ],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCode: "bridge_catalog_error",
            message,
          }),
        },
      ],
    };
  }
}

export const CHECK_SOR_SLIPPAGE_INPUT = {
  league: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe(
      "Sport league key (for example NBA, NFL, CFB, EPL, NHL; defaults to DEFAULT)",
    ),
  slippageBps: z
    .number()
    .finite()
    .optional()
    .describe(
      "Observed or proposed execution slippage in basis points (100 bps = 1%). Optional when asks + budgetUsd are provided.",
    ),
  softLimitBps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      "Optional soft-limit warning threshold in basis points (defaults to 25 bps)",
    ),
  maxSlippageBpsOverride: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe("Optional explicit policy ceiling in basis points"),
  enforceSor1Ceiling: z
    .boolean()
    .optional()
    .describe(
      "Enforce the 200 bps SOR-1 ceiling alongside the sport-tier and global policy cap (default: true)",
    ),
  budgetUsd: z
    .number()
    .min(0)
    .max(1_000_000)
    .optional()
    .describe(
      "Order notional in USD used to walk the ask ladder when asks are supplied",
    ),
  midPrice: z
    .number()
    .gt(0)
    .lt(1)
    .optional()
    .describe(
      "Optional mid probability in (0, 1) for relative slippage; defaults to best ask when walking asks",
    ),
  asks: z
    .array(
      z.object({
        price: z.number().gt(0).lt(1),
        size: z.number().positive().max(1_000_000_000_000),
      }),
    )
    .max(512)
    .optional()
    .describe(
      "Optional venue ask levels (probability price in (0,1), contract size in (0, 1e12])",
    ),
};

const CHECK_SOR_SLIPPAGE_OUTPUT = {
  allowed: z.boolean(),
  status: z.enum(["PASS", "WARN", "REJECT"]),
  blockReason: z.string().nullable(),
  warningReason: z.string().nullable(),
  league: z.string(),
  observedSlippageBps: z.number().int().nullable(),
  rawPriceImpactBps: z.number().int().nullable(),
  softLimitBps: z.number().int(),
  softLimitExceeded: z.boolean(),
  tierMaxSlippageBps: z.number().int(),
  policyMaxSlippageBps: z.number().int(),
  effectiveMaxSlippageBps: z.number().int(),
  sor1CeilingBps: z.number().int(),
  nshFrameU8MaxBps: z.number().int(),
  sor1Compliant: z.boolean(),
  fitsNshFrameU8: z.boolean(),
  tier: z.object({
    minEdgeBps: z.number().int(),
    maxSlippageBps: z.number().int(),
    maxOrderUsd: z.number(),
  }),
  availableSportTiers: z.record(
    z.string(),
    z.object({
      minEdgeBps: z.number().int(),
      maxSlippageBps: z.number().int(),
      maxOrderUsd: z.number(),
    }),
  ),
  bookWalk: z
    .object({
      budgetUsd: z.number(),
      contracts: z.number(),
      costUsd: z.number(),
      avgPrice: z.number().nullable(),
      bestPrice: z.number().nullable(),
      lastPrice: z.number().nullable(),
      depthContracts: z.number(),
      referencePrice: z.number().nullable(),
      fullyCovered: z.boolean(),
    })
    .nullable(),
};

type CheckSorSlippageInput = z.infer<
  z.ZodObject<typeof CHECK_SOR_SLIPPAGE_INPUT>
>;

function quantizeSlippageBpsFailClosed(rawBps: number): number {
  if (Number.isNaN(rawBps)) {
    throw new SportsdeskMcpWireError(
      "invalid_slippage_policy",
      "Slippage basis points must not be NaN",
    );
  }
  if (rawBps === Number.NEGATIVE_INFINITY) {
    return Number.MIN_SAFE_INTEGER;
  }
  if (rawBps === Number.POSITIVE_INFINITY) {
    return Number.MAX_SAFE_INTEGER;
  }
  if (rawBps < 0) {
    return Math.max(Number.MIN_SAFE_INTEGER, Math.floor(rawBps));
  }
  if (rawBps === 0) {
    return 0;
  }
  const ceiled = Math.ceil(rawBps - 1e-9);
  if (ceiled <= 0) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, ceiled);
}

function slippagePolicyValidationError(message: string): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          errorCode: "invalid_slippage_policy",
          message,
        }),
      },
    ],
  };
}

export function runCheckSorSlippageTool(
  input: CheckSorSlippageInput,
  policyEnv: Readonly<Record<string, string | undefined>> = Bun.env,
): CallToolResult {
  if (
    input.softLimitBps !== undefined &&
    (!Number.isSafeInteger(input.softLimitBps) ||
      input.softLimitBps < 0 ||
      input.softLimitBps > 10_000)
  ) {
    return slippagePolicyValidationError(
      `softLimitBps must be an integer in [0, 10000], got ${String(input.softLimitBps)}`,
    );
  }
  if (
    input.maxSlippageBpsOverride !== undefined &&
    (!Number.isSafeInteger(input.maxSlippageBpsOverride) ||
      input.maxSlippageBpsOverride < 0 ||
      input.maxSlippageBpsOverride > 10_000)
  ) {
    return slippagePolicyValidationError(
      `maxSlippageBpsOverride must be an integer in [0, 10000], got ${String(input.maxSlippageBpsOverride)}`,
    );
  }
  if (input.slippageBps !== undefined && !Number.isFinite(input.slippageBps)) {
    return slippagePolicyValidationError(
      `slippageBps must be a finite number, got ${String(input.slippageBps)}`,
    );
  }
  if (
    input.budgetUsd !== undefined &&
    (!Number.isFinite(input.budgetUsd) ||
      input.budgetUsd < 0 ||
      input.budgetUsd > 1_000_000)
  ) {
    return slippagePolicyValidationError(
      `budgetUsd must be a finite number in [0, 1000000], got ${String(input.budgetUsd)}`,
    );
  }
  if (
    input.midPrice !== undefined &&
    (!Number.isFinite(input.midPrice) ||
      input.midPrice <= 0 ||
      input.midPrice >= 1)
  ) {
    return slippagePolicyValidationError(
      `midPrice must be a finite probability in (0, 1), got ${String(input.midPrice)}`,
    );
  }
  if (input.asks !== undefined) {
    if (!Array.isArray(input.asks) || input.asks.length > 512) {
      return slippagePolicyValidationError(
        "asks must be an array of at most 512 levels",
      );
    }
    for (let i = 0; i < input.asks.length; i++) {
      const level = input.asks[i];
      if (
        !level ||
        !Number.isFinite(level.price) ||
        level.price <= 0 ||
        level.price >= 1 ||
        !Number.isFinite(level.size) ||
        level.size <= 0 ||
        level.size > 1_000_000_000_000
      ) {
        return slippagePolicyValidationError(
          `asks[${i}] must have finite price in (0, 1) and size in (0, 1e12]`,
        );
      }
    }
  }

  const league = (input.league ?? "DEFAULT").trim().toUpperCase() || "DEFAULT";
  const policy = policyFromEnv(policyEnv);
  const tier = tierForPolicy(policy, league);
  const enforceSor1 = input.enforceSor1Ceiling ?? true;
  const softLimitBps = input.softLimitBps ?? SOR_DEFAULT_SOFT_LIMIT_BPS;
  const policyMaxSlippageBps = policy.maxSlippageBps;
  const tierMaxSlippageBps =
    input.maxSlippageBpsOverride ?? tier.maxSlippageBps;
  const policyBoundedMaxBps =
    input.maxSlippageBpsOverride ??
    Math.min(tier.maxSlippageBps, policyMaxSlippageBps);
  const effectiveMaxSlippageBps = enforceSor1
    ? Math.min(policyBoundedMaxBps, SOR1_MAX_SLIPPAGE_BPS)
    : policyBoundedMaxBps;

  let observedSlippageBps: number | null =
    input.slippageBps !== undefined
      ? quantizeSlippageBpsFailClosed(input.slippageBps)
      : null;
  let rawPriceImpactBps: number | null = null;
  let bookWalkSummary: z.infer<typeof CHECK_SOR_SLIPPAGE_OUTPUT.bookWalk> =
    null;
  let walkBlockReason: string | null = null;

  if (input.asks !== undefined) {
    observedSlippageBps = null;
    const budgetUsd =
      input.budgetUsd ?? Math.min(tier.maxOrderUsd, policy.maxOrderUsd);
    const sortedAsks = [...input.asks].sort((a, b) => a.price - b.price);
    if (budgetUsd <= 0) {
      walkBlockReason = "zero_budget";
      const emptyWalk = walkBook(sortedAsks, 0);
      bookWalkSummary = {
        budgetUsd,
        contracts: emptyWalk.contracts,
        costUsd: emptyWalk.costUsd,
        avgPrice: emptyWalk.avgPrice,
        bestPrice: emptyWalk.bestPrice,
        lastPrice: emptyWalk.lastPrice,
        depthContracts: emptyWalk.depthContracts,
        referencePrice: input.midPrice ?? emptyWalk.bestPrice,
        fullyCovered: false,
      };
    } else if (sortedAsks.length === 0) {
      walkBlockReason = "no_book";
      bookWalkSummary = {
        budgetUsd,
        contracts: 0,
        costUsd: 0,
        avgPrice: null,
        bestPrice: null,
        lastPrice: null,
        depthContracts: 0,
        referencePrice: input.midPrice ?? null,
        fullyCovered: false,
      };
    } else {
      const walk = walkBook(sortedAsks, budgetUsd);
      const referencePrice = input.midPrice ?? walk.bestPrice;
      const fullyCovered = walk.costUsd + 1e-6 >= budgetUsd;
      if (!fullyCovered) {
        walkBlockReason = "insufficient_depth";
      }
      if (
        walk.avgPrice !== null &&
        referencePrice !== null &&
        referencePrice > 0
      ) {
        observedSlippageBps = quantizeSlippageBpsFailClosed(
          (Math.abs(walk.avgPrice - referencePrice) / referencePrice) * 10_000,
        );
        rawPriceImpactBps = quantizeSlippageBpsFailClosed(
          Math.max(0, walk.avgPrice - referencePrice) * 10_000,
        );
      }
      bookWalkSummary = {
        budgetUsd,
        contracts: walk.contracts,
        costUsd: walk.costUsd,
        avgPrice: walk.avgPrice,
        bestPrice: walk.bestPrice,
        lastPrice: walk.lastPrice,
        depthContracts: walk.depthContracts,
        referencePrice,
        fullyCovered,
      };
    }
  } else if (observedSlippageBps === null) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCode: "missing_slippage_input",
            message:
              "Provide either slippageBps or asks (with optional budgetUsd) to evaluate SOR-1 slippage.",
          }),
        },
      ],
    };
  }

  let blockReason: string | null = walkBlockReason;
  if (blockReason === null && observedSlippageBps !== null) {
    if (observedSlippageBps < 0) {
      blockReason = "negative_slippage_invalid";
    } else if (observedSlippageBps > NSH_FRAME_SLIPPAGE_U8_MAX) {
      blockReason = "exceeds_nsh_frame_u8";
    } else if (
      enforceSor1 &&
      observedSlippageBps > SOR1_MAX_SLIPPAGE_BPS &&
      policyBoundedMaxBps >= SOR1_MAX_SLIPPAGE_BPS &&
      tierMaxSlippageBps > SOR1_MAX_SLIPPAGE_BPS
    ) {
      blockReason = "exceeds_sor1_ceiling";
    } else if (observedSlippageBps > effectiveMaxSlippageBps) {
      blockReason = "slippage_exceeds_policy";
    }
  }

  const fitsNshFrameU8 =
    observedSlippageBps !== null &&
    Number.isInteger(observedSlippageBps) &&
    observedSlippageBps >= 0 &&
    observedSlippageBps <= NSH_FRAME_SLIPPAGE_U8_MAX;
  const sor1Compliant =
    observedSlippageBps !== null &&
    observedSlippageBps >= 0 &&
    observedSlippageBps <= SOR1_MAX_SLIPPAGE_BPS;
  const allowed = blockReason === null && observedSlippageBps !== null;
  const softLimitExceeded =
    observedSlippageBps !== null && observedSlippageBps > softLimitBps;
  const status: "PASS" | "WARN" | "REJECT" = !allowed
    ? "REJECT"
    : softLimitExceeded
      ? "WARN"
      : "PASS";
  const warningReason =
    allowed && softLimitExceeded ? "exceeds_soft_limit" : null;

  const payload = {
    allowed,
    status,
    blockReason,
    warningReason,
    league,
    observedSlippageBps,
    rawPriceImpactBps,
    softLimitBps,
    softLimitExceeded,
    tierMaxSlippageBps,
    policyMaxSlippageBps,
    effectiveMaxSlippageBps,
    sor1CeilingBps: SOR1_MAX_SLIPPAGE_BPS,
    nshFrameU8MaxBps: NSH_FRAME_SLIPPAGE_U8_MAX,
    sor1Compliant,
    fitsNshFrameU8,
    tier: {
      minEdgeBps: tier.minEdgeBps,
      maxSlippageBps: tier.maxSlippageBps,
      maxOrderUsd: tier.maxOrderUsd,
    },
    availableSportTiers: Object.fromEntries(
      Object.entries(DEFAULT_SPORT_TIERS).map(([key, value]) => {
        const resolved = policy.sportTiers[key] ?? value;
        return [
          key,
          {
            minEdgeBps: resolved.minEdgeBps,
            maxSlippageBps: resolved.maxSlippageBps,
            maxOrderUsd: resolved.maxOrderUsd,
          },
        ];
      }),
    ),
    bookWalk: bookWalkSummary,
  };

  return {
    structuredContent: payload,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

export const DECODE_NSH_FRAME_INPUT = {
  payload: z
    .string()
    .min(1)
    .max(1024)
    .describe(
      "64-byte NSH binary frame encoded as hex (optional 0x prefix) or base64",
    ),
  encoding: z
    .enum(["hex", "base64"])
    .optional()
    .describe("Wire encoding of payload (auto-detected when omitted)"),
};

const DECODE_NSH_FRAME_OUTPUT = {
  byteLength: z.number().int(),
  magicByte8: z.number().int(),
  versionByte8: z.number().int(),
  messageType: z.number().int(),
  messageTypeName: z.string(),
  packedHandle32: z.number().int(),
  handle: z.object({
    channelId4: z.number().int(),
    slaDivide10Ms8: z.number().int(),
    slaMs: z.number().int(),
    rowIndex20: z.number().int(),
  }),
  channelCode: z.enum(EXTENDED_CHANNEL_ENUM_VALUES),
  provenanceChannelCode: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES),
  channelColorHexInt: z.number().int().min(0).max(0xffffff),
  channelColorCss: z.string(),
  channelNeuronToken: z.string(),
  betGroupId: z.string(),
  betGroupTag: z.string(),
  stakeUsdc: z.number(),
  bookOdds: z.number(),
  polyAvgPrice: z.number(),
  liabilityDelta: z.number(),
  timestampMs: z.number().int(),
  timestampIso: z.string().nullable(),
  originDomainWireId: z.number().int(),
  originDomainId: z.string(),
  venueId: z.string(),
  originBrandColorHex: z.string(),
  originDomain: ORIGIN_DOMAIN_ITEM_SCHEMA,
  writerLaneWireId: z.number().int(),
  writerChannelId: z.string(),
  writerLaneId: z.string().nullable(),
  writerBrandColorHex: z.string().nullable(),
  writerLane: WRITER_LANE_ITEM_SCHEMA.nullable(),
  writerSentinel: SENTINEL_CHANNEL_ITEM_SCHEMA.nullable(),
  flagsBitSet16: z.number().int(),
  slippageBps: z.number().int(),
  sor1Compliant: z.boolean(),
  layoutOffsets: z.record(
    z.string(),
    z.object({ offset: z.number().int(), size: z.number().int() }),
  ),
};

type DecodeNshFrameInput = z.infer<z.ZodObject<typeof DECODE_NSH_FRAME_INPUT>>;

function decodeWirePayloadToBytes(
  rawPayload: string,
  encoding: "hex" | "base64" | undefined,
): Uint8Array {
  const trimmed = rawPayload.trim();
  if (trimmed === "") {
    throw new NshFrameCodecError("short_frame", "empty frame payload");
  }

  const compactNoWs = trimmed.replace(/\s+/g, "");
  const resolvedEncoding: "hex" | "base64" =
    encoding ??
    (/^0x/i.test(trimmed) ||
    (/^[0-9a-fA-F]+$/.test(compactNoWs) &&
      compactNoWs.length !== 88 &&
      compactNoWs.length !== 86)
      ? "hex"
      : "base64");

  if (resolvedEncoding === "hex") {
    const compact = compactNoWs.replace(/^0x/i, "");
    if (compact.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(compact)) {
      throw new SportsdeskMcpWireError(
        "invalid_encoding",
        "Invalid hex frame payload: expected an even number of hexadecimal digits",
      );
    }
    const bytes = new Uint8Array(compact.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  const normalizedB64 = compactNoWs.replace(/-/g, "+").replace(/_/g, "/");
  if (
    normalizedB64.length % 4 === 1 ||
    (normalizedB64.includes("=") && normalizedB64.length % 4 !== 0) ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedB64)
  ) {
    throw new SportsdeskMcpWireError(
      "invalid_encoding",
      "Invalid base64 frame payload: malformed base64 character sequence",
    );
  }
  return new Uint8Array(Buffer.from(normalizedB64, "base64"));
}

export function runDecodeNshFrameTool(
  input: DecodeNshFrameInput,
): CallToolResult {
  try {
    const bytes = decodeWirePayloadToBytes(input.payload, input.encoding);
    if (bytes.byteLength > NSH_FRAME_BYTE_LENGTH) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: "oversized_frame",
              message: `NSH frame must be exactly ${NSH_FRAME_BYTE_LENGTH} bytes (got ${bytes.byteLength})`,
            }),
          },
        ],
      };
    }

    const frame = readNshBinaryFrame(bytes);
    const packedHandle32 = packChannelHandle32(
      frame.channelId,
      frame.slaDivide10Ms,
      frame.rowIndex,
    );
    const unpackedHandle = unpackChannelHandle32(packedHandle32);
    const channelSpec = ORDERED_CHANNELS[unpackedHandle.channelId4];
    if (!channelSpec) {
      throw new NshFrameCodecError(
        "invalid_channel_id",
        `Unknown channelId4=${unpackedHandle.channelId4} in NSH frame handle`,
      );
    }
    const provenanceChannelCode = provenanceForChannelOrdinal(
      unpackedHandle.channelId4,
    );
    const channelColorHexInt = provenanceColorFor(
      provenanceChannelCode,
    ) as number;
    const channelColorCss = provenanceCssFor(provenanceChannelCode);
    const originEntry = ORIGIN_DOMAIN_REGISTRY[frame.originDomainId];
    const writerEntry = writerLaneEntryForChannel(frame.writerLaneId);
    const sentinelEntry = sentinelChannelEntryFor(frame.writerLaneId);
    const betGroupDecimal = frame.betGroupId.toString(10);
    const timestampIso =
      frame.timestampMs <= MAX_ECMA_DATE_TIMESTAMP_MS
        ? new Date(frame.timestampMs).toISOString()
        : null;

    const payload = {
      byteLength: bytes.byteLength,
      magicByte8: NSH_FRAME_MAGIC,
      versionByte8: NSH_FRAME_VERSION,
      messageType: frame.messageType,
      messageTypeName:
        MESSAGE_TYPE_NAMES[frame.messageType] ?? `UNKNOWN_${frame.messageType}`,
      packedHandle32: packedHandle32 as number,
      handle: {
        channelId4: unpackedHandle.channelId4,
        slaDivide10Ms8: unpackedHandle.slaDivide10Ms8,
        slaMs: unpackedHandle.slaDivide10Ms8 * 10,
        rowIndex20: unpackedHandle.rowIndex20,
      },
      channelCode: channelSpec.channelCode,
      provenanceChannelCode,
      channelColorHexInt,
      channelColorCss,
      channelNeuronToken: channelSpec.neuronTokenIdentifier,
      betGroupId: betGroupDecimal,
      betGroupTag: `M.G${betGroupDecimal}`,
      stakeUsdc: frame.stakeUsdc,
      bookOdds: frame.bookOdds,
      polyAvgPrice: frame.polyAvgPrice,
      liabilityDelta: frame.liabilityDelta,
      timestampMs: frame.timestampMs,
      timestampIso,
      originDomainWireId: frame.originDomainWireId,
      originDomainId: frame.originDomainId,
      venueId: originEntry.venueId,
      originBrandColorHex: originEntry.brandColorHex,
      originDomain: serializeOriginDomainEntry(originEntry),
      writerLaneWireId: frame.writerLaneWireId,
      writerChannelId: frame.writerLaneId,
      writerLaneId: writerEntry?.writerLaneId ?? null,
      writerBrandColorHex:
        writerEntry?.brandColorHex ?? sentinelEntry?.brandColorHex ?? null,
      writerLane:
        writerEntry === null ? null : serializeWriterLaneEntry(writerEntry),
      writerSentinel: sentinelEntry,
      flagsBitSet16: frame.flags,
      slippageBps: frame.slippageBps,
      sor1Compliant: frame.slippageBps <= SOR1_MAX_SLIPPAGE_BPS,
      layoutOffsets: Object.fromEntries(
        Object.entries(NSH_FRAME_LAYOUT).map(([key, spec]) => [
          key,
          { offset: spec.offset, size: spec.size },
        ]),
      ),
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    if (error instanceof NshFrameCodecError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: error.code,
              message: error.message,
            }),
          },
        ],
      };
    }
    if (error instanceof SportsdeskMcpWireError) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              errorCode: error.errorCode,
              message: error.message,
            }),
          },
        ],
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: false,
            errorCode: "invalid_encoding",
            message,
          }),
        },
      ],
    };
  }
}

// ============================================================================
// 1B. TRADING TERMINAL READ-ONLY SNAPSHOT TOOLS
// ============================================================================

const DATA_BASIS_ENUM_VALUES = [
  "live",
  "capture",
  "fixture",
  "caller_snapshot",
  "none",
] as const;

const POLYMARKET_ASK_LEVEL_SCHEMA = z.object({
  price: z.number().gt(0).lt(1),
  size: z.number().positive().max(1_000_000_000_000),
});

function roundCurrencyUsd(value: number): number {
  return Math.round(value * 100) / 100;
}

function roundBasisPointsRatioPct(bps: number): number {
  return Math.round(bps) / 100;
}

function validateAskLevelsOrThrow(
  asks: ReadonlyArray<{ readonly price: number; readonly size: number }>,
  errorCode: string,
  contextLabel: string,
): void {
  if (asks.length > 512) {
    throw new SportsdeskMcpWireError(
      errorCode,
      `${contextLabel} must have at most 512 levels`,
    );
  }
  for (let i = 0; i < asks.length; i++) {
    const level = asks[i];
    if (
      !level ||
      !Number.isFinite(level.price) ||
      level.price <= 0 ||
      level.price >= 1 ||
      !Number.isFinite(level.size) ||
      level.size <= 0 ||
      level.size > 1_000_000_000_000
    ) {
      throw new SportsdeskMcpWireError(
        errorCode,
        `${contextLabel}[${i}] must have finite price in (0, 1) and size in (0, 1e12]`,
      );
    }
  }
}

function sumAskLiquidityUsd(
  asks: ReadonlyArray<{ readonly price: number; readonly size: number }>,
): number {
  let totalUsd = 0;
  for (let i = 0; i < asks.length; i++) {
    const level = asks[i]!;
    totalUsd += level.price * level.size;
  }
  return roundCurrencyUsd(totalUsd);
}

function mcpToolErrorResult(
  error: unknown,
  fallbackCode: string,
): CallToolResult {
  const errorCode =
    error instanceof SportsdeskMcpWireError
      ? error.errorCode
      : error instanceof NshFrameCodecError
        ? error.code
        : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          errorCode,
          message,
        }),
      },
    ],
  };
}

export const GET_TRADING_DESK_KPIS_AND_SPORT_TREE_INPUT = {
  sportFilter: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      "Optional top-level sport category filter (e.g. Basketball, Football)",
    ),
  leagueFilter: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Optional league code filter (e.g. NBA, NFL, EPL)"),
  liveOnly: z
    .boolean()
    .optional()
    .describe("When true, restrict Sport View tree counts to live games"),
  dataBasis: z
    .enum(DATA_BASIS_ENUM_VALUES)
    .optional()
    .describe(
      "Explicit Signal Honesty provenance basis for caller-supplied inputs",
    ),
  kpisSnapshot: z
    .object({
      wageredCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
      settledNetCents: z
        .number()
        .int()
        .min(-1_000_000_000_000)
        .max(1_000_000_000_000)
        .optional(),
      toWinCents: z.number().int().min(0).max(1_000_000_000_000).optional(),
      activeBetsCount: z.number().int().min(0).max(10_000_000).optional(),
      theoreticalHoldBasisPoints: z
        .number()
        .int()
        .min(-10_000)
        .max(10_000)
        .optional(),
      polymarketAvailableLiquidityUsd: z
        .number()
        .min(0)
        .max(1_000_000_000)
        .optional(),
      polymarketAsks: z.array(POLYMARKET_ASK_LEVEL_SCHEMA).max(512).optional(),
    })
    .optional()
    .describe(
      "Optional top-bar KPI inputs; omitted metrics stay null rather than fabricating zeroes",
    ),
  games: z
    .array(
      z.object({
        gameId: z.string().min(1).max(128),
        sport: z.string().min(1).max(64).optional(),
        league: z.string().min(1).max(64),
        status: z.enum(["live", "scheduled", "final"]),
        activeBetsCount: z.number().int().min(0).max(1_000_000).optional(),
        handleUsd: z.number().min(0).max(1_000_000_000).optional(),
      }),
    )
    .max(2_000)
    .optional()
    .describe(
      "Optional scoreboard/board games used to build the hierarchical Sport View tree",
    ),
};

const SPORT_TREE_LEAGUE_NODE_SCHEMA = z.object({
  league: z.string(),
  totalGames: z.number().int(),
  liveCount: z.number().int(),
  scheduledCount: z.number().int(),
  finalCount: z.number().int(),
  activeBetsCount: z.number().int(),
  handleUsd: z.number(),
});

const SPORT_TREE_SPORT_NODE_SCHEMA = z.object({
  sport: z.string(),
  totalGames: z.number().int(),
  liveCount: z.number().int(),
  scheduledCount: z.number().int(),
  finalCount: z.number().int(),
  activeBetsCount: z.number().int(),
  handleUsd: z.number(),
  leagues: z.array(SPORT_TREE_LEAGUE_NODE_SCHEMA),
});

const GET_TRADING_DESK_KPIS_AND_SPORT_TREE_OUTPUT = {
  readOnlySnapshot: z.literal(true),
  mutationActionsAvailable: z.literal(false),
  dataBasis: z.enum(DATA_BASIS_ENUM_VALUES),
  kpis: z.object({
    marginBasisPoints: z.number().int().nullable(),
    marginPct: z.number().nullable(),
    ggrCents: z.number().int().nullable(),
    ggrUsd: z.number().nullable(),
    heldPct: z.number().nullable(),
    activeBetsCount: z.number().int().nullable(),
    wageredUsd: z.number().nullable(),
    toWinUsd: z.number().nullable(),
    polymarketAvailableLiquidityUsd: z.number().nullable(),
  }),
  sportTreeSummary: z.object({
    totalGames: z.number().int(),
    liveGames: z.number().int(),
    scheduledGames: z.number().int(),
    finalGames: z.number().int(),
    activeBetsCount: z.number().int(),
    totalHandleUsd: z.number(),
  }),
  sportTree: z.array(SPORT_TREE_SPORT_NODE_SCHEMA),
  supportedCategories: z.array(z.string()),
};

type GetTradingDeskKpisAndSportTreeInput = z.infer<
  z.ZodObject<typeof GET_TRADING_DESK_KPIS_AND_SPORT_TREE_INPUT>
>;

export function runGetTradingDeskKpisAndSportTreeTool(
  input: GetTradingDeskKpisAndSportTreeInput,
): CallToolResult {
  try {
    const hasCallerData =
      input.kpisSnapshot !== undefined || input.games !== undefined;
    const effectiveBasis =
      input.dataBasis ?? (hasCallerData ? "caller_snapshot" : "none");

    const kpiIn = input.kpisSnapshot;
    if (kpiIn?.polymarketAsks !== undefined) {
      validateAskLevelsOrThrow(
        kpiIn.polymarketAsks,
        "invalid_kpi_snapshot",
        "kpisSnapshot.polymarketAsks",
      );
    }
    if (
      kpiIn?.wageredCents !== undefined &&
      (!Number.isSafeInteger(kpiIn.wageredCents) || kpiIn.wageredCents < 0)
    ) {
      throw new SportsdeskMcpWireError(
        "invalid_kpi_snapshot",
        `wageredCents must be a non-negative safe integer, got ${String(kpiIn.wageredCents)}`,
      );
    }
    if (
      kpiIn?.settledNetCents !== undefined &&
      !Number.isSafeInteger(kpiIn.settledNetCents)
    ) {
      throw new SportsdeskMcpWireError(
        "invalid_kpi_snapshot",
        `settledNetCents must be a safe integer, got ${String(kpiIn.settledNetCents)}`,
      );
    }

    const sportFilterNorm = input.sportFilter?.trim().toLowerCase() ?? "";
    const leagueFilterNorm = input.leagueFilter?.trim().toLowerCase() ?? "";
    const liveOnly = input.liveOnly === true;

    interface MutableLeagueBucket {
      league: string;
      totalGames: number;
      liveCount: number;
      scheduledCount: number;
      finalCount: number;
      activeBetsCount: number;
      handleUsd: number;
    }

    interface MutableSportBucket {
      sport: string;
      totalGames: number;
      liveCount: number;
      scheduledCount: number;
      finalCount: number;
      activeBetsCount: number;
      handleUsd: number;
      leagues: MutableLeagueBucket[];
    }

    const sportBuckets: MutableSportBucket[] = [];
    let summaryTotalGames = 0;
    let summaryLiveGames = 0;
    let summaryScheduledGames = 0;
    let summaryFinalGames = 0;
    let summaryActiveBets = 0;
    let summaryHandleUsd = 0;
    let anyGameDeclaredActiveBets = false;

    const rawGames = input.games ?? [];
    for (let i = 0; i < rawGames.length; i++) {
      const game = rawGames[i]!;
      if (
        game.handleUsd !== undefined &&
        (!Number.isFinite(game.handleUsd) || game.handleUsd < 0)
      ) {
        throw new SportsdeskMcpWireError(
          "invalid_kpi_snapshot",
          `games[${i}].handleUsd must be a finite non-negative number`,
        );
      }
      if (
        game.activeBetsCount !== undefined &&
        (!Number.isSafeInteger(game.activeBetsCount) ||
          game.activeBetsCount < 0)
      ) {
        throw new SportsdeskMcpWireError(
          "invalid_kpi_snapshot",
          `games[${i}].activeBetsCount must be a non-negative integer`,
        );
      }

      const resolvedSport = sportCategoryFor({
        sport: game.sport,
        sportSubType: game.league,
      });
      const leagueClean = game.league.trim().toUpperCase() || "OTHER";

      if (
        sportFilterNorm !== "" &&
        resolvedSport.toLowerCase() !== sportFilterNorm
      ) {
        continue;
      }
      if (
        leagueFilterNorm !== "" &&
        leagueClean.toLowerCase() !== leagueFilterNorm
      ) {
        continue;
      }
      if (liveOnly && game.status !== "live") {
        continue;
      }

      if (game.activeBetsCount !== undefined) {
        anyGameDeclaredActiveBets = true;
      }
      const gameBets = game.activeBetsCount ?? 0;
      const gameHandle = game.handleUsd ?? 0;

      summaryTotalGames += 1;
      if (game.status === "live") summaryLiveGames += 1;
      else if (game.status === "scheduled") summaryScheduledGames += 1;
      else summaryFinalGames += 1;
      summaryActiveBets += gameBets;
      summaryHandleUsd += gameHandle;

      let sportBucket = sportBuckets.find((b) => b.sport === resolvedSport);
      if (!sportBucket) {
        sportBucket = {
          sport: resolvedSport,
          totalGames: 0,
          liveCount: 0,
          scheduledCount: 0,
          finalCount: 0,
          activeBetsCount: 0,
          handleUsd: 0,
          leagues: [],
        };
        sportBuckets.push(sportBucket);
      }
      sportBucket.totalGames += 1;
      if (game.status === "live") sportBucket.liveCount += 1;
      else if (game.status === "scheduled") sportBucket.scheduledCount += 1;
      else sportBucket.finalCount += 1;
      sportBucket.activeBetsCount += gameBets;
      sportBucket.handleUsd = roundCurrencyUsd(
        sportBucket.handleUsd + gameHandle,
      );

      let leagueBucket = sportBucket.leagues.find(
        (l) => l.league === leagueClean,
      );
      if (!leagueBucket) {
        leagueBucket = {
          league: leagueClean,
          totalGames: 0,
          liveCount: 0,
          scheduledCount: 0,
          finalCount: 0,
          activeBetsCount: 0,
          handleUsd: 0,
        };
        sportBucket.leagues.push(leagueBucket);
      }
      leagueBucket.totalGames += 1;
      if (game.status === "live") leagueBucket.liveCount += 1;
      else if (game.status === "scheduled") leagueBucket.scheduledCount += 1;
      else leagueBucket.finalCount += 1;
      leagueBucket.activeBetsCount += gameBets;
      leagueBucket.handleUsd = roundCurrencyUsd(
        leagueBucket.handleUsd + gameHandle,
      );
    }

    for (let i = 0; i < sportBuckets.length; i++) {
      sportBuckets[i]!.leagues.sort(
        (a, b) =>
          b.liveCount - a.liveCount ||
          b.activeBetsCount - a.activeBetsCount ||
          a.league.localeCompare(b.league),
      );
    }
    sportBuckets.sort(
      (a, b) =>
        b.liveCount - a.liveCount ||
        b.activeBetsCount - a.activeBetsCount ||
        a.sport.localeCompare(b.sport),
    );

    const wageredCents = kpiIn?.wageredCents ?? null;
    const settledNetCents = kpiIn?.settledNetCents ?? null;
    const toWinCents = kpiIn?.toWinCents ?? null;

    const heldBasisPoints =
      wageredCents !== null && wageredCents > 0 && settledNetCents !== null
        ? Math.round((settledNetCents / wageredCents) * 10_000)
        : null;
    const marginBasisPoints =
      kpiIn?.theoreticalHoldBasisPoints ?? heldBasisPoints;
    const marginPct =
      marginBasisPoints !== null
        ? roundBasisPointsRatioPct(marginBasisPoints)
        : null;
    const heldPct =
      heldBasisPoints !== null
        ? roundBasisPointsRatioPct(heldBasisPoints)
        : null;
    const ggrCents = settledNetCents;
    const ggrUsd = ggrCents !== null ? roundCurrencyUsd(ggrCents / 100) : null;
    const wageredUsd =
      wageredCents !== null ? roundCurrencyUsd(wageredCents / 100) : null;
    const toWinUsd =
      toWinCents !== null ? roundCurrencyUsd(toWinCents / 100) : null;
    const activeBetsCount =
      kpiIn?.activeBetsCount !== undefined
        ? kpiIn.activeBetsCount
        : anyGameDeclaredActiveBets
          ? summaryActiveBets
          : null;
    const polymarketAvailableLiquidityUsd =
      kpiIn?.polymarketAvailableLiquidityUsd !== undefined
        ? roundCurrencyUsd(kpiIn.polymarketAvailableLiquidityUsd)
        : kpiIn?.polymarketAsks !== undefined
          ? sumAskLiquidityUsd(kpiIn.polymarketAsks)
          : null;

    const payload = {
      readOnlySnapshot: true as const,
      mutationActionsAvailable: false as const,
      dataBasis: effectiveBasis,
      kpis: {
        marginBasisPoints,
        marginPct,
        ggrCents,
        ggrUsd,
        heldPct,
        activeBetsCount,
        wageredUsd,
        toWinUsd,
        polymarketAvailableLiquidityUsd,
      },
      sportTreeSummary: {
        totalGames: summaryTotalGames,
        liveGames: summaryLiveGames,
        scheduledGames: summaryScheduledGames,
        finalGames: summaryFinalGames,
        activeBetsCount: summaryActiveBets,
        totalHandleUsd: roundCurrencyUsd(summaryHandleUsd),
      },
      sportTree: sportBuckets,
      supportedCategories: [...SPORT_CATEGORIES],
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    return mcpToolErrorResult(error, "invalid_kpi_snapshot");
  }
}

export const GET_LIVE_LINE_TRADING_BOARD_INPUT = {
  leagueFilter: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Optional league filter (e.g. NBA, NFL, EPL)"),
  statusFilter: z
    .enum(["all", "live", "scheduled", "final"])
    .optional()
    .describe("Optional match status filter (default: all)"),
  selectedGameNum: z
    .number()
    .int()
    .min(0)
    .max(1_048_575)
    .optional()
    .describe(
      "Optional 20-bit rotation/game number to focus in the Line-Trading Dashboard",
    ),
  dataBasis: z
    .enum(DATA_BASIS_ENUM_VALUES)
    .optional()
    .describe("Explicit Signal Honesty provenance basis"),
  matches: z
    .array(
      z.object({
        gameNum: z.number().int().min(0).max(1_048_575),
        sport: z.string().min(1).max(64).optional(),
        league: z.string().min(1).max(64),
        status: z.enum(["live", "scheduled", "final"]),
        clock: z.string().min(1).max(64),
        teams: z.tuple([z.string().min(1).max(80), z.string().min(1).max(80)]),
        score: z.tuple([
          z.number().int().min(0).max(999),
          z.number().int().min(0).max(999),
        ]),
        moneyline: z
          .object({
            team1DecimalOdds: z.number().gt(1).max(1_000).nullable(),
            drawDecimalOdds: z.number().gt(1).max(1_000).nullable().optional(),
            team2DecimalOdds: z.number().gt(1).max(1_000).nullable(),
            openerTeam1DecimalOdds: z
              .number()
              .gt(1)
              .max(1_000)
              .nullable()
              .optional(),
            openerTeam2DecimalOdds: z
              .number()
              .gt(1)
              .max(1_000)
              .nullable()
              .optional(),
          })
          .optional(),
        spread: z
          .object({
            lineHundredths: z.number().int().min(-10_000).max(10_000),
            openerLineHundredths: z
              .number()
              .int()
              .min(-10_000)
              .max(10_000)
              .nullable()
              .optional(),
            polymarketLineHundredths: z
              .number()
              .int()
              .min(-10_000)
              .max(10_000)
              .nullable()
              .optional(),
            team1AmericanPrice: z
              .number()
              .int()
              .min(-10_000)
              .max(10_000)
              .nullable(),
            team2AmericanPrice: z
              .number()
              .int()
              .min(-10_000)
              .max(10_000)
              .nullable(),
            team1HandleUsd: z
              .number()
              .min(0)
              .max(1_000_000_000)
              .nullable()
              .optional(),
            team2HandleUsd: z
              .number()
              .min(0)
              .max(1_000_000_000)
              .nullable()
              .optional(),
          })
          .optional(),
        total: z
          .object({
            lineHundredths: z.number().int().min(0).max(50_000),
            openerLineHundredths: z
              .number()
              .int()
              .min(0)
              .max(50_000)
              .nullable()
              .optional(),
            polymarketLineHundredths: z
              .number()
              .int()
              .min(0)
              .max(50_000)
              .nullable()
              .optional(),
            overAmericanPrice: z
              .number()
              .int()
              .min(-10_000)
              .max(10_000)
              .nullable(),
            underAmericanPrice: z
              .number()
              .int()
              .min(-10_000)
              .max(10_000)
              .nullable(),
            overHandleUsd: z
              .number()
              .min(0)
              .max(1_000_000_000)
              .nullable()
              .optional(),
            underHandleUsd: z
              .number()
              .min(0)
              .max(1_000_000_000)
              .nullable()
              .optional(),
          })
          .optional(),
        pointSeries: z
          .array(
            z.object({
              tickLabel: z.string().min(1).max(32),
              team1Score: z.number().int().min(0).max(999),
              team2Score: z.number().int().min(0).max(999),
            }),
          )
          .max(256)
          .optional(),
        historicOddsSeries: z
          .array(
            z.object({
              tickLabel: z.string().min(1).max(32),
              bookImpliedProb: z.number().gt(0).lt(1),
              polymarketMidProb: z.number().gt(0).lt(1).nullable(),
            }),
          )
          .max(256)
          .optional(),
      }),
    )
    .max(500)
    .optional()
    .describe(
      "Live/scheduled board matches for Line-Trading Dashboard and Live Trading cards",
    ),
};

const EVALUATED_MATCH_BOARD_ITEM_SCHEMA = z.object({
  gameNum: z.number().int(),
  sport: z.string(),
  league: z.string(),
  status: z.enum(["live", "scheduled", "final"]),
  clock: z.string(),
  team1: z.string(),
  team2: z.string(),
  score: z.tuple([z.number().int(), z.number().int()]),
  moneyline: z
    .object({
      team1DecimalOdds: z.number().nullable(),
      drawDecimalOdds: z.number().nullable(),
      team2DecimalOdds: z.number().nullable(),
      team1DeltaMilliOdds: z.number().int().nullable(),
      team2DeltaMilliOdds: z.number().int().nullable(),
    })
    .nullable(),
  spread: z
    .object({
      lineHundredths: z.number().int(),
      openerLineHundredths: z.number().int().nullable(),
      polymarketLineHundredths: z.number().int().nullable(),
      openerDeltaHundredths: z.number().int().nullable(),
      polymarketDeltaHundredths: z.number().int().nullable(),
      keyNumberCrossed: z.number().nullable(),
      betterVenue: z.enum(["polymarket", "internal", "equal"]),
      layoffRiskAlert: z.string().nullable(),
      team1AmericanPrice: z.number().int().nullable(),
      team2AmericanPrice: z.number().int().nullable(),
      team1HandleSharePct: z.number().nullable(),
      team2HandleSharePct: z.number().nullable(),
    })
    .nullable(),
  total: z
    .object({
      lineHundredths: z.number().int(),
      openerLineHundredths: z.number().int().nullable(),
      polymarketLineHundredths: z.number().int().nullable(),
      openerDeltaHundredths: z.number().int().nullable(),
      polymarketDeltaHundredths: z.number().int().nullable(),
      betterVenueOver: z.enum(["polymarket", "internal", "equal"]),
      overAmericanPrice: z.number().int().nullable(),
      underAmericanPrice: z.number().int().nullable(),
      overHandleSharePct: z.number().nullable(),
      underHandleSharePct: z.number().nullable(),
    })
    .nullable(),
  pointSeries: z.array(
    z.object({
      tickLabel: z.string(),
      team1Score: z.number().int(),
      team2Score: z.number().int(),
    }),
  ),
  historicOddsSeries: z.array(
    z.object({
      tickLabel: z.string(),
      bookImpliedProb: z.number(),
      polymarketMidProb: z.number().nullable(),
    }),
  ),
});

const GET_LIVE_LINE_TRADING_BOARD_OUTPUT = {
  readOnlySnapshot: z.literal(true),
  mutationActionsAvailable: z.literal(false),
  dataBasis: z.enum(DATA_BASIS_ENUM_VALUES),
  summary: z.object({
    totalMatches: z.number().int(),
    liveMatches: z.number().int(),
    layoffRiskAlertsCount: z.number().int(),
  }),
  selectedMatch: EVALUATED_MATCH_BOARD_ITEM_SCHEMA.nullable(),
  liveCards: z.array(EVALUATED_MATCH_BOARD_ITEM_SCHEMA),
};

type GetLiveLineTradingBoardInput = z.infer<
  z.ZodObject<typeof GET_LIVE_LINE_TRADING_BOARD_INPUT>
>;

export function runGetLiveLineTradingBoardTool(
  input: GetLiveLineTradingBoardInput,
): CallToolResult {
  try {
    const effectiveBasis =
      input.dataBasis ??
      (input.matches !== undefined ? "caller_snapshot" : "none");
    const leagueFilterNorm = input.leagueFilter?.trim().toLowerCase() ?? "";
    const statusFilter = input.statusFilter ?? "all";
    const callerMatches = input.matches ?? [];
    const rawMatches: Array<(typeof callerMatches)[number]> = [];
    const indexByGameNum: Record<number, number> = Object.create(null);
    for (let i = 0; i < callerMatches.length; i++) {
      const candidate = callerMatches[i]!;
      if (
        !Number.isSafeInteger(candidate.gameNum) ||
        candidate.gameNum < 0 ||
        candidate.gameNum > 1_048_575
      ) {
        throw new SportsdeskMcpWireError(
          "invalid_board_input",
          `matches[${i}].gameNum must fit 20-bit rotation range [0, 1048575]`,
        );
      }
      const existingIdx = indexByGameNum[candidate.gameNum];
      if (existingIdx === undefined) {
        indexByGameNum[candidate.gameNum] = rawMatches.length;
        rawMatches.push(candidate);
      } else {
        const prev = rawMatches[existingIdx]!;
        rawMatches[existingIdx] = {
          ...prev,
          status:
            prev.status === "live" || candidate.status !== "live"
              ? prev.status
              : candidate.status,
          clock: prev.clock !== "-" ? prev.clock : candidate.clock,
          moneyline: prev.moneyline ?? candidate.moneyline,
          spread: prev.spread ?? candidate.spread,
          total: prev.total ?? candidate.total,
          pointSeries:
            (prev.pointSeries?.length ?? 0) > 0
              ? prev.pointSeries
              : candidate.pointSeries,
          historicOddsSeries:
            (prev.historicOddsSeries?.length ?? 0) > 0
              ? prev.historicOddsSeries
              : candidate.historicOddsSeries,
        };
      }
    }

    const evaluatedCards: Array<
      z.infer<typeof EVALUATED_MATCH_BOARD_ITEM_SCHEMA>
    > = [];
    let liveMatches = 0;
    let layoffRiskAlertsCount = 0;

    for (let i = 0; i < rawMatches.length; i++) {
      const m = rawMatches[i]!;
      const leagueClean = m.league.trim().toUpperCase();
      if (
        leagueFilterNorm !== "" &&
        leagueClean.toLowerCase() !== leagueFilterNorm
      ) {
        continue;
      }
      if (statusFilter !== "all" && m.status !== statusFilter) {
        continue;
      }
      if (m.status === "live") {
        liveMatches += 1;
      }

      const resolvedSport = sportCategoryFor({
        sport: m.sport,
        sportSubType: leagueClean,
      });

      let moneylineOut: z.infer<
        typeof EVALUATED_MATCH_BOARD_ITEM_SCHEMA
      >["moneyline"] = null;
      if (m.moneyline) {
        const t1 = m.moneyline.team1DecimalOdds;
        const t2 = m.moneyline.team2DecimalOdds;
        const op1 = m.moneyline.openerTeam1DecimalOdds ?? null;
        const op2 = m.moneyline.openerTeam2DecimalOdds ?? null;
        if (
          (t1 !== null && (!Number.isFinite(t1) || t1 <= 1)) ||
          (t2 !== null && (!Number.isFinite(t2) || t2 <= 1))
        ) {
          throw new SportsdeskMcpWireError(
            "invalid_board_input",
            `matches[${i}].moneyline decimal odds must exceed 1.0`,
          );
        }
        moneylineOut = {
          team1DecimalOdds: t1,
          drawDecimalOdds: m.moneyline.drawDecimalOdds ?? null,
          team2DecimalOdds: t2,
          team1DeltaMilliOdds:
            t1 !== null && op1 !== null ? Math.round((t1 - op1) * 1000) : null,
          team2DeltaMilliOdds:
            t2 !== null && op2 !== null ? Math.round((t2 - op2) * 1000) : null,
        };
      }

      let spreadOut: z.infer<
        typeof EVALUATED_MATCH_BOARD_ITEM_SCHEMA
      >["spread"] = null;
      if (m.spread) {
        const lineH = m.spread.lineHundredths;
        const openerH = m.spread.openerLineHundredths ?? null;
        const polyH = m.spread.polymarketLineHundredths ?? null;
        const betterVenue = evaluateBetterVenue(
          "spread",
          m.teams[0],
          polyH,
          lineH,
        );
        const keyCross =
          polyH !== null
            ? detectKeyNumberCrossing(polyH, lineH, leagueClean)
            : openerH !== null
              ? detectKeyNumberCrossing(openerH, lineH, leagueClean)
              : null;
        let layoffAlert: string | null = null;
        if (betterVenue === "polymarket" && polyH !== null) {
          layoffRiskAlertsCount += 1;
          const keySuffix =
            keyCross !== null ? ` (crosses key ${keyCross})` : "";
          layoffAlert = `SHARP_STILL_BETTER: Polymarket ${polyH / 100} beats book ${lineH / 100}${keySuffix}`;
        }
        const h1 = m.spread.team1HandleUsd ?? null;
        const h2 = m.spread.team2HandleUsd ?? null;
        const totalHandle =
          h1 !== null && h2 !== null && h1 + h2 > 0 ? h1 + h2 : null;
        spreadOut = {
          lineHundredths: lineH,
          openerLineHundredths: openerH,
          polymarketLineHundredths: polyH,
          openerDeltaHundredths: openerH !== null ? lineH - openerH : null,
          polymarketDeltaHundredths:
            polyH !== null ? Math.abs(lineH - polyH) : null,
          keyNumberCrossed: keyCross,
          betterVenue,
          layoffRiskAlert: layoffAlert,
          team1AmericanPrice: m.spread.team1AmericanPrice,
          team2AmericanPrice: m.spread.team2AmericanPrice,
          team1HandleSharePct:
            totalHandle !== null && h1 !== null
              ? roundCurrencyUsd((h1 / totalHandle) * 100)
              : null,
          team2HandleSharePct:
            totalHandle !== null && h2 !== null
              ? roundCurrencyUsd((h2 / totalHandle) * 100)
              : null,
        };
      }

      let totalOut: z.infer<typeof EVALUATED_MATCH_BOARD_ITEM_SCHEMA>["total"] =
        null;
      if (m.total) {
        const lineH = m.total.lineHundredths;
        const openerH = m.total.openerLineHundredths ?? null;
        const polyH = m.total.polymarketLineHundredths ?? null;
        const betterVenueOver = evaluateBetterVenue(
          "total",
          "OVER",
          polyH,
          lineH,
        );
        const overH = m.total.overHandleUsd ?? null;
        const underH = m.total.underHandleUsd ?? null;
        const sumH =
          overH !== null && underH !== null && overH + underH > 0
            ? overH + underH
            : null;
        totalOut = {
          lineHundredths: lineH,
          openerLineHundredths: openerH,
          polymarketLineHundredths: polyH,
          openerDeltaHundredths: openerH !== null ? lineH - openerH : null,
          polymarketDeltaHundredths:
            polyH !== null ? Math.abs(lineH - polyH) : null,
          betterVenueOver,
          overAmericanPrice: m.total.overAmericanPrice,
          underAmericanPrice: m.total.underAmericanPrice,
          overHandleSharePct:
            sumH !== null && overH !== null
              ? roundCurrencyUsd((overH / sumH) * 100)
              : null,
          underHandleSharePct:
            sumH !== null && underH !== null
              ? roundCurrencyUsd((underH / sumH) * 100)
              : null,
        };
      }

      const pointSeries = m.pointSeries ?? [];
      const historicOddsSeries = m.historicOddsSeries ?? [];
      for (let j = 0; j < historicOddsSeries.length; j++) {
        const pt = historicOddsSeries[j]!;
        if (
          !Number.isFinite(pt.bookImpliedProb) ||
          pt.bookImpliedProb <= 0 ||
          pt.bookImpliedProb >= 1 ||
          (pt.polymarketMidProb !== null &&
            (!Number.isFinite(pt.polymarketMidProb) ||
              pt.polymarketMidProb <= 0 ||
              pt.polymarketMidProb >= 1))
        ) {
          throw new SportsdeskMcpWireError(
            "invalid_board_input",
            `matches[${i}].historicOddsSeries[${j}] probabilities must lie in (0, 1)`,
          );
        }
      }

      evaluatedCards.push({
        gameNum: m.gameNum,
        sport: resolvedSport,
        league: leagueClean,
        status: m.status,
        clock: m.clock,
        team1: m.teams[0],
        team2: m.teams[1],
        score: m.score,
        moneyline: moneylineOut,
        spread: spreadOut,
        total: totalOut,
        pointSeries,
        historicOddsSeries,
      });
    }

    const selectedMatch =
      input.selectedGameNum !== undefined
        ? (evaluatedCards.find((c) => c.gameNum === input.selectedGameNum) ??
          null)
        : (evaluatedCards.find((c) => c.status === "live") ??
          evaluatedCards[0] ??
          null);

    const payload = {
      readOnlySnapshot: true as const,
      mutationActionsAvailable: false as const,
      dataBasis: effectiveBasis,
      summary: {
        totalMatches: evaluatedCards.length,
        liveMatches,
        layoffRiskAlertsCount,
      },
      selectedMatch,
      liveCards: evaluatedCards,
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    return mcpToolErrorResult(error, "invalid_board_input");
  }
}

const BLOTTER_RISK_STATUS_VALUES = ["accepted", "auto", "flagged"] as const;
const BLOTTER_HEDGE_STATUS_VALUES = [
  "hedged",
  "hedge_pending",
  "unhedged",
  "not_applicable",
] as const;

export const GET_ACTIVE_BET_BLOTTER_INPUT = {
  statusFilter: z
    .enum(["all", "accepted", "auto", "flagged", "hedged", "hedge_pending"])
    .optional()
    .describe("Filter Active Bet Logs by risk/hedge status tab"),
  channelFilter: z
    .enum(PROVENANCE_CHANNEL_ENUM_VALUES)
    .optional()
    .describe(
      "Filter blotter rows by canonical 7-entry ingestion provenance channel",
    ),
  sportFilter: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Optional top-level sport category filter"),
  unhedgedOnly: z
    .boolean()
    .optional()
    .describe(
      "Mirrors 'Show Unhedged Only' toggle: retains rows with unhedged liability > 0",
    ),
  searchQuery: z
    .string()
    .max(120)
    .optional()
    .describe(
      "Case-insensitive search across ticketKey, customerHandle, marketLabel, sport, and league",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe("Maximum blotter rows returned (default: 100)"),
  dataBasis: z
    .enum(DATA_BASIS_ENUM_VALUES)
    .optional()
    .describe("Explicit Signal Honesty provenance basis"),
  tickets: z
    .array(
      z.object({
        ticketKey: z.string().min(1).max(64),
        timestampIso: z.string().min(1).max(64),
        customerHandle: z.string().min(1).max(64),
        sport: z.string().min(1).max(64).optional(),
        league: z.string().min(1).max(64),
        marketLabel: z.string().min(1).max(160),
        writer: z.string().min(1).max(64),
        bookDecimalOdds: z.number().gt(1).max(1_000).nullable().optional(),
        polymarketMidProb: z.number().gt(0).lt(1).nullable().optional(),
        stakeCents: z.number().int().min(0).max(1_000_000_000),
        liabilityCents: z.number().int().min(0).max(1_000_000_000).optional(),
        hedgedCents: z.number().int().min(0).max(1_000_000_000).optional(),
        riskStatus: z.enum(BLOTTER_RISK_STATUS_VALUES).optional(),
        hedgeStatus: z.enum(BLOTTER_HEDGE_STATUS_VALUES).optional(),
      }),
    )
    .max(1_000)
    .optional()
    .describe(
      "Active bet-ticker / pending rows to normalize with RGB provenance and noise exclusion",
    ),
  otcQuoteSnapshots: z
    .array(
      z.object({
        quoteId: z.string().min(1).max(64),
        observedAtIso: z.string().min(1).max(64),
        customerHandle: z.string().min(1).max(64),
        league: z.string().min(1).max(64),
        matchup: z.string().min(1).max(120),
        selectionLabel: z.string().min(1).max(120),
        requestedStakeCents: z.number().int().min(0).max(1_000_000_000),
        requestedDecimalOdds: z.number().gt(1).max(1_000),
        bookDecimalOdds: z.number().gt(1).max(1_000),
        polymarketFairProb: z.number().gt(0).lt(1).nullable().optional(),
      }),
    )
    .max(100)
    .optional()
    .describe(
      "Read-only Telegram OTC quote request snapshots (inspect only; zero approve/decline mutations)",
    ),
};

const BLOTTER_ROW_OUTPUT_SCHEMA = z.object({
  ticketKey: z.string(),
  timestampIso: z.string(),
  customerHandle: z.string(),
  sport: z.string(),
  league: z.string(),
  marketLabel: z.string(),
  rawWriter: z.string(),
  writerLaneId: z.string(),
  venueId: z.string(),
  provenanceChannelCode: z.enum(PROVENANCE_CHANNEL_ENUM_VALUES),
  provenanceColorHexInt: z.number().int().min(0).max(0xffffff),
  provenanceColorCss: z.string(),
  volumeExcludedNoise: z.boolean(),
  bookDecimalOdds: z.number().nullable(),
  impliedBookProb: z.number().nullable(),
  polymarketMidProb: z.number().nullable(),
  edgeBpsVsPolymarket: z.number().int().nullable(),
  stakeCents: z.number().int(),
  liabilityCents: z.number().int(),
  hedgedCents: z.number().int(),
  unhedgedLiabilityCents: z.number().int(),
  riskStatus: z.enum(BLOTTER_RISK_STATUS_VALUES),
  hedgeStatus: z.enum(BLOTTER_HEDGE_STATUS_VALUES),
  hedgeExecutionEnabled: z.literal(false),
});

const OTC_QUOTE_SNAPSHOT_OUTPUT_SCHEMA = z.object({
  quoteId: z.string(),
  observedAtIso: z.string(),
  customerHandle: z.string(),
  league: z.string(),
  matchup: z.string(),
  selectionLabel: z.string(),
  requestedStakeUsd: z.number(),
  requestedDecimalOdds: z.number(),
  bookDecimalOdds: z.number(),
  polymarketFairProb: z.number().nullable(),
  edgeBasisPoints: z.number().int(),
  advisoryStatus: z.enum([
    "edge_favorable",
    "within_band",
    "off_market_wide",
    "unpriced_reference",
  ]),
  approvalActionsEnabled: z.literal(false),
  readOnlyPolicyNote: z.string(),
});

const GET_ACTIVE_BET_BLOTTER_OUTPUT = {
  readOnlySnapshot: z.literal(true),
  mutationActionsAvailable: z.literal(false),
  dataBasis: z.enum(DATA_BASIS_ENUM_VALUES),
  summary: z.object({
    totalRows: z.number().int(),
    returnedRows: z.number().int(),
    excludedNoiseRows: z.number().int(),
    canonicalStakeCents: z.number().int(),
    canonicalStakeUsd: z.number(),
    canonicalLiabilityCents: z.number().int(),
    canonicalLiabilityUsd: z.number(),
    hedgedLiabilityCents: z.number().int(),
    unhedgedLiabilityCents: z.number().int(),
    unhedgedLiabilityUsd: z.number(),
    flaggedRowsCount: z.number().int(),
    hedgePendingRowsCount: z.number().int(),
  }),
  rows: z.array(BLOTTER_ROW_OUTPUT_SCHEMA),
  otcSnapshots: z.array(OTC_QUOTE_SNAPSHOT_OUTPUT_SCHEMA),
};

type GetActiveBetBlotterInput = z.infer<
  z.ZodObject<typeof GET_ACTIVE_BET_BLOTTER_INPUT>
>;

function resolveBlotterProvenanceChannel(rawWriter: string): {
  readonly writerLaneId: string;
  readonly venueId: string;
  readonly provenanceChannelCode: SignalChannelCode;
  readonly volumeExcludedNoise: boolean;
} {
  const tickerWriterClass = writerOf(rawWriter);
  const noiseByTicker = isTickerNoise({ writer: tickerWriterClass });
  // A writer may be a lane OR a sentinel class; asking for a lane would throw
  // for BLOCKED/UNRESOLVED rows and silence the blotter.
  const channel = resolveWriterChannel(rawWriter);
  const laneEntry = writerLaneEntryForChannel(channel);
  const sentinelEntry = sentinelChannelEntryFor(channel);
  const candidateLabel =
    sentinelEntry?.signalChannelCode ?? laneEntry?.signalChannelCode ?? null;
  const provenanceChannelCode: SignalChannelCode =
    candidateLabel !== null && PROVENANCE_CHANNEL_CODES.includes(candidateLabel)
      ? candidateLabel
      : tickerWriterClass === "alert"
        ? "ALERT"
        : tickerWriterClass === "blocked"
          ? "BLOCKED"
          : "Internet";
  const volumeExcludedNoise =
    (sentinelEntry?.isMoneyExcluded ?? false) ||
    noiseByTicker ||
    provenanceChannelCode === "ALERT" ||
    provenanceChannelCode === "BLOCKED";
  return {
    writerLaneId: laneEntry?.writerLaneId ?? channel,
    venueId: laneEntry?.venueId ?? "desk",
    provenanceChannelCode,
    volumeExcludedNoise,
  };
}

export function runGetActiveBetBlotterTool(
  input: GetActiveBetBlotterInput,
): CallToolResult {
  try {
    const hasCallerData =
      input.tickets !== undefined || input.otcQuoteSnapshots !== undefined;
    const effectiveBasis =
      input.dataBasis ?? (hasCallerData ? "caller_snapshot" : "none");
    const statusFilter = input.statusFilter ?? "all";
    const channelFilter = input.channelFilter;
    const sportFilterNorm = input.sportFilter?.trim().toLowerCase() ?? "";
    const unhedgedOnly = input.unhedgedOnly === true;
    const searchNorm = input.searchQuery?.trim().toLowerCase() ?? "";
    const limit = input.limit ?? 100;

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new SportsdeskMcpWireError(
        "invalid_blotter_query",
        `limit must be an integer in [1, 500], got ${String(limit)}`,
      );
    }

    const rawTickets = input.tickets ?? [];
    const normalizedRows: Array<z.infer<typeof BLOTTER_ROW_OUTPUT_SCHEMA>> = [];

    let excludedNoiseRows = 0;
    let canonicalStakeCents = 0;
    let canonicalLiabilityCents = 0;
    let hedgedLiabilityCents = 0;
    let unhedgedLiabilityCents = 0;
    let flaggedRowsCount = 0;
    let hedgePendingRowsCount = 0;

    for (let i = 0; i < rawTickets.length; i++) {
      const t = rawTickets[i]!;
      if (t.writer.trim() === "") {
        throw new SportsdeskMcpWireError(
          "invalid_blotter_query",
          `tickets[${i}].writer must be non-empty`,
        );
      }
      const bookOdds = t.bookDecimalOdds ?? null;
      if (
        bookOdds !== null &&
        (!Number.isFinite(bookOdds) || bookOdds <= 1 || bookOdds > 1_000)
      ) {
        throw new SportsdeskMcpWireError(
          "invalid_blotter_query",
          `tickets[${i}].bookDecimalOdds must be in (1, 1000]`,
        );
      }
      if (!Number.isSafeInteger(t.stakeCents) || t.stakeCents < 0) {
        throw new SportsdeskMcpWireError(
          "invalid_blotter_query",
          `tickets[${i}].stakeCents must be a non-negative integer`,
        );
      }
      const pmMid = t.polymarketMidProb ?? null;
      if (
        pmMid !== null &&
        (!Number.isFinite(pmMid) || pmMid <= 0 || pmMid >= 1)
      ) {
        throw new SportsdeskMcpWireError(
          "invalid_blotter_query",
          `tickets[${i}].polymarketMidProb must lie in (0, 1)`,
        );
      }

      const resolvedProv = resolveBlotterProvenanceChannel(t.writer);
      const resolvedSport = sportCategoryFor({
        sport: t.sport,
        sportSubType: t.league,
      });
      const leagueClean = t.league.trim().toUpperCase();

      const grossLiability =
        t.liabilityCents ??
        (bookOdds !== null
          ? Math.max(0, Math.round(t.stakeCents * (bookOdds - 1)))
          : 0);
      const hedgedCents = Math.min(grossLiability, t.hedgedCents ?? 0);
      const rowUnhedgedCents = resolvedProv.volumeExcludedNoise
        ? 0
        : Math.max(0, grossLiability - hedgedCents);

      const impliedBookProb =
        bookOdds !== null ? Math.round((1 / bookOdds) * 10_000) / 10_000 : null;
      const edgeBpsVsPolymarket =
        pmMid !== null && impliedBookProb !== null
          ? Math.round((pmMid - impliedBookProb) * 10_000)
          : null;

      const inferredRiskStatus: (typeof BLOTTER_RISK_STATUS_VALUES)[number] =
        t.riskStatus ??
        (edgeBpsVsPolymarket !== null && edgeBpsVsPolymarket >= 250
          ? "flagged"
          : t.stakeCents >= 100_000
            ? "accepted"
            : "auto");

      const inferredHedgeStatus: (typeof BLOTTER_HEDGE_STATUS_VALUES)[number] =
        t.hedgeStatus ??
        (resolvedProv.volumeExcludedNoise
          ? "not_applicable"
          : hedgedCents > 0 && rowUnhedgedCents === 0
            ? "hedged"
            : hedgedCents > 0
              ? "hedge_pending"
              : "unhedged");

      if (
        channelFilter !== undefined &&
        resolvedProv.provenanceChannelCode !== channelFilter
      ) {
        continue;
      }
      if (
        sportFilterNorm !== "" &&
        resolvedSport.toLowerCase() !== sportFilterNorm
      ) {
        continue;
      }
      if (unhedgedOnly && rowUnhedgedCents <= 0) {
        continue;
      }
      if (statusFilter !== "all") {
        const matchesRisk = inferredRiskStatus === statusFilter;
        const matchesHedge = inferredHedgeStatus === statusFilter;
        if (!matchesRisk && !matchesHedge) {
          continue;
        }
      }
      if (searchNorm !== "") {
        const haystack =
          `${t.ticketKey} ${t.customerHandle} ${t.marketLabel} ${resolvedSport} ${leagueClean} ${resolvedProv.provenanceChannelCode}`.toLowerCase();
        if (!haystack.includes(searchNorm)) {
          continue;
        }
      }

      if (resolvedProv.volumeExcludedNoise) {
        excludedNoiseRows += 1;
      } else {
        canonicalStakeCents += t.stakeCents;
        canonicalLiabilityCents += grossLiability;
        hedgedLiabilityCents += hedgedCents;
        unhedgedLiabilityCents += rowUnhedgedCents;
      }
      if (inferredRiskStatus === "flagged") {
        flaggedRowsCount += 1;
      }
      if (inferredHedgeStatus === "hedge_pending") {
        hedgePendingRowsCount += 1;
      }

      normalizedRows.push({
        ticketKey: t.ticketKey,
        timestampIso: t.timestampIso,
        customerHandle: t.customerHandle.trim().toUpperCase(),
        sport: resolvedSport,
        league: leagueClean,
        marketLabel: t.marketLabel,
        rawWriter: t.writer,
        writerLaneId: resolvedProv.writerLaneId,
        venueId: resolvedProv.venueId,
        provenanceChannelCode: resolvedProv.provenanceChannelCode,
        provenanceColorHexInt: provenanceColorFor(
          resolvedProv.provenanceChannelCode,
        ) as number,
        provenanceColorCss: provenanceCssFor(
          resolvedProv.provenanceChannelCode,
        ),
        volumeExcludedNoise: resolvedProv.volumeExcludedNoise,
        bookDecimalOdds: bookOdds,
        impliedBookProb,
        polymarketMidProb: pmMid,
        edgeBpsVsPolymarket,
        stakeCents: t.stakeCents,
        liabilityCents: grossLiability,
        hedgedCents,
        unhedgedLiabilityCents: rowUnhedgedCents,
        riskStatus: inferredRiskStatus,
        hedgeStatus: inferredHedgeStatus,
        hedgeExecutionEnabled: false as const,
      });
    }

    const rawOtc = input.otcQuoteSnapshots ?? [];
    const otcSnapshots: Array<
      z.infer<typeof OTC_QUOTE_SNAPSHOT_OUTPUT_SCHEMA>
    > = [];
    for (let i = 0; i < rawOtc.length; i++) {
      const q = rawOtc[i]!;
      const fairProb = q.polymarketFairProb ?? null;
      const reqImplied = 1 / q.requestedDecimalOdds;
      const refImplied = fairProb ?? 1 / q.bookDecimalOdds;
      const edgeBasisPoints = Math.round((refImplied - reqImplied) * 10_000);
      const advisoryStatus: z.infer<
        typeof OTC_QUOTE_SNAPSHOT_OUTPUT_SCHEMA
      >["advisoryStatus"] =
        fairProb === null
          ? "unpriced_reference"
          : edgeBasisPoints >= 100
            ? "edge_favorable"
            : edgeBasisPoints >= -150
              ? "within_band"
              : "off_market_wide";
      otcSnapshots.push({
        quoteId: q.quoteId,
        observedAtIso: q.observedAtIso,
        customerHandle: q.customerHandle.trim().toUpperCase(),
        league: q.league.trim().toUpperCase(),
        matchup: q.matchup,
        selectionLabel: q.selectionLabel,
        requestedStakeUsd: roundCurrencyUsd(q.requestedStakeCents / 100),
        requestedDecimalOdds: q.requestedDecimalOdds,
        bookDecimalOdds: q.bookDecimalOdds,
        polymarketFairProb: fairProb,
        edgeBasisPoints,
        advisoryStatus,
        approvalActionsEnabled: false as const,
        readOnlyPolicyNote:
          "Read-only OTC inspection snapshot; Approve/Decline book mutations are disabled.",
      });
    }

    const returnedRows = normalizedRows.slice(0, limit);
    const payload = {
      readOnlySnapshot: true as const,
      mutationActionsAvailable: false as const,
      dataBasis: effectiveBasis,
      summary: {
        totalRows: normalizedRows.length,
        returnedRows: returnedRows.length,
        excludedNoiseRows,
        canonicalStakeCents,
        canonicalStakeUsd: roundCurrencyUsd(canonicalStakeCents / 100),
        canonicalLiabilityCents,
        canonicalLiabilityUsd: roundCurrencyUsd(canonicalLiabilityCents / 100),
        hedgedLiabilityCents,
        unhedgedLiabilityCents,
        unhedgedLiabilityUsd: roundCurrencyUsd(unhedgedLiabilityCents / 100),
        flaggedRowsCount,
        hedgePendingRowsCount,
      },
      rows: returnedRows,
      otcSnapshots,
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    return mcpToolErrorResult(error, "invalid_blotter_query");
  }
}

export const GET_LIABILITY_AND_POLYMARKET_LIQUIDITY_INPUT = {
  league: z
    .string()
    .min(1)
    .max(32)
    .optional()
    .describe(
      "League identifier selecting SportTier slippage cap (default: NBA)",
    ),
  unhedgedOnly: z
    .boolean()
    .optional()
    .describe(
      "When true, evaluate Polymarket liquidity coverage against unhedged liability only",
    ),
  softLimitBps: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe(
      "Optional soft-limit slippage warning threshold in bps (default: 25)",
    ),
  dataBasis: z
    .enum(DATA_BASIS_ENUM_VALUES)
    .optional()
    .describe("Explicit Signal Honesty provenance basis"),
  exposures: z
    .array(
      z.object({
        marketId: z.string().min(1).max(96),
        outcomeLabel: z.string().min(1).max(120),
        wageredCents: z.number().int().min(0).max(1_000_000_000_000),
        grossLiabilityCents: z.number().int().min(0).max(1_000_000_000_000),
        hedgedLiabilityCents: z
          .number()
          .int()
          .min(0)
          .max(1_000_000_000_000)
          .optional(),
        holdBasisPoints: z
          .number()
          .int()
          .min(-10_000)
          .max(10_000)
          .nullable()
          .optional(),
        midPrice: z.number().gt(0).lt(1).nullable().optional(),
        polymarketAsks: z
          .array(POLYMARKET_ASK_LEVEL_SCHEMA)
          .max(512)
          .optional(),
      }),
    )
    .max(200)
    .optional()
    .describe("Per-outcome book exposures and Polymarket CLOB ask ladders"),
};

const LIABILITY_MATRIX_ROW_SCHEMA = z.object({
  marketId: z.string(),
  outcomeLabel: z.string(),
  totalWageredUsd: z.number(),
  projectedHoldUsd: z.number().nullable(),
  grossLiabilityUsd: z.number(),
  hedgedLiabilityUsd: z.number(),
  netUnhedgedRiskUsd: z.number(),
  evaluatedBookLiabilityUsd: z.number(),
  polymarketAvailableLiquidityUsd: z.number(),
  coverageRatio: z.number().nullable(),
  coveragePct: z.number().nullable(),
  sor1SlippageStatus: z.enum(["PASS", "WARN", "REJECT", "NO_BOOK"]),
  observedSlippageBps: z.number().int().nullable(),
  sor1Compliant: z.boolean(),
  fullyCovered: z.boolean(),
});

const GET_LIABILITY_AND_POLYMARKET_LIQUIDITY_OUTPUT = {
  readOnlySnapshot: z.literal(true),
  hedgeExecutionEnabled: z.literal(false),
  dataBasis: z.enum(DATA_BASIS_ENUM_VALUES),
  league: z.string(),
  unhedgedOnly: z.boolean(),
  effectiveMaxSlippageBps: z.number().int(),
  sor1CeilingBps: z.number().int(),
  totals: z.object({
    totalWageredCents: z.number().int(),
    totalWageredUsd: z.number(),
    projectedHoldCents: z.number().int().nullable(),
    projectedHoldUsd: z.number().nullable(),
    grossLiabilityCents: z.number().int(),
    grossLiabilityUsd: z.number(),
    hedgedLiabilityCents: z.number().int(),
    hedgedLiabilityUsd: z.number(),
    netUnhedgedRiskCents: z.number().int(),
    netUnhedgedRiskUsd: z.number(),
    evaluatedBookLiabilityUsd: z.number(),
    polymarketAvailableLiquidityUsd: z.number(),
    overallCoverageRatio: z.number().nullable(),
    overallCoveragePct: z.number().nullable(),
  }),
  rows: z.array(LIABILITY_MATRIX_ROW_SCHEMA),
};

type GetLiabilityAndPolymarketLiquidityInput = z.infer<
  z.ZodObject<typeof GET_LIABILITY_AND_POLYMARKET_LIQUIDITY_INPUT>
>;

export function runGetLiabilityAndPolymarketLiquidityTool(
  input: GetLiabilityAndPolymarketLiquidityInput,
  policyEnv: Readonly<Record<string, string | undefined>> = Bun.env,
): CallToolResult {
  try {
    const effectiveBasis =
      input.dataBasis ??
      (input.exposures !== undefined ? "caller_snapshot" : "none");
    const league = (input.league ?? "NBA").trim().toUpperCase() || "NBA";
    const unhedgedOnly = input.unhedgedOnly === true;
    const softLimitBps = input.softLimitBps ?? SOR_DEFAULT_SOFT_LIMIT_BPS;
    if (
      !Number.isSafeInteger(softLimitBps) ||
      softLimitBps < 0 ||
      softLimitBps > 10_000
    ) {
      throw new SportsdeskMcpWireError(
        "invalid_liability_input",
        `softLimitBps must be an integer in [0, 10000], got ${String(softLimitBps)}`,
      );
    }

    const policy = policyFromEnv(policyEnv);
    const tier = tierForPolicy(policy, league);
    const effectiveMaxSlippageBps = Math.min(
      tier.maxSlippageBps,
      policy.maxSlippageBps,
      SOR1_MAX_SLIPPAGE_BPS,
    );

    const rawExposures = input.exposures ?? [];
    const rows: Array<z.infer<typeof LIABILITY_MATRIX_ROW_SCHEMA>> = [];

    let totalWageredCents = 0;
    let projectedHoldCentsAcc = 0;
    let anyHoldDeclared = false;
    let grossLiabilityCentsAcc = 0;
    let hedgedLiabilityCentsAcc = 0;
    let netUnhedgedRiskCentsAcc = 0;
    let evaluatedBookLiabilityUsdAcc = 0;
    let polymarketLiquidityUsdAcc = 0;

    for (let i = 0; i < rawExposures.length; i++) {
      const exp = rawExposures[i]!;
      if (
        !Number.isSafeInteger(exp.wageredCents) ||
        exp.wageredCents < 0 ||
        !Number.isSafeInteger(exp.grossLiabilityCents) ||
        exp.grossLiabilityCents < 0
      ) {
        throw new SportsdeskMcpWireError(
          "invalid_liability_input",
          `exposures[${i}] wageredCents and grossLiabilityCents must be non-negative safe integers`,
        );
      }
      const hedgedCents = Math.min(
        exp.grossLiabilityCents,
        exp.hedgedLiabilityCents ?? 0,
      );
      if (!Number.isSafeInteger(hedgedCents) || hedgedCents < 0) {
        throw new SportsdeskMcpWireError(
          "invalid_liability_input",
          `exposures[${i}].hedgedLiabilityCents must be a non-negative integer`,
        );
      }
      const midPrice = exp.midPrice ?? null;
      if (
        midPrice !== null &&
        (!Number.isFinite(midPrice) || midPrice <= 0 || midPrice >= 1)
      ) {
        throw new SportsdeskMcpWireError(
          "invalid_liability_input",
          `exposures[${i}].midPrice must lie in (0, 1)`,
        );
      }
      const asks = exp.polymarketAsks ?? [];
      validateAskLevelsOrThrow(
        asks,
        "invalid_liability_input",
        `exposures[${i}].polymarketAsks`,
      );

      const unhedgedCents = Math.max(0, exp.grossLiabilityCents - hedgedCents);
      if (unhedgedOnly && unhedgedCents === 0) {
        continue;
      }

      const evaluatedCents = unhedgedOnly
        ? unhedgedCents
        : exp.grossLiabilityCents;
      const evaluatedUsd = roundCurrencyUsd(evaluatedCents / 100);
      const availLiqUsd = sumAskLiquidityUsd(asks);

      const holdBps = exp.holdBasisPoints ?? null;
      const rowHoldCents =
        holdBps !== null
          ? Math.round((exp.wageredCents * holdBps) / 10_000)
          : null;
      if (rowHoldCents !== null) {
        anyHoldDeclared = true;
        projectedHoldCentsAcc += rowHoldCents;
      }

      totalWageredCents += exp.wageredCents;
      grossLiabilityCentsAcc += exp.grossLiabilityCents;
      hedgedLiabilityCentsAcc += hedgedCents;
      netUnhedgedRiskCentsAcc += unhedgedCents;
      evaluatedBookLiabilityUsdAcc = roundCurrencyUsd(
        evaluatedBookLiabilityUsdAcc + evaluatedUsd,
      );
      polymarketLiquidityUsdAcc = roundCurrencyUsd(
        polymarketLiquidityUsdAcc + availLiqUsd,
      );

      const coverageRatio =
        evaluatedUsd > 0
          ? Math.round(Math.min(10, availLiqUsd / evaluatedUsd) * 10_000) /
            10_000
          : availLiqUsd > 0
            ? 1
            : null;
      const coveragePct =
        coverageRatio !== null
          ? roundCurrencyUsd(Math.min(1, coverageRatio) * 100)
          : null;

      let sor1SlippageStatus: "PASS" | "WARN" | "REJECT" | "NO_BOOK" =
        "NO_BOOK";
      let observedSlippageBps: number | null = null;
      let sor1Compliant = false;
      let fullyCovered = evaluatedUsd === 0;

      if (asks.length > 0 && evaluatedUsd > 0) {
        const sortedAsks = [...asks].sort((a, b) => a.price - b.price);
        const walk = walkBook(sortedAsks, evaluatedUsd);
        const refPrice = midPrice ?? walk.bestPrice;
        fullyCovered = walk.costUsd + 1e-6 >= evaluatedUsd;
        if (walk.avgPrice !== null && refPrice !== null && refPrice > 0) {
          observedSlippageBps = quantizeSlippageBpsFailClosed(
            (Math.abs(walk.avgPrice - refPrice) / refPrice) * 10_000,
          );
        }
        sor1Compliant =
          fullyCovered &&
          observedSlippageBps !== null &&
          observedSlippageBps >= 0 &&
          observedSlippageBps <= SOR1_MAX_SLIPPAGE_BPS;
        const withinEffectiveCap =
          fullyCovered &&
          observedSlippageBps !== null &&
          observedSlippageBps >= 0 &&
          observedSlippageBps <= effectiveMaxSlippageBps;
        sor1SlippageStatus = !withinEffectiveCap
          ? "REJECT"
          : observedSlippageBps !== null && observedSlippageBps > softLimitBps
            ? "WARN"
            : "PASS";
      } else if (evaluatedUsd === 0 && asks.length > 0) {
        sor1SlippageStatus = "PASS";
        observedSlippageBps = 0;
        sor1Compliant = true;
        fullyCovered = true;
      }

      rows.push({
        marketId: exp.marketId,
        outcomeLabel: exp.outcomeLabel,
        totalWageredUsd: roundCurrencyUsd(exp.wageredCents / 100),
        projectedHoldUsd:
          rowHoldCents !== null ? roundCurrencyUsd(rowHoldCents / 100) : null,
        grossLiabilityUsd: roundCurrencyUsd(exp.grossLiabilityCents / 100),
        hedgedLiabilityUsd: roundCurrencyUsd(hedgedCents / 100),
        netUnhedgedRiskUsd: roundCurrencyUsd(unhedgedCents / 100),
        evaluatedBookLiabilityUsd: evaluatedUsd,
        polymarketAvailableLiquidityUsd: availLiqUsd,
        coverageRatio,
        coveragePct,
        sor1SlippageStatus,
        observedSlippageBps,
        sor1Compliant,
        fullyCovered,
      });
    }

    const overallCoverageRatio =
      evaluatedBookLiabilityUsdAcc > 0
        ? Math.round(
            Math.min(
              10,
              polymarketLiquidityUsdAcc / evaluatedBookLiabilityUsdAcc,
            ) * 10_000,
          ) / 10_000
        : polymarketLiquidityUsdAcc > 0
          ? 1
          : null;
    const overallCoveragePct =
      overallCoverageRatio !== null
        ? roundCurrencyUsd(Math.min(1, overallCoverageRatio) * 100)
        : null;

    const payload = {
      readOnlySnapshot: true as const,
      hedgeExecutionEnabled: false as const,
      dataBasis: effectiveBasis,
      league,
      unhedgedOnly,
      effectiveMaxSlippageBps,
      sor1CeilingBps: SOR1_MAX_SLIPPAGE_BPS,
      totals: {
        totalWageredCents,
        totalWageredUsd: roundCurrencyUsd(totalWageredCents / 100),
        projectedHoldCents: anyHoldDeclared ? projectedHoldCentsAcc : null,
        projectedHoldUsd: anyHoldDeclared
          ? roundCurrencyUsd(projectedHoldCentsAcc / 100)
          : null,
        grossLiabilityCents: grossLiabilityCentsAcc,
        grossLiabilityUsd: roundCurrencyUsd(grossLiabilityCentsAcc / 100),
        hedgedLiabilityCents: hedgedLiabilityCentsAcc,
        hedgedLiabilityUsd: roundCurrencyUsd(hedgedLiabilityCentsAcc / 100),
        netUnhedgedRiskCents: netUnhedgedRiskCentsAcc,
        netUnhedgedRiskUsd: roundCurrencyUsd(netUnhedgedRiskCentsAcc / 100),
        evaluatedBookLiabilityUsd: evaluatedBookLiabilityUsdAcc,
        polymarketAvailableLiquidityUsd: polymarketLiquidityUsdAcc,
        overallCoverageRatio,
        overallCoveragePct,
      },
      rows,
    };

    return {
      structuredContent: payload,
      content: [{ type: "text", text: JSON.stringify(payload) }],
    };
  } catch (error) {
    return mcpToolErrorResult(error, "invalid_liability_input");
  }
}

// ============================================================================
// 2. MCP SERVER FACTORY
// ============================================================================

export interface SportsdeskMcpServerOptions {
  readonly policyEnv?: Readonly<Record<string, string | undefined>> | undefined;
}

export function createSportsdeskMcpServer(
  options: SportsdeskMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: SPORTSDESK_MCP_SERVER_NAME,
    version: SPORTSDESK_MCP_SERVER_VERSION,
    title: "SportsDesk Operations Spine",
  });

  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  } as const;

  server.registerTool(
    "get_channel_provenance",
    {
      title: "Get Ingestion Channel Provenance",
      description:
        "Resolve 4-bit routing channelOrdinal (0..15), optional bridgeOrdinal (0..9), or 16-entry ExtendedSignalChannelCode values into their precomputed 24-bit RGB provenance palette entry, neuron token SLAs, writer-lane aliases, and permitted/resolved upstream origin domains.",
      inputSchema: GET_CHANNEL_PROVENANCE_INPUT,
      outputSchema: GET_CHANNEL_PROVENANCE_OUTPUT,
      annotations: {
        title: "Get Channel Provenance",
        ...readOnlyAnnotations,
      },
    },
    (input) => runGetChannelProvenanceTool(input),
  );

  server.registerTool(
    "get_bridge_channel_catalog",
    {
      title: "Get Bridge & Channel Routing Catalog",
      description:
        "Inspect the 10 transport ingestion bridges and 16 signal channels, verify bridge-to-channel bitmask permissions, decode 32-bit BridgeChannelPackedWord32 route handles, or demultiplex a raw wire ingest envelope.",
      inputSchema: GET_BRIDGE_CHANNEL_CATALOG_INPUT,
      outputSchema: GET_BRIDGE_CHANNEL_CATALOG_OUTPUT,
      annotations: {
        title: "Get Bridge & Channel Catalog",
        ...readOnlyAnnotations,
      },
    },
    (input) => runGetBridgeChannelCatalogTool(input),
  );

  server.registerTool(
    "check_sor_slippage",
    {
      title: "Check SOR-1 Slippage Policy",
      description:
        "Evaluate proposed execution slippage or walk an ask ladder against the 25 bps default soft-limit warning (PASS/WARN/REJECT), per-sport execution tiers, global EXECUTION_MAX_SLIPPAGE_BPS policy, the 200 bps SOR-1 ceiling, and the 64-byte NSH frame u8 slippage slot.",
      inputSchema: CHECK_SOR_SLIPPAGE_INPUT,
      outputSchema: CHECK_SOR_SLIPPAGE_OUTPUT,
      annotations: {
        title: "Check SOR-1 Slippage",
        ...readOnlyAnnotations,
      },
    },
    (input) => runCheckSorSlippageTool(input, options.policyEnv ?? Bun.env),
  );

  server.registerTool(
    "decode_nsh_frame",
    {
      title: "Decode 64-Byte NSH Binary Frame",
      description:
        "Decode and validate a 64-byte little-endian NSH binary frame (hex or base64) into unpacked channel/SLA/row handles, resolved routing channel code and RGB provenance hex, 64-bit betGroupId, financial floats, origin-domain and writer-lane brand metadata, flags, and SOR-1 slippage.",
      inputSchema: DECODE_NSH_FRAME_INPUT,
      outputSchema: DECODE_NSH_FRAME_OUTPUT,
      annotations: {
        title: "Decode 64B NSH Frame",
        ...readOnlyAnnotations,
      },
    },
    (input) => runDecodeNshFrameTool(input),
  );

  server.registerTool(
    "get_trading_desk_kpis_and_sport_tree",
    {
      title: "Get Trading Desk KPIs & Sport Tree",
      description:
        "Read-only snapshot of top-bar Trading Terminal KPIs (Margin, GGR, Held %, Active Bets, Polymarket Available Liquidity with null-honest unmeasured fields) and the hierarchical Sport View live sport/league tree.",
      inputSchema: GET_TRADING_DESK_KPIS_AND_SPORT_TREE_INPUT,
      outputSchema: GET_TRADING_DESK_KPIS_AND_SPORT_TREE_OUTPUT,
      annotations: {
        title: "Get Trading Desk KPIs & Sport Tree",
        ...readOnlyAnnotations,
      },
    },
    (input) => runGetTradingDeskKpisAndSportTreeTool(input),
  );

  server.registerTool(
    "get_live_line_trading_board",
    {
      title: "Get Live Line-Trading Board",
      description:
        "Read-only snapshot for the Line-Trading Dashboard and Live Trading Dashboard multi-match cards: evaluates 1X2, Spread, and Over-Under ladders, opener movement deltas, key-number crossings, SHARP_STILL_BETTER layoff risk alerts, and historic odds/score trajectories.",
      inputSchema: GET_LIVE_LINE_TRADING_BOARD_INPUT,
      outputSchema: GET_LIVE_LINE_TRADING_BOARD_OUTPUT,
      annotations: {
        title: "Get Live Line-Trading Board",
        ...readOnlyAnnotations,
      },
    },
    (input) => runGetLiveLineTradingBoardTool(input),
  );

  server.registerTool(
    "get_active_bet_blotter",
    {
      title: "Get Active Bet Blotter & OTC Snapshots",
      description:
        "Read-only snapshot of Active Bet Logs & Risk Triggers plus Telegram OTC quote-request advisories: attaches 24-bit RGB provenance channels, excludes ALERT/BLOCKED noise from canonical volume/liability, supports Show Unhedged Only filtering, and exposes zero approval or hedge mutation actions.",
      inputSchema: GET_ACTIVE_BET_BLOTTER_INPUT,
      outputSchema: GET_ACTIVE_BET_BLOTTER_OUTPUT,
      annotations: {
        title: "Get Active Bet Blotter",
        ...readOnlyAnnotations,
      },
    },
    (input) => runGetActiveBetBlotterTool(input),
  );

  server.registerTool(
    "get_liability_and_polymarket_liquidity",
    {
      title: "Get Book Liability vs Polymarket Liquidity",
      description:
        "Read-only snapshot of Book Liability vs Polymarket CLOB Available Liquidity, the Liability Monitor (Total / Hold / Net Risk) matrix, Show Unhedged Only filtering, and SOR-1 200 bps ask-ladder coverage without hedge-execution side effects.",
      inputSchema: GET_LIABILITY_AND_POLYMARKET_LIQUIDITY_INPUT,
      outputSchema: GET_LIABILITY_AND_POLYMARKET_LIQUIDITY_OUTPUT,
      annotations: {
        title: "Get Liability & Polymarket Liquidity",
        ...readOnlyAnnotations,
      },
    },
    (input) =>
      runGetLiabilityAndPolymarketLiquidityTool(
        input,
        options.policyEnv ?? Bun.env,
      ),
  );

  return server;
}

// ============================================================================
// 3. CONSTANT-TIME BEARER AUTHENTICATION & STREAMABLE HTTP TRANSPORT
// ============================================================================

export type McpAuthVerificationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly status: 401 | 503;
      readonly code: number;
      readonly message: string;
    };

function sha256Bytes(input: string): Buffer {
  return createHash("sha256").update(input, "utf8").digest();
}

export function verifyMcpBearerAuth(
  req: Request,
  expectedToken: string | undefined,
): McpAuthVerificationResult {
  const normalizedExpected = expectedToken?.trim() ?? "";
  if (normalizedExpected === "") {
    return {
      ok: false,
      status: 503,
      code: -32000,
      message: "SPORTSDESK_ADMIN_TOKEN is not set on the server",
    };
  }

  const rawHeader = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(rawHeader.trim());
  if (!match?.[1]) {
    return {
      ok: false,
      status: 401,
      code: -32000,
      message: "Missing or malformed Authorization: Bearer <token> header",
    };
  }

  const actualDigest = sha256Bytes(match[1]);
  const expectedDigest = sha256Bytes(normalizedExpected);
  if (!timingSafeEqual(actualDigest, expectedDigest)) {
    return {
      ok: false,
      status: 401,
      code: -32000,
      message: "Invalid bearer token",
    };
  }

  return { ok: true };
}

export interface SportsdeskMcpHttpHandlerOptions {
  /** Run without `Mcp-Session-Id` state; each request uses an isolated server/transport pair. */
  readonly stateless?: boolean | undefined;
  /** Return `application/json` bodies instead of `text/event-stream` on `POST /mcp`. */
  readonly enableJsonResponse?: boolean | undefined;
  /** Maximum concurrent stateful sessions retained before oldest-session eviction (default: 256). */
  readonly maxSessions?: number | undefined;
  /** Idle TTL in milliseconds before inactive stateful sessions expire (default: 30 minutes). */
  readonly sessionIdleTtlMs?: number | undefined;
  /** Require `Authorization: Bearer <token>` (default: true). */
  readonly requireAuth?: boolean | undefined;
  /** Resolve expected Bearer token per request (defaults to `Bun.env.SPORTSDESK_ADMIN_TOKEN`). */
  readonly resolveAuthToken?: (() => string | undefined) | undefined;
  /** Allowed cross-origin callers echoed into `Access-Control-Allow-Origin`. */
  readonly allowedOrigins?: readonly string[] | undefined;
  /** Optional policy environment passed to `check_sor_slippage`. */
  readonly policyEnv?: Readonly<Record<string, string | undefined>> | undefined;
}

interface StatefulMcpSessionEntry {
  readonly sessionId: string;
  readonly server: McpServer;
  readonly transport: WebStandardStreamableHTTPServerTransport;
  lastSeenAtMs: number;
}

export interface SportsdeskMcpHttpHandler {
  readonly stateless: boolean;
  readonly requireAuth: boolean;
  readonly handleRequest: (req: Request) => Promise<Response>;
  readonly getActiveSessionCount: () => number;
  readonly getActiveStatelessCount: () => number;
  readonly hasSession: (sessionId: string) => boolean;
  readonly closeAll: () => Promise<void>;
}

function isValidOptionalPortSuffix(suffix: string): boolean {
  if (suffix === "") return true;
  if (!/^:\d{1,5}$/.test(suffix)) return false;
  const port = Number(suffix.slice(1));
  return port >= 1 && port <= 65_535;
}

function isLoopbackHostHeader(hostHeader: string | null): boolean {
  if (hostHeader === null) return false;
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed === "") return false;
  if (trimmed === "::1") return true;
  if (trimmed.startsWith("[")) {
    const closeBracket = trimmed.indexOf("]");
    if (closeBracket < 0) return false;
    const ipv6Host = trimmed.slice(1, closeBracket);
    const suffix = trimmed.slice(closeBracket + 1);
    return ipv6Host === "::1" && isValidOptionalPortSuffix(suffix);
  }
  const colonIndex = trimmed.indexOf(":");
  const hostOnly = colonIndex >= 0 ? trimmed.slice(0, colonIndex) : trimmed;
  const suffix = colonIndex >= 0 ? trimmed.slice(colonIndex) : "";
  return (
    (hostOnly === "127.0.0.1" || hostOnly === "localhost") &&
    isValidOptionalPortSuffix(suffix)
  );
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return isLoopbackHostHeader(parsed.host);
  } catch {
    return false;
  }
}

function buildMcpSecurityHeaders(
  req: Request,
  allowedOrigins: readonly string[],
): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": MCP_ALLOW_METHODS,
    "Access-Control-Allow-Headers": MCP_ALLOW_HEADERS,
    "Access-Control-Expose-Headers": MCP_EXPOSE_HEADERS,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin, Authorization",
  };
  const origin = req.headers.get("origin");
  if (origin !== null && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function withMergedHeaders(
  response: Response,
  extraHeaders: Record<string, string>,
): Response {
  const merged = new Headers(response.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (key.toLowerCase() === "cache-control" && merged.has("cache-control")) {
      continue;
    }
    merged.set(key, value);
  }
  const contentType = (merged.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/event-stream")) {
    merged.set("X-Accel-Buffering", "no");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: merged,
  });
}

function jsonRpcErrorResponse(
  status: number,
  code: number,
  message: string,
  extraHeaders: Record<string, string>,
): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code, message },
      id: null,
    }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
      },
    },
  );
}

/**
 * Bun.serve buffers HTTP 200 response headers on a ReadableStream body until the first
 * non-empty chunk is enqueued. Prepending an SSE comment frame flushes GET /mcp headers
 * immediately (~1ms TTFB instead of waiting for the 8s keepalive interval).
 */
function withImmediateSseHeaderFlush(response: Response): Response {
  const body = response.body;
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (
    response.status !== 200 ||
    body === null ||
    !contentType.includes("text/event-stream")
  ) {
    return response;
  }

  const reader = body.getReader();
  let cancelled = false;
  const flushed = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(INITIAL_SSE_FLUSH_BYTES);
    },
    async pull(controller) {
      const chunk = await reader.read();
      if (cancelled) return;
      if (chunk.done) {
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      cancelled = true;
      await reader.cancel(reason);
    },
  });

  return new Response(flushed, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function attachStreamFinalizer(
  response: Response,
  onFinalize: () => Promise<void>,
): Response {
  const body = response.body;
  const contentType = (
    response.headers.get("content-type") ?? ""
  ).toLowerCase();
  if (body === null || !contentType.includes("text/event-stream")) {
    return response;
  }

  const reader = body.getReader();
  let finalized = false;
  let cancelled = false;
  const runFinalize = async (): Promise<void> => {
    if (finalized) return;
    finalized = true;
    await onFinalize();
  };

  const wrapped = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (cancelled) {
          await runFinalize();
          return;
        }
        if (chunk.done) {
          controller.close();
          await runFinalize();
          return;
        }
        controller.enqueue(chunk.value);
      } catch (err) {
        await runFinalize();
        throw err;
      }
    },
    async cancel(reason) {
      cancelled = true;
      try {
        await reader.cancel(reason);
      } finally {
        await runFinalize();
      }
    },
  });

  return new Response(wrapped, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export function createSportsdeskMcpHttpHandler(
  options: SportsdeskMcpHttpHandlerOptions = {},
): SportsdeskMcpHttpHandler {
  const stateless = options.stateless === true;
  const enableJsonResponse = options.enableJsonResponse === true;
  const maxSessions = Math.max(
    1,
    Math.trunc(options.maxSessions ?? DEFAULT_MAX_MCP_SESSIONS),
  );
  const sessionIdleTtlMs = Math.max(
    1,
    Math.trunc(options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS),
  );
  const requireAuth = options.requireAuth ?? true;
  const resolveAuthToken =
    options.resolveAuthToken ?? (() => Bun.env.SPORTSDESK_ADMIN_TOKEN);
  const allowedOrigins = options.allowedOrigins ?? [];

  const sessions: StatefulMcpSessionEntry[] = [];
  const activeStatelessServers: McpServer[] = [];

  function isSessionEntryExpired(
    entry: StatefulMcpSessionEntry,
    nowMs: number,
  ): boolean {
    return nowMs - entry.lastSeenAtMs > sessionIdleTtlMs;
  }

  async function pruneExpiredSessions(nowMs: number): Promise<void> {
    const expired: StatefulMcpSessionEntry[] = [];
    for (let i = sessions.length - 1; i >= 0; i--) {
      const candidate = sessions[i];
      if (candidate && isSessionEntryExpired(candidate, nowMs)) {
        sessions.splice(i, 1);
        expired.push(candidate);
      }
    }
    if (expired.length > 0) {
      await Promise.all(expired.map((entry) => entry.server.close()));
    }
  }

  function findSessionIndex(sessionId: string): number {
    for (let i = 0; i < sessions.length; i++) {
      if (sessions[i]?.sessionId === sessionId) return i;
    }
    return -1;
  }

  function removeSessionEntry(
    sessionId: string,
  ): StatefulMcpSessionEntry | null {
    const idx = findSessionIndex(sessionId);
    if (idx < 0) return null;
    const [removed] = sessions.splice(idx, 1);
    return removed ?? null;
  }

  function removeStatelessServer(server: McpServer): void {
    const idx = activeStatelessServers.indexOf(server);
    if (idx >= 0) {
      activeStatelessServers.splice(idx, 1);
    }
  }

  function collectEvictedSessions(): StatefulMcpSessionEntry[] {
    const evictedList: StatefulMcpSessionEntry[] = [];
    while (sessions.length >= maxSessions) {
      let oldestIndex = 0;
      let oldestTime = sessions[0]?.lastSeenAtMs ?? Infinity;
      for (let i = 1; i < sessions.length; i++) {
        const ts = sessions[i]?.lastSeenAtMs ?? Infinity;
        if (ts < oldestTime) {
          oldestTime = ts;
          oldestIndex = i;
        }
      }
      const [evicted] = sessions.splice(oldestIndex, 1);
      if (evicted) {
        evictedList.push(evicted);
      }
    }
    return evictedList;
  }

  async function handleStatelessRequest(
    req: Request,
    secHeaders: Record<string, string>,
  ): Promise<Response> {
    const mcpServer = createSportsdeskMcpServer(
      options.policyEnv ? { policyEnv: options.policyEnv } : {},
    );
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse,
      keepAliveMs: DEFAULT_SSE_KEEPALIVE_MS,
    });
    await mcpServer.connect(transport);
    activeStatelessServers.push(mcpServer);

    let closed = false;
    const closePair = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      removeStatelessServer(mcpServer);
      await mcpServer.close();
    };

    try {
      const rawResponse = await transport.handleRequest(req);
      const merged = withMergedHeaders(rawResponse, secHeaders);
      const contentType = (
        merged.headers.get("content-type") ?? ""
      ).toLowerCase();
      if (merged.body !== null && contentType.includes("text/event-stream")) {
        return attachStreamFinalizer(merged, closePair);
      }
      await closePair();
      return merged;
    } catch (error) {
      await closePair();
      throw error;
    }
  }

  async function handleStatefulRequest(
    req: Request,
    secHeaders: Record<string, string>,
  ): Promise<Response> {
    await pruneExpiredSessions(Date.now());
    const sessionIdHeader = req.headers.get("mcp-session-id")?.trim() ?? "";

    if (sessionIdHeader !== "") {
      const idx = findSessionIndex(sessionIdHeader);
      const existing = idx >= 0 ? sessions[idx] : undefined;
      if (!existing) {
        return jsonRpcErrorResponse(
          404,
          -32001,
          "Session not found",
          secHeaders,
        );
      }
      existing.lastSeenAtMs = Date.now();
      const rawResponse = await existing.transport.handleRequest(req);
      const merged = withMergedHeaders(rawResponse, secHeaders);
      return req.method === "GET"
        ? withImmediateSseHeaderFlush(merged)
        : merged;
    }

    if (req.method === "GET") {
      const accept = req.headers.get("accept") ?? "";
      if (!accept.includes("text/event-stream")) {
        return jsonRpcErrorResponse(
          406,
          -32000,
          "Not Acceptable: Client must accept text/event-stream",
          secHeaders,
        );
      }
      return jsonRpcErrorResponse(
        400,
        -32000,
        "Bad Request: Mcp-Session-Id header is required",
        secHeaders,
      );
    }

    if (req.method === "DELETE") {
      return jsonRpcErrorResponse(
        400,
        -32000,
        "Bad Request: Mcp-Session-Id header is required",
        secHeaders,
      );
    }

    const mcpServer = createSportsdeskMcpServer(
      options.policyEnv ? { policyEnv: options.policyEnv } : {},
    );
    let registeredSessionId: string | null = null;

    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      enableJsonResponse,
      keepAliveMs: DEFAULT_SSE_KEEPALIVE_MS,
      onsessioninitialized: async (newSessionId: string) => {
        const evicted = collectEvictedSessions();
        registeredSessionId = newSessionId;
        sessions.push({
          sessionId: newSessionId,
          server: mcpServer,
          transport,
          lastSeenAtMs: Date.now(),
        });
        if (evicted.length > 0) {
          await Promise.all(evicted.map((entry) => entry.server.close()));
        }
      },
      onsessionclosed: async (closedSessionId: string) => {
        const removed = removeSessionEntry(closedSessionId);
        if (removed) {
          await removed.server.close();
        }
      },
    });

    await mcpServer.connect(transport);
    try {
      const rawResponse = await transport.handleRequest(req);
      if (registeredSessionId === null) {
        await mcpServer.close();
      }
      return withMergedHeaders(rawResponse, secHeaders);
    } catch (error) {
      if (registeredSessionId !== null) {
        removeSessionEntry(registeredSessionId);
      }
      await mcpServer.close();
      throw error;
    }
  }

  async function handleRequest(req: Request): Promise<Response> {
    const secHeaders = buildMcpSecurityHeaders(req, allowedOrigins);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: secHeaders });
    }

    const requestUrl = new URL(req.url);
    const requestOrigin = requestUrl.origin;
    const originHeader = req.headers.get("origin");

    if (requireAuth) {
      const auth = verifyMcpBearerAuth(req, resolveAuthToken());
      if (!auth.ok) {
        const authHeaders: Record<string, string> = {
          ...secHeaders,
          ...(auth.status === 401
            ? { "WWW-Authenticate": 'Bearer realm="sportsdesk-mcp"' }
            : {}),
        };
        return jsonRpcErrorResponse(
          auth.status,
          auth.code,
          auth.message,
          authHeaders,
        );
      }
      if (
        originHeader !== null &&
        originHeader !== requestOrigin &&
        !allowedOrigins.includes(originHeader)
      ) {
        return jsonRpcErrorResponse(
          403,
          -32000,
          "Forbidden: Origin is not allowlisted for MCP access",
          secHeaders,
        );
      }
    } else {
      const effectiveHost = req.headers.get("host") ?? requestUrl.host;
      if (!isLoopbackHostHeader(effectiveHost)) {
        return jsonRpcErrorResponse(
          403,
          -32000,
          "Forbidden: non-loopback Host header rejected on unauthenticated MCP endpoint",
          secHeaders,
        );
      }
      if (
        originHeader !== null &&
        originHeader !== requestOrigin &&
        !isLoopbackOrigin(originHeader) &&
        !allowedOrigins.includes(originHeader)
      ) {
        return jsonRpcErrorResponse(
          403,
          -32000,
          "Forbidden: cross-origin request rejected on unauthenticated MCP endpoint",
          secHeaders,
        );
      }
    }

    if (stateless) {
      if (req.method !== "POST") {
        return jsonRpcErrorResponse(
          405,
          -32000,
          "Method not allowed in stateless MCP mode; use POST /mcp.",
          {
            ...secHeaders,
            Allow: "POST",
          },
        );
      }
      return handleStatelessRequest(req, secHeaders);
    }

    if (
      req.method !== "GET" &&
      req.method !== "POST" &&
      req.method !== "DELETE"
    ) {
      return jsonRpcErrorResponse(405, -32000, "Method not allowed.", {
        ...secHeaders,
        Allow: "GET, POST, DELETE",
      });
    }

    return handleStatefulRequest(req, secHeaders);
  }

  async function closeAll(): Promise<void> {
    const activeSessions = sessions.splice(0, sessions.length);
    const statelessList = activeStatelessServers.splice(
      0,
      activeStatelessServers.length,
    );
    await Promise.all([
      ...activeSessions.map((entry) => entry.server.close()),
      ...statelessList.map((srv) => srv.close()),
    ]);
  }

  return {
    stateless,
    requireAuth,
    handleRequest,
    getActiveSessionCount: () => {
      const nowMs = Date.now();
      let count = 0;
      for (let i = 0; i < sessions.length; i++) {
        const entry = sessions[i];
        if (entry && !isSessionEntryExpired(entry, nowMs)) {
          count += 1;
        }
      }
      return count;
    },
    getActiveStatelessCount: () => activeStatelessServers.length,
    hasSession: (sessionId: string) => {
      const idx = findSessionIndex(sessionId);
      const entry = idx >= 0 ? sessions[idx] : undefined;
      return entry !== undefined && !isSessionEntryExpired(entry, Date.now());
    },
    closeAll,
  };
}
