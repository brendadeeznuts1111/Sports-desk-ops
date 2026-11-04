/**
 * Cross-layer diagnostics for weight-tier stream signals (DOD6 columnar + Section 11 + ticker).
 *
 * Replay-safe cross-layer signals from bet-ticker rows plus optional DOD6/GSLive overlays.
 */
// Sync enrichment path: callers are pure sync transforms.
// ast-grep-ignore: node-fs-read-write-file
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Dod6LifetimeLookup } from "./dod6_spine_overlay.ts";
import type { GsliveSteamHit } from "./gslive_steam_index.ts";
import { circuitScoreFromMechanisms } from "./weight_tier_circuit_score.ts";
import type { CircuitScoreBreakdown } from "./weight_tier_circuit_score.ts";
import type { F402TickerRow } from "./f402_ingest.ts";
import { parseShortDesc } from "./live_wagers.ts";
function normalizeCustomerLogin(value: string): string {
  return value.trim().toUpperCase();
}

export type WeightMechanismId =
  | "sentinel_clv_market_split"
  | "qk_ov_induction_virtual"
  | "bitwise_score_proximity_steam"
  | "rank1_reasoning_loop_sla";

export interface WeightMechanismHit {
  readonly id: WeightMechanismId;
  readonly layer: string;
  readonly signal: string;
  readonly confidenceHundredths: number;
}

export interface PickShapeTwinHit {
  readonly login: string;
  readonly deltaMs: number;
}

export interface ScoutPrecursorHit {
  readonly scoutLogin: string;
  readonly deltaMs: number;
  readonly rotationKey: string;
}

export interface StreamSignalDiagnostics {
  readonly rotationKey: string;
  readonly pickShapeSha256: string;
  readonly pickShapeTwins: readonly PickShapeTwinHit[];
  readonly scoutPrecursor: ScoutPrecursorHit | null;
  readonly steam: {
    readonly gsliveChannel: boolean;
    readonly liveLeg: boolean;
    readonly alertTwinChannel: boolean;
    readonly steamPriority: "instant" | "normal";
  };
  readonly mechanisms: readonly WeightMechanismHit[];
  readonly dod6Overlay: {
    readonly clvBps: number | null;
    readonly sharpScore: number | null;
    readonly lifetimeNetUsd: number | null;
    readonly clvLegs: number | null;
    readonly avgClvPoints: number | null;
    readonly sharpCandidateGatePassed: boolean | null;
    readonly dod6Source: string | null;
  } | null;
  readonly dod6SpineHeader: {
    readonly customerCount: number;
    readonly sectionCount: number;
    readonly asOfEpochDays: number;
  } | null;
  readonly gsliveSteam: {
    readonly timeUntilScoreSec: number;
    readonly word0SteamMask: number;
    readonly partnerUserId: string | null;
  } | null;
  readonly slaBudgetMs: { readonly alert: 250; readonly gsLive: 500 };
  readonly routingTag: string | null;
  readonly section11Circuit: CircuitScoreBreakdown | null;
}

export interface Dod6CustomerBookOverlay {
  lookup(login: string): {
    readonly clvBps: number | null;
    readonly sharpScore: number | null;
    readonly lifetimeNetUsd: number | null;
  } | null;
}

const SMURF_SUFFIX_RE = /_\d+$/;

/** Stable pick-shape hash aligned with combo pick-service semantics (line-agnostic leg keys). */
export function pickShapeSha256FromShortDesc(shortDesc: string): string {
  const parsed = parseShortDesc(shortDesc);
  const keys = parsed.legs
    .map((leg) => {
      const gameKey =
        leg.gameNumber !== null
          ? `#${leg.gameNumber}`
          : leg.game.trim().toLowerCase();
      const market =
        leg.market.trim().toLowerCase() ||
        (leg.compact ? "compact" : "unknown");
      const side = leg.pick.trim().toLowerCase();
      return `${leg.sport}|${gameKey}|${market}|${side}`;
    })
    .sort();
  if (keys.length === 0) {
    return Bun.CryptoHasher.hash("sha256", "empty-pick-shape", "hex");
  }
  return Bun.CryptoHasher.hash("sha256", keys.join(";"), "hex");
}

export function rotationKeyFromTickerShortDesc(shortDesc: string): string {
  const parsed = parseShortDesc(shortDesc);
  if (parsed.legs.length === 0) return "unknown";
  const first = parsed.legs[0]!;
  if (first.gameNumber !== null) return `ROT ${first.gameNumber}`;
  const digits = first.game.match(/\d{3,5}/);
  return digits !== null ? `ROT ${digits[0]}` : first.game.slice(0, 48);
}

/** Repeated pick_shape_sha256 across accounts within 120s (virtual QK/OV induction proxy). */
export class PickShapeTwinTracker {
  private readonly windowMs: number;
  private readonly byHash = new Map<
    string,
    { login: string; atMs: number }[]
  >();

  constructor(windowMs = 120_000) {
    this.windowMs = windowMs;
  }

  record(row: F402TickerRow, atMs: number): readonly PickShapeTwinHit[] {
    const hash = pickShapeSha256FromShortDesc(row.shortDesc);
    const login = normalizeCustomerLogin(row.login);
    const bucket = this.byHash.get(hash) ?? [];
    bucket.push({ login, atMs });
    this.byHash.set(hash, bucket);
    this.prune(atMs);
    const hits: PickShapeTwinHit[] = [];
    for (const entry of bucket) {
      if (entry.login === login) continue;
      const deltaMs = Math.abs(atMs - entry.atMs);
      if (deltaMs <= this.windowMs) {
        hits.push({ login: entry.login, deltaMs });
      }
    }
    return hits;
  }

  private prune(nowMs: number): void {
    for (const [hash, entries] of this.byHash) {
      const kept = entries.filter(
        (entry) => nowMs - entry.atMs <= this.windowMs,
      );
      if (kept.length === 0) this.byHash.delete(hash);
      else this.byHash.set(hash, kept);
    }
  }
}

/** WC8406 scout → GX195 apex within 30s on the same rotation (observed ~29.68s NFL ROT 454). */
export class ScoutApexTracker {
  private readonly windowMs: number;
  private readonly scouts = new Map<string, { atMs: number; login: string }>();

  constructor(windowMs = 30_000) {
    this.windowMs = windowMs;
  }

  record(row: F402TickerRow, atMs: number): ScoutPrecursorHit | null {
    const rotationKey = rotationKeyFromTickerShortDesc(row.shortDesc);
    const login = normalizeCustomerLogin(row.login);
    if (login === "WC8406") {
      this.scouts.set(rotationKey, { atMs, login });
      return null;
    }
    if (login !== "GX195") return null;
    const scout = this.scouts.get(rotationKey);
    if (scout === undefined) return null;
    const deltaMs = atMs - scout.atMs;
    if (deltaMs < 0 || deltaMs > this.windowMs) return null;
    return { scoutLogin: scout.login, deltaMs, rotationKey };
  }
}

export function loadDod6BookOverlayFromJson(
  path: string,
): Dod6CustomerBookOverlay {
  const absolute = resolve(path);
  // Sync enrichment path: callers are pure sync transforms.
  // ast-grep-ignore: node-fs-read-write-file
  const raw = JSON.parse(readFileSync(absolute, "utf8")) as unknown;
  if (!Array.isArray(raw)) {
    throw new Error(`DOD6 book overlay: expected array in ${absolute}`);
  }
  const byLogin = new Map<
    string,
    {
      clvBps: number | null;
      sharpScore: number | null;
      lifetimeNetUsd: number | null;
    }
  >();
  for (const row of raw) {
    if (row === null || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const id = String(record.customer_id ?? record.customerId ?? "").trim();
    if (id === "") continue;
    byLogin.set(normalizeCustomerLogin(id), {
      clvBps: typeof record.clv_bps === "number" ? record.clv_bps : null,
      sharpScore:
        typeof record.sharp_score === "number" ? record.sharp_score : null,
      lifetimeNetUsd:
        typeof record.lifetime_net_usd === "number"
          ? record.lifetime_net_usd
          : null,
    });
  }
  return {
    lookup(login: string) {
      return byLogin.get(normalizeCustomerLogin(login)) ?? null;
    },
  };
}

function inferMechanisms(
  row: F402TickerRow,
  twins: readonly PickShapeTwinHit[],
  scout: ScoutPrecursorHit | null,
  steamPriority: "instant" | "normal",
  gsliveSteam: GsliveSteamHit | null,
  lifetime: Dod6LifetimeLookup | null,
): WeightMechanismHit[] {
  const hits: WeightMechanismHit[] = [];
  const login = normalizeCustomerLogin(row.login);

  if (lifetime !== null) {
    const clvSignal =
      lifetime.clvBps !== null
        ? `clv_bps=${lifetime.clvBps}`
        : lifetime.avgClvPoints !== null
          ? `clv_pts=${lifetime.avgClvPoints}`
          : `clv_legs=${lifetime.clvLegs}`;
    hits.push({
      id: "sentinel_clv_market_split",
      layer: "Word1_clvDeltaBps16 / 02_LIFETIME_SOA",
      signal: lifetime.sharpCandidateGatePassed
        ? `${clvSignal};gate>=${3}_legs`
        : `${clvSignal};gate_failed`,
      confidenceHundredths: lifetime.sharpCandidateGatePassed
        ? Math.min(
            100,
            Math.max(
              40,
              Math.abs(
                lifetime.clvBps ??
                  Math.round((lifetime.avgClvPoints ?? 0) * 100),
              ),
            ),
          )
        : 35,
    });
  } else {
    hits.push({
      id: "sentinel_clv_market_split",
      layer: "Word1_clvDeltaBps16 / 02_LIFETIME_SOA",
      signal: "tier_login_watchlist (no DOD6 overlay)",
      confidenceHundredths: 55,
    });
  }

  const smurf = SMURF_SUFFIX_RE.test(login);
  if (twins.length > 0 || smurf) {
    hits.push({
      id: "qk_ov_induction_virtual",
      layer: "Exp3 TransformerCircuitInductionStore / L21.N0884",
      signal:
        twins.length > 0
          ? `pick_shape_twin_count=${twins.length}`
          : "smurf_suffix_login",
      confidenceHundredths: twins.length > 0 ? 85 : 60,
    });
  }

  if (gsliveSteam !== null && gsliveSteam.flags.word0SteamMask !== 0) {
    hits.push({
      id: "bitwise_score_proximity_steam",
      layer: "Word0_0x00006E00 / Word2_tusByte / L22.N1402",
      signal: `tus=${gsliveSteam.entry.timeUntilScoreSec}s;mask=0x${gsliveSteam.flags.word0SteamMask.toString(16)}`,
      confidenceHundredths: gsliveSteam.flags.within5s ? 95 : 88,
    });
  } else if (steamPriority === "instant") {
    hits.push({
      id: "bitwise_score_proximity_steam",
      layer: "Word0_0x00006E00 / Word2_tusByte / L22.N1402",
      signal: "gslive_or_alert_live_steam",
      confidenceHundredths: 90,
    });
  }

  hits.push({
    id: "rank1_reasoning_loop_sla",
    layer: "Exp8 L15/L19 rank-1 ablation + Exp4 policy bypass",
    signal: "alert_250ms_gslive_500ms_budget",
    confidenceHundredths: 75,
  });

  if (scout !== null) {
    hits.push({
      id: "qk_ov_induction_virtual",
      layer: "Scout→Apex cross-agent sync",
      signal: `${scout.scoutLogin}_to_${login}_deltaMs=${scout.deltaMs}`,
      confidenceHundredths: 92,
    });
  }

  return hits;
}

function bookRowToLifetime(
  row: NonNullable<ReturnType<Dod6CustomerBookOverlay["lookup"]>>,
): Dod6LifetimeLookup {
  return {
    clvBps: row.clvBps,
    sharpScore: row.sharpScore,
    lifetimeNetUsd: row.lifetimeNetUsd,
    clvLegs: 0,
    avgClvPoints: row.clvBps !== null ? row.clvBps / 100 : null,
    sharpCandidateGatePassed: false,
    source: "json_book",
  };
}

export function buildStreamSignalDiagnostics(
  row: F402TickerRow,
  options: {
    readonly atMs: number;
    readonly pickShapeTwins?: readonly PickShapeTwinHit[];
    readonly scoutPrecursor?: ScoutPrecursorHit | null;
    readonly dod6Book?: Dod6CustomerBookOverlay | null;
    readonly dod6Lifetime?: Dod6LifetimeLookup | null;
    readonly dod6SpineHeader?: StreamSignalDiagnostics["dod6SpineHeader"];
    readonly gsliveSteam?: GsliveSteamHit | null;
    readonly routingTag?: string | null;
  },
): StreamSignalDiagnostics {
  const parsed = parseShortDesc(row.shortDesc);
  const writer = row.ticketWriter.trim().toUpperCase();
  const gsliveChannel = writer === "GSLIVE" || writer === "GSBUILDER";
  const alertTwinChannel = writer === "ALERT";
  const liveLeg = parsed.isLive || parsed.legs.some((leg) => leg.live);
  const gsliveSteam = options.gsliveSteam ?? null;
  const steamPriority: "instant" | "normal" =
    (gsliveSteam !== null && gsliveSteam.flags.word0SteamMask !== 0) ||
    (gsliveChannel && liveLeg) ||
    alertTwinChannel
      ? "instant"
      : "normal";

  const pickShapeSha256 = pickShapeSha256FromShortDesc(row.shortDesc);
  const rotationKey = rotationKeyFromTickerShortDesc(row.shortDesc);
  const pickShapeTwins = options.pickShapeTwins ?? [];
  const scoutPrecursor = options.scoutPrecursor ?? null;
  const bookRow = options.dod6Book?.lookup(row.login) ?? null;
  const lifetime =
    options.dod6Lifetime ??
    (bookRow !== null ? bookRowToLifetime(bookRow) : null);

  const dod6Overlay =
    lifetime === null
      ? null
      : {
          clvBps: lifetime.clvBps,
          sharpScore: lifetime.sharpScore,
          lifetimeNetUsd: lifetime.lifetimeNetUsd,
          clvLegs: lifetime.clvLegs,
          avgClvPoints: lifetime.avgClvPoints,
          sharpCandidateGatePassed: lifetime.sharpCandidateGatePassed,
          dod6Source: lifetime.source,
        };

  const mechanisms = inferMechanisms(
    row,
    pickShapeTwins,
    scoutPrecursor,
    steamPriority,
    gsliveSteam,
    lifetime,
  );

  return {
    rotationKey,
    pickShapeSha256,
    pickShapeTwins,
    scoutPrecursor,
    steam: {
      gsliveChannel,
      liveLeg,
      alertTwinChannel,
      steamPriority,
    },
    mechanisms,
    section11Circuit: circuitScoreFromMechanisms(mechanisms),
    dod6Overlay,
    dod6SpineHeader: options.dod6SpineHeader ?? null,
    gsliveSteam:
      gsliveSteam === null
        ? null
        : {
            timeUntilScoreSec: gsliveSteam.entry.timeUntilScoreSec,
            word0SteamMask: gsliveSteam.flags.word0SteamMask,
            partnerUserId: gsliveSteam.entry.partnerUserId,
          },
    slaBudgetMs: { alert: 250, gsLive: 500 },
    routingTag: options.routingTag ?? null,
  };
}

export function polymarketClobOrderSkeleton(
  role: "maker" | "taker",
): Record<string, unknown> {
  return {
    orderType: role === "taker" ? "FOK" : "GTC",
    tokenID: "<UNRESOLVED_FROM_GAMMA_OR_COMBO_MAP>",
    price: "<from_fair_prob_or_book_walk>",
    size: "<from_silo_notional_cap>",
    feeRateBps: 0,
    nonce: "<operator_mint>",
    signature: "<unsigned>",
  };
}

export function kalshiOrderSkeleton(
  role: "maker" | "taker",
): Record<string, unknown> {
  return {
    action: role === "taker" ? "buy" : "buy",
    client_order_id: "<uuid>",
    count: "<contracts_from_notional>",
    side: "yes",
    ticker: "<UNRESOLVED_FROM_KALSHI_EVENT_MAP>",
    type: role === "taker" ? "limit" : "limit",
    yes_price: "<cents_from_book>",
  };
}

export function explainDiagnostics(
  diagnostics: StreamSignalDiagnostics,
): string {
  const lines = [
    `rotation=${diagnostics.rotationKey} pick_shape=${diagnostics.pickShapeSha256.slice(0, 12)}…`,
    `steam=${diagnostics.steam.steamPriority} (gslive=${diagnostics.steam.gsliveChannel} liveLeg=${diagnostics.steam.liveLeg} alert=${diagnostics.steam.alertTwinChannel})`,
  ];
  if (diagnostics.scoutPrecursor !== null) {
    lines.push(
      `scout→apex ${diagnostics.scoutPrecursor.scoutLogin} +${diagnostics.scoutPrecursor.deltaMs}ms on ${diagnostics.scoutPrecursor.rotationKey}`,
    );
  }
  if (diagnostics.pickShapeTwins.length > 0) {
    lines.push(
      `pick_shape_twins=${diagnostics.pickShapeTwins.map((t) => `${t.login}@${t.deltaMs}ms`).join(",")}`,
    );
  }
  if (diagnostics.dod6Overlay !== null) {
    lines.push(
      `dod6 clv_bps=${diagnostics.dod6Overlay.clvBps ?? "—"} legs=${diagnostics.dod6Overlay.clvLegs ?? "—"} gate=${diagnostics.dod6Overlay.sharpCandidateGatePassed ?? "—"}`,
    );
  }
  if (diagnostics.gsliveSteam !== null) {
    lines.push(
      `gslive tus=${diagnostics.gsliveSteam.timeUntilScoreSec}s mask=0x${diagnostics.gsliveSteam.word0SteamMask.toString(16)}`,
    );
  }
  if (diagnostics.section11Circuit !== null) {
    lines.push(
      `circuit_score=${diagnostics.section11Circuit.scoreHundredths} (ind=${diagnostics.section11Circuit.inductionHundredths} steam=${diagnostics.section11Circuit.steamHundredths} clv=${diagnostics.section11Circuit.clvHundredths})`,
    );
  }
  lines.push(`mechanisms=${diagnostics.mechanisms.map((m) => m.id).join(",")}`);
  if (diagnostics.routingTag !== null) {
    lines.push(`routing=${diagnostics.routingTag}`);
  }
  return lines.join(" | ");
}
