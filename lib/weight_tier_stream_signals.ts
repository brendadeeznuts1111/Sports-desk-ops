/**
 * Weight-tier automation signals for the seven sharp-customer tracks (DOD6 v5.4 + Section 11).
 *
 * Maps live `getBetTicker` rows (never the PII-stripped `f402-bet-ticker` WS delta) to:
 *  - internal GSBUILDER / Manager line-step intents
 *  - optional `updateByColumn` VIP-shield payloads
 *  - unsigned Polymarket / Kalshi maker-taker order drafts (operator signing happens out of band)
 */
import type { F402TickerRow } from "./f402_ingest.ts";
import { padCustomerIdCanonical } from "../design/domain-branded-types.ts";
import { parseShortDesc } from "./live_wagers.ts";
import {
  buildStreamSignalDiagnostics,
  kalshiOrderSkeleton,
  polymarketClobOrderSkeleton,
  PickShapeTwinTracker,
  rotationKeyFromTickerShortDesc,
  ScoutApexTracker,
  type Dod6CustomerBookOverlay,
  type ScoutPrecursorHit,
  type StreamSignalDiagnostics,
} from "./weight_tier_signal_enrichment.ts";

export const WEIGHT_TIER_SCHEMA_VERSION = 2 as const;

export type { StreamSignalDiagnostics, Dod6CustomerBookOverlay };
export {
  PickShapeTwinTracker,
  ScoutApexTracker,
  buildStreamSignalDiagnostics,
  explainDiagnostics,
  loadDod6BookOverlayFromJson,
  pickShapeSha256FromShortDesc,
} from "./weight_tier_signal_enrichment.ts";

export type WeightTierId =
  | "tier1_apex_spread_ml"
  | "tier2_blindspot_clv_whales"
  | "tier3_probe_hammer_syndicate"
  | "tier4_college_steam"
  | "tier5_miami_syndicate"
  | "tier6_clv_signal_donors"
  | "tier7_correlated_parlay_extractors";

export interface WeightTierDefinition {
  readonly id: WeightTierId;
  readonly label: string;
  readonly logins: readonly string[];
  readonly agentHints: readonly string[];
}

/** Operator-facing tier registry (logins uppercased, suffix variants kept). */
export const WEIGHT_TIER_DEFINITIONS: readonly WeightTierDefinition[] = [
  {
    id: "tier1_apex_spread_ml",
    label: "Apex Spread/ML Originators (GX195 / WC8406)",
    logins: ["GX195", "WC8406"],
    agentHints: ["GOLD22", "ADAM"],
  },
  {
    id: "tier2_blindspot_clv_whales",
    label: "Blindspot High-CLV Whales",
    logins: ["NJD500", "CBT411", "EM189"],
    agentHints: ["NOLAJHR", "CAUFSIDE"],
  },
  {
    id: "tier3_probe_hammer_syndicate",
    label: "Probe-to-Hammer Syndicate (AT811 → AT10359 / BB5127)",
    logins: ["AT811", "AT10359", "BB5127"],
    agentHints: ["ATEAM"],
  },
  {
    id: "tier4_college_steam",
    label: "College & Derivative Steam (BB55103 / GP300)",
    logins: ["BB55103", "GP300"],
    agentHints: ["MOOSEM", "GPRO50RSK"],
  },
  {
    id: "tier5_miami_syndicate",
    label: "Miami 172.56.42.91 Trio + DAN245",
    logins: ["MM800", "CB112_1", "CB100_1", "SYN404", "DAN245"],
    agentHints: ["MOOSEM", "DAN318"],
  },
  {
    id: "tier6_clv_signal_donors",
    label: "CLV-Positive Signal Donors",
    logins: ["ABN18", "BRT5600", "BRT5603_0"],
    agentHints: ["ADRIANBRAN", "TEXAS50"],
  },
  {
    id: "tier7_correlated_parlay_extractors",
    label: "Correlated Parlay & Live Omega Extractors",
    logins: ["BCC1530", "BCC100", "BGD101", "G440", "G441"],
    agentHints: ["SPEN", "BIGDAD", "G4T"],
  },
];

const LOGIN_TO_TIER: ReadonlyMap<string, WeightTierId> = (() => {
  const map = new Map<string, WeightTierId>();
  for (const tier of WEIGHT_TIER_DEFINITIONS) {
    for (const login of tier.logins) {
      map.set(login.toUpperCase(), tier.id);
    }
  }
  return map;
})();

export function normalizeCustomerLogin(value: string): string {
  return value.trim().toUpperCase();
}

export function resolveWeightTierForLogin(
  login: string,
): WeightTierDefinition | null {
  const id = LOGIN_TO_TIER.get(normalizeCustomerLogin(login));
  if (id === undefined) return null;
  return WEIGHT_TIER_DEFINITIONS.find((tier) => tier.id === id) ?? null;
}

export interface InternalLineStepCommand {
  readonly kind: "internal_line_step";
  readonly layerId: "L20.N1105" | "L22.N1402";
  readonly steer: boolean;
  readonly stepPoints: number;
  readonly vigCurtainCents: number | null;
  readonly blockKeyCrossing: boolean;
  readonly wagerType: string;
  readonly shortDescLegCount: number;
  readonly slaTargetMs: number;
  readonly note: string;
}

export interface ManagerUpdateByColumnDraft {
  readonly kind: "manager_update_by_column";
  readonly operation: "updateByColumn";
  readonly customerID: string;
  readonly agentID: string;
  readonly column: string;
  readonly value: string;
  readonly note: string;
}

export type ExternalVenue = "polymarket" | "kalshi";

export interface ExternalMarketOrderDraft {
  readonly kind: "external_market_order";
  readonly venue: ExternalVenue;
  readonly role: "maker" | "taker";
  readonly silo: "silo1_core" | "silo2_period_rfq" | "silo3_shadow_mirror";
  readonly notionalUsdCap: number;
  readonly hedgeMultiplier: number;
  readonly slippageCapCents: number;
  readonly twapSlices: number;
  readonly twapWindowSec: number;
  readonly signatureStatus: "unsigned_draft";
  readonly signingHintEnv: readonly string[];
  readonly note: string;
  /** Venue-native POST body skeleton; token/ticker resolved downstream. */
  readonly wireDraft: Record<string, unknown>;
}

export interface StreamSignalEmission {
  readonly schemaVersion: typeof WEIGHT_TIER_SCHEMA_VERSION;
  readonly emittedAt: string;
  readonly tier: WeightTierId;
  readonly tierLabel: string;
  readonly triggerLogin: string;
  readonly agentId: string;
  readonly wagerNumber: string;
  readonly wagerType: string;
  readonly ticketWriter: string;
  readonly amountWagered: number | null;
  readonly internal: readonly InternalLineStepCommand[];
  readonly manager: readonly ManagerUpdateByColumnDraft[];
  readonly external: readonly ExternalMarketOrderDraft[];
  readonly diagnostics: StreamSignalDiagnostics;
}

export interface StreamSignalPlannerContext {
  readonly clusterTracker?: MiamiSyndicateClusterTracker;
  readonly pickTwinTracker?: PickShapeTwinTracker;
  readonly scoutTracker?: ScoutApexTracker;
  readonly dod6Book?: Dod6CustomerBookOverlay | null;
}

export interface SyndicateClusterState {
  readonly rotationKey: string;
  readonly logins: readonly string[];
  readonly firstSeenMs: number;
  readonly lastSeenMs: number;
}

/** Tracks tier-5 same-rotation hits within a sliding window (default 120s). */
export class MiamiSyndicateClusterTracker {
  private readonly windowMs: number;
  private readonly hits = new Map<
    string,
    { logins: Set<string>; firstMs: number; lastMs: number }
  >();

  constructor(windowMs = 120_000) {
    this.windowMs = windowMs;
  }

  record(
    login: string,
    rotationKey: string,
    atMs: number,
  ): SyndicateClusterState | null {
    const normalized = normalizeCustomerLogin(login);
    const key = rotationKey.trim() === "" ? "unknown" : rotationKey.trim();
    const existing = this.hits.get(key);
    if (existing === undefined) {
      this.hits.set(key, {
        logins: new Set([normalized]),
        firstMs: atMs,
        lastMs: atMs,
      });
      return null;
    }
    existing.logins.add(normalized);
    existing.lastMs = atMs;
    this.prune(atMs);
    if (
      existing.logins.size >= 2 &&
      existing.lastMs - existing.firstMs <= this.windowMs
    ) {
      return {
        rotationKey: key,
        logins: [...existing.logins],
        firstSeenMs: existing.firstMs,
        lastSeenMs: existing.lastMs,
      };
    }
    return null;
  }

  private prune(nowMs: number): void {
    for (const [key, bucket] of this.hits) {
      if (nowMs - bucket.lastMs > this.windowMs) this.hits.delete(key);
    }
  }
}

function isProbeStake(amountWagered: number | null): boolean {
  if (amountWagered === null) return false;
  return amountWagered >= 150 && amountWagered <= 250;
}

function baseExternalDraft(
  venue: ExternalVenue,
  role: "maker" | "taker",
  silo: ExternalMarketOrderDraft["silo"],
  note: string,
  overrides: Partial<
    Pick<
      ExternalMarketOrderDraft,
      | "notionalUsdCap"
      | "hedgeMultiplier"
      | "slippageCapCents"
      | "twapSlices"
      | "twapWindowSec"
    >
  > = {},
): ExternalMarketOrderDraft {
  const signingHintEnv =
    venue === "polymarket"
      ? ([
          "POLYMARKET_API_KEY",
          "POLYMARKET_API_SECRET",
          "POLYMARKET_PASSPHRASE",
        ] as const)
      : (["KALSHI_API_KEY_ID", "KALSHI_PRIVATE_KEY_PEM"] as const);
  return {
    kind: "external_market_order",
    venue,
    role,
    silo,
    notionalUsdCap: overrides.notionalUsdCap ?? 37_500,
    hedgeMultiplier: overrides.hedgeMultiplier ?? 1,
    slippageCapCents: overrides.slippageCapCents ?? 2,
    twapSlices: overrides.twapSlices ?? 4,
    twapWindowSec: overrides.twapWindowSec ?? 45,
    signatureStatus: "unsigned_draft",
    signingHintEnv,
    note,
    wireDraft:
      venue === "polymarket"
        ? polymarketClobOrderSkeleton(role)
        : kalshiOrderSkeleton(role),
  };
}

function routingTagForTier(
  tierId: WeightTierId,
  wagerType: string,
  scoutPrecursor: ScoutPrecursorHit | null,
): string | null {
  if (tierId === "tier1_apex_spread_ml" && wagerType !== "L") {
    return scoutPrecursor !== null ? "ANOM-01_SCOUT_CONFIRMED" : "ANOM-01";
  }
  if (tierId === "tier2_blindspot_clv_whales") return "SILO3_SHADOW_MIRROR";
  if (tierId === "tier3_probe_hammer_syndicate") return "PROBE_HAMMER_2STAGE";
  if (tierId === "tier5_miami_syndicate") return "MIAMI_SYNDICATE_CLUSTER";
  if (tierId === "tier7_correlated_parlay_extractors") return "PROBIT_SGP_PENALTY";
  return null;
}

function lineStep(
  partial: Omit<InternalLineStepCommand, "kind">,
): InternalLineStepCommand {
  return { kind: "internal_line_step", ...partial };
}

/**
 * Pure planner: one ticker row → zero or one emission (tiers 1–7). Pass a cluster tracker when
 * tier-5 syndicate multiplier rules should apply across consecutive rows.
 */
export function planStreamSignalForRow(
  row: F402TickerRow,
  options: {
    readonly emittedAt?: string;
    readonly clusterTracker?: MiamiSyndicateClusterTracker;
    readonly pickTwinTracker?: PickShapeTwinTracker;
    readonly scoutTracker?: ScoutApexTracker;
    readonly dod6Book?: Dod6CustomerBookOverlay | null;
  } = {},
): StreamSignalEmission | null {
  const tierDef = resolveWeightTierForLogin(row.login);
  if (tierDef === null) return null;

  const emittedAt = options.emittedAt ?? new Date().toISOString();
  const insertedMs = Date.parse(row.insertedAt);
  const atMs = Number.isFinite(insertedMs)
    ? insertedMs
    : Number.isFinite(Date.parse(emittedAt))
      ? Date.parse(emittedAt)
      : Date.now();
  const pickShapeTwins = options.pickTwinTracker?.record(row, atMs) ?? [];
  const scoutPrecursor = options.scoutTracker?.record(row, atMs) ?? null;
  const wagerType = row.wagerType.trim().toUpperCase();
  const rotationKey = rotationKeyFromTickerShortDesc(row.shortDesc);
  const parsed = parseShortDesc(row.shortDesc);
  const legCount = parsed.legs.length;
  const routingTag = routingTagForTier(tierDef.id, wagerType, scoutPrecursor);
  const steamInstant =
    (row.ticketWriter.toUpperCase() === "GSLIVE" && parsed.isLive) ||
    row.ticketWriter.toUpperCase() === "ALERT";
  const slaTargetOverride = steamInstant ? 250 : 500;

  const internal: InternalLineStepCommand[] = [];
  const manager: ManagerUpdateByColumnDraft[] = [];
  const external: ExternalMarketOrderDraft[] = [];

  const paddedCustomer = padCustomerIdCanonical(row.login);
  const agent =
    row.agentId.trim() === "" ? row.agentLogin.trim() : row.agentId.trim();

  switch (tierDef.id) {
    case "tier1_apex_spread_ml": {
      if (row.login.toUpperCase() === "WC8406") {
        internal.push(
          lineStep({
            layerId: "L22.N1402",
            steer: true,
            stepPoints: 0,
            vigCurtainCents: 10,
            blockKeyCrossing: false,
            wagerType,
            shortDescLegCount: legCount,
            slaTargetMs: slaTargetOverride,
            note: "Scout pre-shade NFL/NBA spread −10c before GX195 apex hit",
          }),
        );
        break;
      }
      if (wagerType === "L") {
        internal.push(
          lineStep({
            layerId: "L20.N1105",
            steer: false,
            stepPoints: 0,
            vigCurtainCents: null,
            blockKeyCrossing: false,
            wagerType,
            shortDescLegCount: legCount,
            slaTargetMs: 250,
            note: "Hold 100% GX195 totals internally — no external mirror (known totals loser)",
          }),
        );
        break;
      }
      if (wagerType === "S" || wagerType === "M") {
        internal.push(
          lineStep({
            layerId: "L22.N1402",
            steer: true,
            stepPoints: 1,
            vigCurtainCents: 20,
            blockKeyCrossing: false,
            wagerType,
            shortDescLegCount: legCount,
            slaTargetMs: 250,
            note: "Step spread 1.0 pt behind −125/−125 vig curtain on GX195 spread/ML",
          }),
        );
        external.push(
          baseExternalDraft(
            "polymarket",
            "taker",
            "silo1_core",
            "ANOM-01 split: 1.0× taker sweep main line (<500ms)",
            { notionalUsdCap: 150_000, hedgeMultiplier: 1 },
          ),
          baseExternalDraft(
            "kalshi",
            "taker",
            "silo1_core",
            "ANOM-01 split: 1.0× taker sweep main line (<500ms)",
            { notionalUsdCap: 150_000, hedgeMultiplier: 1 },
          ),
        );
      }
      break;
    }
    case "tier2_blindspot_clv_whales": {
      internal.push(
        lineStep({
          layerId: "L20.N1105",
          steer: true,
          stepPoints: 0.75,
          vigCurtainCents: null,
          blockKeyCrossing: false,
          wagerType,
          shortDescLegCount: legCount,
          slaTargetMs: 250,
          note: "EP-03 bet-ticker confirm: step NBA/NFL/1H lines 0.5–1.0 pt",
        }),
      );
      external.push(
        baseExternalDraft(
          "kalshi",
          "taker",
          "silo3_shadow_mirror",
          "Shadow-mirror straight pick (4-slice 45s TWAP, ≤2c slippage)",
        ),
        baseExternalDraft(
          "polymarket",
          "taker",
          "silo3_shadow_mirror",
          "Shadow-mirror straight pick (4-slice 45s TWAP, ≤2c slippage)",
        ),
      );
      break;
    }
    case "tier3_probe_hammer_syndicate": {
      if (
        row.login.toUpperCase() === "AT811" &&
        isProbeStake(row.amountWagered)
      ) {
        internal.push(
          lineStep({
            layerId: "L22.N1402",
            steer: true,
            stepPoints: 1,
            vigCurtainCents: null,
            blockKeyCrossing: false,
            wagerType,
            shortDescLegCount: legCount,
            slaTargetMs: 250,
            note: "Probe: reprice 1H/FG total 0.5–1.5 pt before hammer",
          }),
        );
        external.push(
          baseExternalDraft(
            "kalshi",
            "maker",
            "silo2_period_rfq",
            "Stage-1: skew resting maker quotes +15c on totals",
            { hedgeMultiplier: 1 },
          ),
        );
      } else if (
        row.login.toUpperCase() === "AT10359" ||
        row.login.toUpperCase() === "BB5127"
      ) {
        internal.push(
          lineStep({
            layerId: "L22.N1402",
            steer: true,
            stepPoints: 1.25,
            vigCurtainCents: null,
            blockKeyCrossing: false,
            wagerType,
            shortDescLegCount: legCount,
            slaTargetMs: 250,
            note: "Hammer confirm: finalize internal total step",
          }),
        );
        external.push(
          baseExternalDraft(
            "polymarket",
            "taker",
            "silo2_period_rfq",
            "Stage-2: cross book as taker after probe→hammer chain",
          ),
        );
      }
      break;
    }
    case "tier4_college_steam": {
      internal.push(
        lineStep({
          layerId: "L22.N1402",
          steer: true,
          stepPoints: 1,
          vigCurtainCents: 20,
          blockKeyCrossing: false,
          wagerType,
          shortDescLegCount: legCount,
          slaTargetMs: 250,
          note: "Instant 1.0 pt steam step on NCAA/NBA derivative",
        }),
      );
      external.push(
        baseExternalDraft(
          "polymarket",
          "taker",
          "silo2_period_rfq",
          "Taker sweep CFB/NBA key-6 / college steam originator",
        ),
      );
      break;
    }
    case "tier5_miami_syndicate": {
      internal.push(
        lineStep({
          layerId: "L22.N1402",
          steer: true,
          stepPoints: 0.5,
          vigCurtainCents: null,
          blockKeyCrossing: true,
          wagerType,
          shortDescLegCount: legCount,
          slaTargetMs: 250,
          note: "Block Key-3/7 crossings; step live 2H/3Q spread 0.5 pt",
        }),
      );
      const cluster = options.clusterTracker?.record(
        row.login,
        rotationKey,
        atMs,
      );
      const multiplier = cluster !== null && cluster !== undefined ? 3 : 1;
      external.push(
        baseExternalDraft(
          "polymarket",
          "taker",
          "silo2_period_rfq",
          cluster !== null && cluster !== undefined
            ? `Syndicate cluster (≥2 wallets / ${rotationKey} / 120s): hedgeMultiplier 3.0×`
            : "Single-wallet Miami syndicate taker (await cluster for 3.0×)",
          { hedgeMultiplier: multiplier, notionalUsdCap: 62_500 },
        ),
      );
      break;
    }
    case "tier6_clv_signal_donors": {
      if (wagerType === "P") {
        manager.push({
          kind: "manager_update_by_column",
          operation: "updateByColumn",
          customerID: paddedCustomer,
          agentID: agent,
          column: "confirmationDelaySeconds",
          value: "0",
          note: "VIP shield: never clamp donors — welcome parlay action",
        });
        break;
      }
      if (wagerType === "S" || wagerType === "L") {
        internal.push(
          lineStep({
            layerId: "L20.N1105",
            steer: true,
            stepPoints: 0.5,
            vigCurtainCents: null,
            blockKeyCrossing: false,
            wagerType,
            shortDescLegCount: legCount,
            slaTargetMs: 250,
            note: "Nudge internal line 0.5 pt toward donor straight side; zero clamp",
          }),
        );
        manager.push({
          kind: "manager_update_by_column",
          operation: "updateByColumn",
          customerID: paddedCustomer,
          agentID: agent,
          column: "confirmationDelaySeconds",
          value: "0",
          note: "Zero-delay VIP shield (5s–8s) for CLV donors",
        });
      }
      break;
    }
    case "tier7_correlated_parlay_extractors": {
      internal.push(
        lineStep({
          layerId: "L22.N1402",
          steer: true,
          stepPoints: 0,
          vigCurtainCents: null,
          blockKeyCrossing: false,
          wagerType,
          shortDescLegCount: legCount,
          slaTargetMs: 250,
          note: "Apply 1.04× probit correlation penalty; live sniper 12s delay tier",
        }),
      );
      manager.push({
        kind: "manager_update_by_column",
        operation: "updateByColumn",
        customerID: paddedCustomer,
        agentID: agent,
        column: "confirmationDelaySeconds",
        value: "12",
        note: "TIER_1_LIVE_SNIPER_12S clamp for G440/BCC100-class omega",
      });
      break;
    }
    default:
      break;
  }

  if (internal.length === 0 && manager.length === 0 && external.length === 0) {
    return null;
  }

  const diagnostics = buildStreamSignalDiagnostics(row, {
    atMs,
    pickShapeTwins,
    scoutPrecursor,
    dod6Book: options.dod6Book ?? null,
    routingTag,
  });

  return {
    schemaVersion: WEIGHT_TIER_SCHEMA_VERSION,
    emittedAt,
    tier: tierDef.id,
    tierLabel: tierDef.label,
    triggerLogin: normalizeCustomerLogin(row.login),
    agentId: agent,
    wagerNumber: row.wagerNumber,
    wagerType,
    ticketWriter: row.ticketWriter,
    amountWagered: row.amountWagered,
    internal,
    manager,
    external,
    diagnostics,
  };
}

/** Dedupe by wager number so replays and ALERT twins emit once per ticket id. */
export function planStreamSignalsForRows(
  rows: readonly F402TickerRow[],
  options: {
    readonly emittedAt?: string;
    readonly clusterTracker?: MiamiSyndicateClusterTracker;
    readonly pickTwinTracker?: PickShapeTwinTracker;
    readonly scoutTracker?: ScoutApexTracker;
    readonly dod6Book?: Dod6CustomerBookOverlay | null;
  } = {},
): readonly StreamSignalEmission[] {
  const seen = new Set<string>();
  const out: StreamSignalEmission[] = [];
  const tracker = options.clusterTracker ?? new MiamiSyndicateClusterTracker();
  const pickTwinTracker =
    options.pickTwinTracker ?? new PickShapeTwinTracker();
  const scoutTracker = options.scoutTracker ?? new ScoutApexTracker();
  for (const row of rows) {
    const key =
      row.wagerNumber.trim() === ""
        ? `${row.login}|${row.insertedAt}|${row.shortDesc.slice(0, 32)}`
        : row.wagerNumber;
    if (seen.has(key)) continue;
    const base = {
      clusterTracker: tracker,
      pickTwinTracker,
      scoutTracker,
      dod6Book: options.dod6Book ?? null,
    };
    const rowOptions =
      options.emittedAt === undefined
        ? base
        : { ...base, emittedAt: options.emittedAt };
    const emission = planStreamSignalForRow(row, rowOptions);
    if (emission === null) continue;
    seen.add(key);
    out.push(emission);
  }
  return out;
}
