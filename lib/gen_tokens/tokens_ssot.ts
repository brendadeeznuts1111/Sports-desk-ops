export type UiRole =
  | "surface"
  | "border"
  | "border_hairline"
  | "border_interactive"
  | "focus"
  | "text";

export const ROUTE_THRESHOLD_KINDS = [
  "consensus_lag",
  "bayes_shrinkage",
  "liquidity_depth",
  "composite_risk_gate",
] as const;

export type RouteThresholdKind = (typeof ROUTE_THRESHOLD_KINDS)[number];

const UI_ROLES: readonly UiRole[] = [
  "surface",
  "border",
  "border_hairline",
  "border_interactive",
  "focus",
  "text",
];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export type TokensMeta = {
  schema?: string;
  version: string;
  author?: string;
  updated_at?: string;
};

export type TokensGatesToml = {
  readonly min_body_contrast_ratio_milli: number;
  readonly min_aaa_slate_contrast_milli: number;
  readonly min_ui_component_contrast_milli: number;
  readonly min_cross_state_delta_e00_milli: number;
  readonly min_fresh_vs_stale_delta_e00_milli: number;
};

export type SurfaceToml = {
  layer_id: "SURFACE.DOM" | "SURFACE.CLI";
  token_name: string;
  hex: string;
  surface_name: string;
  role: string;
  viewport: string;
  protocol: string;
  color_depth: string;
};

export type SlaStateToml = {
  readonly key: string;
  readonly state_id: string;
  readonly token_name: string;
  readonly fg_hex: string;
  readonly bg_hex: string;
  readonly border_hex: string;
  readonly description: string;
};

export type IngestionSlaToml =
  { sla_kind: "latency"; sla_ms: number } | { sla_kind: "sentinel_drop" };

export type IngestionChannelToml = {
  channel_id: number;
  source_bridge_id: number;
  canonical_provenance: string;
  layer_id: string;
  token_name: string;
  legacy_token_name?: string;
  hex: string;
  legacy_wire_hex?: string;
  channel_code: string;
  wire_aliases: readonly string[];
  signal_tier: string;
  transport_uri: string;
  channel_status: string;
  volume_rule: string;
  operational_role: string;
  sla_tens_of_ms: number;
} & IngestionSlaToml;

export type RouteThresholdToml =
  | {
      threshold_kind: "consensus_lag";
      max_lag_ms: number;
    }
  | {
      threshold_kind: "bayes_shrinkage";
      tau_star_basis_points: number;
      min_tickets: number;
    }
  | {
      threshold_kind: "liquidity_depth";
      min_depth_cents: number;
    }
  | {
      threshold_kind: "composite_risk_gate";
      min_toxicity_score: number;
      max_hold_rate_basis_points: number;
      max_deficit_cents: number;
    };

export type RouteToml = {
  route_id: number;
  layer_id: string;
  token_name: string;
  hex: string;
  route_name: string;
  move_flag: string;
  trigger_kind: string;
  mitigation_kind: string;
  operational_role: string;
} & RouteThresholdToml;

export type UiTokenToml = {
  token_name: string;
  hex: string;
  role: UiRole;
  state_slot?: string;
  description: string;
};

export type BitmasksToml = {
  readonly bet_legs: Readonly<Record<string, number>>;
  readonly ui_state: Readonly<Record<string, number>>;
};

export type KeymapSlotToml = {
  readonly key: string;
  readonly slot_index: number;
  readonly bit_mask: number;
  readonly key_code: string;
  readonly keycap: string;
  readonly forensic_mode: number;
  readonly label: string;
};

export type TokensSsot = {
  meta: TokensMeta;
  gates: TokensGatesToml;
  surfaces: SurfaceToml[];
  ui: UiTokenToml[];
  sla: SlaStateToml[];
  bridges: Readonly<Record<string, number>>;
  ingestion: IngestionChannelToml[];
  routes: RouteToml[];
  bitmasks: BitmasksToml;
  keymap: KeymapSlotToml[];
  tokens: Readonly<Record<string, string>>;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function scanNoFloats(node: unknown, path: string): void {
  if (typeof node === "number" && !Number.isInteger(node)) {
    throw new Error(`ERR_SPEC_FLOAT_THRESHOLD_FORBIDDEN: ${path}=${node}`);
  }
  if (node !== null && typeof node === "object") {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      scanNoFloats(val, `${path}.${key}`);
    }
  }
}

function reqString(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`[tokens_ssot] ${ctx}: missing or invalid string ${key}`);
  }
  return v;
}

function reqHex(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): string {
  const v = reqString(obj, key, ctx);
  if (!HEX_COLOR_RE.test(v)) {
    throw new Error(
      `[tokens_ssot] ${ctx}: invalid #RRGGBB hex for ${key}: ${v}`,
    );
  }
  return v;
}

function optHex(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !HEX_COLOR_RE.test(v)) {
    throw new Error(
      `[tokens_ssot] ${ctx}: invalid optional #RRGGBB hex for ${key}: ${String(v)}`,
    );
  }
  return v;
}

function optTokenName(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): string | undefined {
  const v = obj[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !v.startsWith("--sd-")) {
    throw new Error(
      `[tokens_ssot] ${ctx}: invalid optional --sd-* token for ${key}: ${String(v)}`,
    );
  }
  return v;
}

function reqInt(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`[tokens_ssot] ${ctx}: missing or invalid integer ${key}`);
  }
  return v;
}

function reqPositiveInt(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): number {
  const v = reqInt(obj, key, ctx);
  if (v <= 0) {
    throw new Error(`[tokens_ssot] ${ctx}: ${key} must be > 0 (got ${v})`);
  }
  return v;
}

function reqIntRange(
  obj: Record<string, unknown>,
  key: string,
  min: number,
  max: number,
  ctx: string,
): number {
  const v = reqInt(obj, key, ctx);
  if (v < min || v > max) {
    throw new Error(
      `[tokens_ssot] ${ctx}: ${key} must be in [${min}, ${max}] (got ${v})`,
    );
  }
  return v;
}

function reqStringArray(
  obj: Record<string, unknown>,
  key: string,
  ctx: string,
): readonly string[] {
  const raw = obj[key];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `[tokens_ssot] ${ctx}: ${key} must be a non-empty string[]`,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(
        `[tokens_ssot] ${ctx}: ${key}[${i}] must be a non-empty string`,
      );
    }
    out.push(item);
  }
  return out;
}

function parseMeta(raw: unknown): TokensMeta {
  if (!isRecord(raw)) {
    throw new Error("[tokens_ssot] meta must be a table");
  }
  const version = reqString(raw, "version", "meta");
  const out: TokensMeta = { version };
  if (typeof raw.schema === "string" && raw.schema.length > 0) {
    out.schema = raw.schema;
  }
  if (typeof raw.author === "string" && raw.author.length > 0) {
    out.author = raw.author;
  }
  if (typeof raw.updated_at === "string" && raw.updated_at.length > 0) {
    out.updated_at = raw.updated_at;
  }
  return out;
}

function parseGates(raw: unknown): TokensGatesToml {
  if (!isRecord(raw)) {
    throw new Error("[tokens_ssot] gates must be a table");
  }
  return {
    min_body_contrast_ratio_milli: reqPositiveInt(
      raw,
      "min_body_contrast_ratio_milli",
      "gates",
    ),
    min_aaa_slate_contrast_milli: reqPositiveInt(
      raw,
      "min_aaa_slate_contrast_milli",
      "gates",
    ),
    min_ui_component_contrast_milli: reqPositiveInt(
      raw,
      "min_ui_component_contrast_milli",
      "gates",
    ),
    min_cross_state_delta_e00_milli: reqPositiveInt(
      raw,
      "min_cross_state_delta_e00_milli",
      "gates",
    ),
    min_fresh_vs_stale_delta_e00_milli: reqPositiveInt(
      raw,
      "min_fresh_vs_stale_delta_e00_milli",
      "gates",
    ),
  };
}

function parseSurface(key: string, raw: unknown): SurfaceToml {
  if (!isRecord(raw)) {
    throw new Error(`[tokens_ssot] surfaces.${key}: expected table`);
  }
  const layer_id = reqString(raw, "layer_id", `surfaces.${key}`);
  if (layer_id !== "SURFACE.DOM" && layer_id !== "SURFACE.CLI") {
    throw new Error(
      `[tokens_ssot] surfaces.${key}: unknown layer_id ${layer_id}`,
    );
  }
  return {
    layer_id,
    token_name: reqString(raw, "token_name", `surfaces.${key}`),
    hex: reqHex(raw, "hex", `surfaces.${key}`),
    surface_name: reqString(raw, "surface_name", `surfaces.${key}`),
    role: reqString(raw, "role", `surfaces.${key}`),
    viewport: reqString(raw, "viewport", `surfaces.${key}`),
    protocol: reqString(raw, "protocol", `surfaces.${key}`),
    color_depth: reqString(raw, "color_depth", `surfaces.${key}`),
  };
}

function parseSlaEntry(key: string, raw: unknown): SlaStateToml {
  if (!isRecord(raw)) {
    throw new Error(`[tokens_ssot] sla.${key}: expected table`);
  }
  return {
    key,
    state_id: reqString(raw, "state_id", `sla.${key}`),
    token_name: reqString(raw, "token_name", `sla.${key}`),
    fg_hex: reqHex(raw, "fg_hex", `sla.${key}`),
    bg_hex: reqHex(raw, "bg_hex", `sla.${key}`),
    border_hex: reqHex(raw, "border_hex", `sla.${key}`),
    description: reqString(raw, "description", `sla.${key}`),
  };
}

function parseBridges(raw: unknown): Readonly<Record<string, number>> {
  if (!isRecord(raw)) {
    throw new Error("[tokens_ssot] bridges must be a table");
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) {
    throw new Error("[tokens_ssot] bridges must define at least one bridge ID");
  }
  const out: Record<string, number> = {};
  const seen = new Uint8Array(4);
  for (const [k, v] of entries) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 3) {
      throw new Error(
        `[tokens_ssot] bridges.${k}: SourceBridgeId2 must be integer 0..3 (got ${String(v)})`,
      );
    }
    if (seen[v] !== 0) {
      throw new Error(
        `[tokens_ssot] bridges.${k}: duplicate SourceBridgeId2 ${v}`,
      );
    }
    seen[v] = 1;
    out[k] = v;
  }
  return out;
}

function parseIngestionSla(
  key: string,
  raw: Record<string, unknown>,
): IngestionSlaToml {
  const sla_kind = reqString(raw, "sla_kind", `ingestion.${key}`);
  if (sla_kind === "latency") {
    return {
      sla_kind: "latency",
      sla_ms: reqPositiveInt(raw, "sla_ms", `ingestion.${key}`),
    };
  }
  if (sla_kind === "sentinel_drop") {
    return { sla_kind: "sentinel_drop" };
  }
  throw new Error(
    `[tokens_ssot] ingestion.${key}: unknown sla_kind ${JSON.stringify(sla_kind)}`,
  );
}

function parseIngestion(
  key: string,
  raw: unknown,
  seenChannelIds: Uint8Array,
): IngestionChannelToml {
  if (!isRecord(raw)) {
    throw new Error(`[tokens_ssot] ingestion.${key}: expected table`);
  }
  const sla = parseIngestionSla(key, raw);
  const channel_id = reqIntRange(raw, "channel_id", 0, 15, `ingestion.${key}`);
  if (seenChannelIds[channel_id] !== 0) {
    throw new Error(
      `[tokens_ssot] ingestion.${key}: duplicate channel_id ${channel_id}`,
    );
  }
  seenChannelIds[channel_id] = 1;

  const source_bridge_id = reqIntRange(
    raw,
    "source_bridge_id",
    0,
    3,
    `ingestion.${key}`,
  );
  const sla_tens_of_ms = reqIntRange(
    raw,
    "sla_tens_of_ms",
    0,
    255,
    `ingestion.${key}`,
  );
  if (sla.sla_kind === "latency" && sla.sla_ms !== sla_tens_of_ms * 10) {
    throw new Error(
      `[tokens_ssot] ingestion.${key}: sla_ms (${sla.sla_ms}) must equal sla_tens_of_ms * 10 (${sla_tens_of_ms * 10})`,
    );
  }
  if (sla.sla_kind === "sentinel_drop" && sla_tens_of_ms !== 0) {
    throw new Error(
      `[tokens_ssot] ingestion.${key}: sentinel_drop channel must have sla_tens_of_ms=0 (got ${sla_tens_of_ms})`,
    );
  }

  const legacy_wire_hex = optHex(raw, "legacy_wire_hex", `ingestion.${key}`);
  const legacy_token_name = optTokenName(
    raw,
    "legacy_token_name",
    `ingestion.${key}`,
  );

  const base: IngestionChannelToml = {
    channel_id,
    source_bridge_id,
    canonical_provenance: reqString(
      raw,
      "canonical_provenance",
      `ingestion.${key}`,
    ),
    layer_id: reqString(raw, "layer_id", `ingestion.${key}`),
    token_name: reqString(raw, "token_name", `ingestion.${key}`),
    ...(legacy_token_name !== undefined ? { legacy_token_name } : {}),
    hex: reqHex(raw, "hex", `ingestion.${key}`),
    ...(legacy_wire_hex !== undefined ? { legacy_wire_hex } : {}),
    channel_code: reqString(raw, "channel_code", `ingestion.${key}`),
    wire_aliases: reqStringArray(raw, "wire_aliases", `ingestion.${key}`),
    signal_tier: reqString(raw, "signal_tier", `ingestion.${key}`),
    transport_uri: reqString(raw, "transport_uri", `ingestion.${key}`),
    channel_status: reqString(raw, "channel_status", `ingestion.${key}`),
    volume_rule: reqString(raw, "volume_rule", `ingestion.${key}`),
    operational_role: reqString(raw, "operational_role", `ingestion.${key}`),
    sla_tens_of_ms,
    ...sla,
  };
  return base;
}

function parseRouteThreshold(
  key: string,
  raw: Record<string, unknown>,
): RouteThresholdToml {
  const kind = reqString(raw, "threshold_kind", `routes.${key}`);
  if (!isRouteThresholdKind(kind)) {
    throw new Error(
      `[tokens_ssot] routes.${key}: unknown threshold_kind ${JSON.stringify(kind)}`,
    );
  }
  switch (kind) {
    case "consensus_lag":
      return {
        threshold_kind: kind,
        max_lag_ms: reqPositiveInt(raw, "max_lag_ms", `routes.${key}`),
      };
    case "bayes_shrinkage":
      return {
        threshold_kind: kind,
        tau_star_basis_points: reqIntRange(
          raw,
          "tau_star_basis_points",
          1,
          10000,
          `routes.${key}`,
        ),
        min_tickets: reqPositiveInt(raw, "min_tickets", `routes.${key}`),
      };
    case "liquidity_depth":
      return {
        threshold_kind: kind,
        min_depth_cents: reqPositiveInt(
          raw,
          "min_depth_cents",
          `routes.${key}`,
        ),
      };
    case "composite_risk_gate":
      return {
        threshold_kind: kind,
        min_toxicity_score: reqInt(raw, "min_toxicity_score", `routes.${key}`),
        max_hold_rate_basis_points: reqInt(
          raw,
          "max_hold_rate_basis_points",
          `routes.${key}`,
        ),
        max_deficit_cents: reqInt(raw, "max_deficit_cents", `routes.${key}`),
      };
  }
}

function isRouteThresholdKind(k: string): k is RouteThresholdKind {
  return (
    k === "consensus_lag" ||
    k === "bayes_shrinkage" ||
    k === "liquidity_depth" ||
    k === "composite_risk_gate"
  );
}

function parseRoute(
  key: string,
  raw: unknown,
  seenRouteIds: Uint8Array,
): RouteToml {
  if (!isRecord(raw)) {
    throw new Error(`[tokens_ssot] routes.${key}: expected table`);
  }
  const threshold = parseRouteThreshold(key, raw);
  const route_id = reqIntRange(raw, "route_id", 0, 3, `routes.${key}`);
  if (seenRouteIds[route_id] !== 0) {
    throw new Error(
      `[tokens_ssot] routes.${key}: duplicate route_id ${route_id}`,
    );
  }
  seenRouteIds[route_id] = 1;

  return {
    route_id,
    layer_id: reqString(raw, "layer_id", `routes.${key}`),
    token_name: reqString(raw, "token_name", `routes.${key}`),
    hex: reqHex(raw, "hex", `routes.${key}`),
    route_name: reqString(raw, "route_name", `routes.${key}`),
    move_flag: reqString(raw, "move_flag", `routes.${key}`),
    trigger_kind: reqString(raw, "trigger_kind", `routes.${key}`),
    mitigation_kind: reqString(raw, "mitigation_kind", `routes.${key}`),
    operational_role: reqString(raw, "operational_role", `routes.${key}`),
    ...threshold,
  };
}

function parseUi(key: string, raw: unknown): UiTokenToml {
  if (!isRecord(raw)) {
    throw new Error(`[tokens_ssot] ui.${key}: expected table`);
  }
  const roleRaw = reqString(raw, "role", `ui.${key}`);
  if (!UI_ROLES.includes(roleRaw as UiRole)) {
    throw new Error(
      `[tokens_ssot] ui.${key}: role must be surface|border|border_hairline|border_interactive|focus|text, got ${JSON.stringify(roleRaw)}`,
    );
  }
  const state_slot =
    typeof raw.state_slot === "string" && raw.state_slot.length > 0
      ? raw.state_slot
      : undefined;
  return {
    token_name: reqString(raw, "token_name", `ui.${key}`),
    hex: reqHex(raw, "hex", `ui.${key}`),
    role: roleRaw as UiRole,
    ...(state_slot !== undefined ? { state_slot } : {}),
    description: reqString(raw, "description", `ui.${key}`),
  };
}

function parseBitmaskGroup(
  raw: unknown,
  ctx: string,
): Readonly<Record<string, number>> {
  if (!isRecord(raw)) {
    throw new Error(`[tokens_ssot] ${ctx} must be a table`);
  }
  const out: Record<string, number> = {};
  const seenBits = new Uint8Array(31);
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 30) {
      throw new Error(
        `[tokens_ssot] ${ctx}.${k}: BitSet32 bit position must be integer 0..30 (got ${String(v)})`,
      );
    }
    if (seenBits[v] !== 0) {
      throw new Error(`[tokens_ssot] ${ctx}.${k}: duplicate bit position ${v}`);
    }
    seenBits[v] = 1;
    out[k] = v;
  }
  return out;
}

function parseBitmasks(raw: unknown): BitmasksToml {
  if (!isRecord(raw)) {
    throw new Error("[tokens_ssot] bitmasks must be a table");
  }
  return {
    bet_legs: parseBitmaskGroup(raw.bet_legs, "bitmasks.bet_legs"),
    ui_state: parseBitmaskGroup(raw.ui_state, "bitmasks.ui_state"),
  };
}

function parseKeymap(raw: unknown): KeymapSlotToml[] {
  const entries = tableValues("keymap", raw);
  if (entries.length !== 10) {
    throw new Error(
      `ERR_A11Y_FOCUS_TRAP_LOOP: keymap must have 10 slots (got ${entries.length})`,
    );
  }
  let unionMask32 = 0;
  const seenKeys = new Uint8Array(256);
  const seenModes = new Uint16Array(16);
  const slots: KeymapSlotToml[] = [];

  for (const [k, v] of entries) {
    if (!isRecord(v)) {
      throw new Error(`[tokens_ssot] keymap.${k}: expected table`);
    }
    const slot_index = reqInt(v, "slot_index", `keymap.${k}`);
    const bit_mask = reqInt(v, "bit_mask", `keymap.${k}`);
    const key_code = reqString(v, "key_code", `keymap.${k}`);
    const keycap = reqString(v, "keycap", `keymap.${k}`);
    const forensic_mode = reqIntRange(v, "forensic_mode", 1, 10, `keymap.${k}`);
    const label = reqString(v, "label", `keymap.${k}`);

    const expectedMask = (1 << slot_index) >>> 0;
    if (slot_index < 0 || slot_index > 9 || bit_mask !== expectedMask) {
      throw new Error("ERR_A11Y_FOCUS_TRAP_LOOP");
    }
    if ((unionMask32 & expectedMask) !== 0) {
      throw new Error("ERR_A11Y_FOCUS_TRAP_LOOP");
    }
    unionMask32 = (unionMask32 | expectedMask) >>> 0;

    const charCode = keycap.charCodeAt(0);
    if (
      keycap.length !== 1 ||
      seenKeys[charCode] !== 0 ||
      seenModes[forensic_mode] !== 0
    ) {
      throw new Error("ERR_SPEC_KEYMAP_COLLISION");
    }
    seenKeys[charCode] = 1;
    seenModes[forensic_mode] = 1;

    slots.push({
      key: k,
      slot_index,
      bit_mask,
      key_code,
      keycap,
      forensic_mode,
      label,
    });
  }

  if (unionMask32 !== 0x03ff) {
    throw new Error("ERR_A11Y_FOCUS_TRAP_LOOP");
  }
  slots.sort((a, b) => a.slot_index - b.slot_index);
  return slots;
}

function parseTokensMap(raw: unknown): Readonly<Record<string, string>> {
  if (!isRecord(raw)) {
    throw new Error("[tokens_ssot] tokens must be a table");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || !HEX_COLOR_RE.test(v)) {
      throw new Error(
        `[tokens_ssot] tokens.${k}: invalid #RRGGBB hex (${String(v)})`,
      );
    }
    out[k] = v;
  }
  return out;
}

function tableValues(section: string, raw: unknown): [string, unknown][] {
  if (!isRecord(raw)) {
    throw new Error(`[tokens_ssot] ${section} must be a table`);
  }
  return Object.entries(raw);
}

export function parseTokensToml(tomlText: string): TokensSsot {
  const parsed: unknown = Bun.TOML.parse(tomlText);
  return parseTokensTomlFromParsed(parsed);
}

export function parseTokensTomlFromParsed(parsed: unknown): TokensSsot {
  if (!isRecord(parsed)) {
    throw new Error("[tokens_ssot] root must be a TOML table");
  }
  if (parsed.gates !== undefined) scanNoFloats(parsed.gates, "gates");
  if (parsed.bridges !== undefined) scanNoFloats(parsed.bridges, "bridges");
  if (parsed.ingestion !== undefined)
    scanNoFloats(parsed.ingestion, "ingestion");
  if (parsed.routes !== undefined) scanNoFloats(parsed.routes, "routes");
  if (parsed.bitmasks !== undefined) scanNoFloats(parsed.bitmasks, "bitmasks");
  if (parsed.keymap !== undefined) scanNoFloats(parsed.keymap, "keymap");

  const meta = parseMeta(parsed.meta);
  const surfaces = tableValues("surfaces", parsed.surfaces).map(([k, v]) =>
    parseSurface(k, v),
  );
  const seenChannelIds = new Uint8Array(16);
  const ingestion = tableValues("ingestion", parsed.ingestion).map(([k, v]) =>
    parseIngestion(k, v, seenChannelIds),
  );
  const seenRouteIds = new Uint8Array(4);
  const routes = tableValues("routes", parsed.routes).map(([k, v]) =>
    parseRoute(k, v, seenRouteIds),
  );
  const ui = tableValues("ui", parsed.ui ?? {}).map(([k, v]) => parseUi(k, v));

  const gates = parseGates(parsed.gates);
  const sla = tableValues("sla", parsed.sla).map(([k, v]) =>
    parseSlaEntry(k, v),
  );
  const bridges = parseBridges(parsed.bridges);
  const bitmasks = parseBitmasks(parsed.bitmasks);
  const keymap = parseKeymap(parsed.keymap);
  const tokens = parseTokensMap(parsed.tokens);

  return {
    meta,
    gates,
    surfaces,
    ui,
    sla,
    bridges,
    ingestion,
    routes,
    bitmasks,
    keymap,
    tokens,
  };
}

/** Row shape accepted by formatRouteThreshold (threshold fields only). */
export type RouteThresholdRow = RouteThresholdToml;
