import { DOMAIN_BRANDED_SECTION7_MARKER } from "./domain_branded_section.ts";
import { formatRouteThreshold } from "./route_threshold.ts";
import type { TokensSsot } from "./tokens_ssot.ts";

export function renderDomainBrandedSection7(ssot: TokensSsot): string {
  const {
    gates,
    surfaces,
    ui,
    sla,
    bridges,
    ingestion,
    routes,
    bitmasks,
    keymap,
  } = ssot;

  let out = `${DOMAIN_BRANDED_SECTION7_MARKER}

export type SignalChannelCode =
`;

  for (const c of ingestion) {
    out += `  | "${c.channel_code}"\n`;
  }

  out = out.trimEnd() + `;\n`;

  out += `
export type SignalChannelStatus =
  | "ACTIVE"
  | "DROPPED"
  | "ALERT"
  | "STEERABLE"
  | "CRITICAL"
  | "SUPPRESSED";

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
  minBodyContrastRatioMilli: ${gates.min_body_contrast_ratio_milli},
  minAaaSlateContrastMilli: ${gates.min_aaa_slate_contrast_milli},
  minUiComponentContrastMilli: ${gates.min_ui_component_contrast_milli},
  minCrossStateDeltaE00Milli: ${gates.min_cross_state_delta_e00_milli},
  minFreshVsStaleDeltaE00Milli: ${gates.min_fresh_vs_stale_delta_e00_milli},
} as const;

export const SOURCE_BRIDGE_IDS = {
`;

  for (const [k, v] of Object.entries(bridges)) {
    out += `  ${k}: ${v},\n`;
  }

  out += `} as const;

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
  readonly layerId: \`L\${string}.N\${string}\`;
  readonly tokenName: string;
  readonly legacyTokenName?: \`--sd-\${string}\`;
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
  readonly layerId: \`L\${number}.N\${string}\`;
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
  | IngestionChannelDefinition
  | RouteCircuitDefinition
  | SurfaceDefinition;

/**
 * Ingestion Signal Channels (Layers 17-24D).
 * Generated directly from tokens.toml.
 */
export const INGESTION_CHANNELS: readonly IngestionChannelDefinition[] = [
`;

  for (const c of ingestion) {
    const slaCode =
      c.sla_kind === "latency"
        ? `{ kind: "latency", latencySlaMs: ${c.sla_ms} }`
        : `{ kind: "sentinel_drop" }`;
    const aliasesLiteral = c.wire_aliases
      .map((a) => JSON.stringify(a))
      .join(", ");

    out += `  {
    channelId: ${c.channel_id},
    sourceBridgeId: ${c.source_bridge_id},
    canonicalProvenance: ${JSON.stringify(c.canonical_provenance)},
    layerId: ${JSON.stringify(c.layer_id)},
    tokenName: ${JSON.stringify(c.token_name)},
${c.legacy_token_name !== undefined ? `    legacyTokenName: ${JSON.stringify(c.legacy_token_name)},\n` : ""}    hex: ${JSON.stringify(c.hex)},
${c.legacy_wire_hex !== undefined ? `    legacyWireHex: ${JSON.stringify(c.legacy_wire_hex)},\n` : ""}    channelCode: ${JSON.stringify(c.channel_code)},
    wireAliases: [${aliasesLiteral}],
    signalTier: ${JSON.stringify(c.signal_tier)},
    transportUri: ${JSON.stringify(c.transport_uri)},
    sla: ${slaCode},
    slaTensOfMs: ${c.sla_tens_of_ms},
    channelStatus: ${JSON.stringify(c.channel_status)},
    volumeRule: ${JSON.stringify(c.volume_rule)},
    operationalRole: ${JSON.stringify(c.operational_role)},
  },
`;
  }

  out += `];

/** Plane 2 latency SLA (ms) per lane — derived from \`INGESTION_CHANNELS\` / tokens.toml SSOT. */
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
 * Generated, dependency-free writer. \`lib/nsh_frame_schema.ts\` keeps the validating
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
      \`channelId4 must be an integer in [0, 15] (got \${String(channelId4)})\`,
    );
  }
  if (
    !Number.isInteger(slaTensOfMs8) ||
    slaTensOfMs8 < 0 ||
    slaTensOfMs8 > 0xff
  ) {
    throw new RangeError(
      \`slaTensOfMs8 must be an integer in [0, 255] (got \${String(slaTensOfMs8)})\`,
    );
  }
  if (
    !Number.isInteger(rowIndex20) ||
    rowIndex20 < 0 ||
    rowIndex20 > 0xfffff
  ) {
    throw new RangeError(
      \`rowIndex20 must be an integer in [0, 1048575] (got \${String(rowIndex20)})\`,
    );
  }
  const packedWord32 =
    ((channelId4 & 0xf) << 28) |
    ((slaTensOfMs8 & 0xff) << 20) |
    (rowIndex20 & 0xfffff);
  return (packedWord32 >>> 0) as ChannelPackedHandle32;
}

/**
 * One metadata word per ingestion channel, in \`INGESTION_CHANNELS\` order. The row index is 0:
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
`;

  for (const r of routes) {
    const threshCode = formatRouteThreshold(r);
    out += `  {
    routeId: ${r.route_id},
    layerId: ${JSON.stringify(r.layer_id)},
    tokenName: ${JSON.stringify(r.token_name)},
    hex: ${JSON.stringify(r.hex)},
    routeName: ${JSON.stringify(r.route_name)},
    moveFlag: ${JSON.stringify(r.move_flag)},
    triggerKind: ${JSON.stringify(r.trigger_kind)},
    threshold: ${threshCode},
    mitigationKind: ${JSON.stringify(r.mitigation_kind)},
    operationalRole: ${JSON.stringify(r.operational_role)},
  },
`;
  }

  out += `];

/**
 * Telemetry Viewports & Rendering Surfaces.
 * Generated directly from tokens.toml.
 */
export const TELEMETRY_SURFACES: readonly SurfaceDefinition[] = [
`;

  for (const s of surfaces) {
    out += `  {
    layerId: ${JSON.stringify(s.layer_id)},
    tokenName: ${JSON.stringify(s.token_name)},
    hex: ${JSON.stringify(s.hex)},
    surfaceName: ${JSON.stringify(s.surface_name)},
    targetViewport: ${JSON.stringify(s.viewport)},
    protocol: ${JSON.stringify(s.protocol)},
    colorDepth: ${JSON.stringify(s.color_depth)},
    operationalRole: ${JSON.stringify(s.role)},
  },
`;
  }

  out += `];

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
`;

  for (const t of ui) {
    out += `  {
    tokenName: ${JSON.stringify(t.token_name)},
    hex: ${JSON.stringify(t.hex)},
    role: ${JSON.stringify(t.role)},
${t.state_slot !== undefined ? `    stateSlot: ${JSON.stringify(t.state_slot)},\n` : ""}    description: ${JSON.stringify(t.description)},
  },
`;
  }

  out += `];

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
`;

  for (const s of sla) {
    out += `  {
    stateId: ${JSON.stringify(s.state_id)},
    tokenName: ${JSON.stringify(s.token_name)},
    fgHex: ${JSON.stringify(s.fg_hex)},
    bgHex: ${JSON.stringify(s.bg_hex)},
    borderHex: ${JSON.stringify(s.border_hex)},
    description: ${JSON.stringify(s.description)},
  },
`;
  }

  out += `];

export const SLA_CSS_TOKENS: readonly SlaCssTokenDefinition[] = [
`;

  for (const s of sla) {
    out += `  {
    stateId: ${JSON.stringify(s.state_id)},
    tokenName: ${JSON.stringify(s.token_name)},
    hex: ${JSON.stringify(s.fg_hex)},
    role: "fg",
  },
  {
    stateId: ${JSON.stringify(s.state_id)},
    tokenName: ${JSON.stringify(`${s.token_name}-bg`)},
    hex: ${JSON.stringify(s.bg_hex)},
    role: "bg",
  },
  {
    stateId: ${JSON.stringify(s.state_id)},
    tokenName: ${JSON.stringify(`${s.token_name}-border`)},
    hex: ${JSON.stringify(s.border_hex)},
    role: "border",
  },
`;
  }

  out += `];

export const BET_LEG_BIT_POSITIONS = {
`;

  for (const [k, bit] of Object.entries(bitmasks.bet_legs)) {
    out += `  ${k}: ${bit},\n`;
  }

  out += `} as const;

export const BET_LEG_BITMASKS = {
`;

  for (const [k, bit] of Object.entries(bitmasks.bet_legs)) {
    const maskHex = ((1 << bit) >>> 0).toString(16).padStart(8, "0");
    out += `  ${k}: 0x${maskHex} as BitSet32,\n`;
  }

  out += `} as const;

export const UI_STATE_BIT_POSITIONS = {
`;

  for (const [k, bit] of Object.entries(bitmasks.ui_state)) {
    out += `  ${k}: ${bit},\n`;
  }

  out += `} as const;

export const UI_STATE_BITMASKS = {
`;

  for (const [k, bit] of Object.entries(bitmasks.ui_state)) {
    const maskHex = ((1 << bit) >>> 0).toString(16).padStart(8, "0");
    out += `  ${k}: 0x${maskHex} as BitSet32,\n`;
  }

  out += `} as const;

export interface OperatorKeymapSlot {
  readonly slotIndex: number;
  readonly bitMask: BitSet32;
  readonly keyCode: string;
  readonly keycap: string;
  readonly forensicMode: number;
  readonly label: string;
}

export const OPERATOR_KEYMAP: readonly OperatorKeymapSlot[] = [
`;

  for (const k of keymap) {
    const maskHex = (k.bit_mask >>> 0).toString(16).padStart(4, "0");
    out += `  {
    slotIndex: ${k.slot_index},
    bitMask: 0x${maskHex} as BitSet32,
    keyCode: ${JSON.stringify(k.key_code)},
    keycap: ${JSON.stringify(k.keycap)},
    forensicMode: ${k.forensic_mode},
    label: ${JSON.stringify(k.label)},
  },
`;
  }

  out += `];

/**
 * Slot-indexed bit column for the 10-key operator keymap:
 * \`KEYMAP_SLOTS[slotIndex] === OPERATOR_KEYMAP[slotIndex].bitMask\` (1 << slotIndex).
 * The array order is the bijection itself; do not sort or compact it.
 */
export const KEYMAP_SLOTS: Uint32Array = Uint32Array.from([
${[...keymap]
  .sort((a, b) => a.slot_index - b.slot_index)
  .map((k) => `  ${k.bit_mask},`)
  .join("\n")}
]);

/**
 * Complete registry across all decoupled axes (Ingestion + Routes + Surfaces).
 */
export const ALL_QWEN_TOKENS: readonly AnyQwenNeuronDefinition[] = [
  ...INGESTION_CHANNELS,
  ...ROUTE_CIRCUITS,
  ...TELEMETRY_SURFACES,
];
`;

  return out;
}
