/**
 * @file packages/backend/src/wagers.ts
 * @description Live wager normalization and risk classification (`autoExecute: false`).
 */

import { basename, relative, resolve } from "node:path";
import type {
  DashboardSourceProvenance,
  LiveWagersClvSummary,
  WagerTier,
} from "@sportsdesk-ops/contracts";
import { BoundedStampCache, statStamp } from "./cache.ts";

export interface ParsedShortDescLeg {
  readonly sport?: string | undefined;
  readonly game?: string | undefined;
  readonly pick?: string | undefined;
}

export interface ParsedShortDescLike {
  readonly isLive?: boolean | undefined;
  readonly legs: readonly ParsedShortDescLeg[];
}

export function isSentinelTickerWriter(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  const normalized = raw.trim().toUpperCase();
  return normalized === "ALERT" || normalized === "BLOCKED";
}

export interface ProjectedDevWagerRow {
  readonly ticketId: string;
  readonly timestamp: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly ticketWriter: string;
  readonly sport: string;
  /** Operator label derived from {@link ProjectedDevWagerRow.wagerTypeCode}. */
  readonly betType: string;
  /**
   * Raw wire `WagerType`, upper-cased and trimmed, preserved so the derivation
   * is auditable. The wire value is never rewritten; `betType` is a separate
   * declared projection of it.
   */
  readonly wagerTypeCode: string;
  /** True when the wire carried a code the projection cannot label statically. */
  readonly unknownWagerType: boolean;
  readonly event: string;
  readonly selection: string;
  readonly lineDisplay: string;
  readonly oddsAmerican: string;
  /**
   * `1` for a straight ticket, the parsed leg count for a multi-leg ticket. The wire
   * `WagerType` can say `S` (Spread) on a ticket whose description carries four legs, so the
   * leg count is the ticket shape and `wagerTypeCode` stays the raw label.
   */
  readonly legCount: number;
  readonly riskUsd: number;
  readonly volumeUsd: number;
  readonly toWinUsd: number;
  /** Real CLV in cents, or null when no closing-line comparison exists. */
  readonly clvCents: number | null;
  /** Customer book-level CLV in basis points from book/cohort lookup (distinct from ticket clvCents). */
  readonly customerClvBps?: number | null;
  /** Customer composite sharp score from book/cohort lookup (0-100). */
  readonly customerSharpScore?: number | null;
  readonly vip: boolean;
  readonly isSentinelNoise: boolean;
  readonly alertTier: WagerTier;
  readonly alertBadge: string;
  readonly operatorDirective: string;
  readonly maxRecommendedStake: number;
  readonly autoExecute: false;
}

export interface LiveWagersPayload {
  readonly wagers: ReadonlyArray<Record<string, unknown>>;
  readonly totalRiskUsd: number;
  readonly totalToWinUsd: number;
  readonly criticalSteamCount: number;
  readonly autoExecute: false;
  readonly timestamp: string;
  readonly provenance: DashboardSourceProvenance;
  /** Host-supplied raw-row conformance check (see lib/wagers_wire_contract.ts). */
  readonly wire_contract?: unknown;
  /** Host-supplied slab policy summary (see config/slab.toml). */
  readonly slab_policy?: unknown;
  /** Aggregate ticket & book-level CLV summary across the projected wagers. */
  readonly clvSummary?: LiveWagersClvSummary;
}

export interface CustomerBookWagerMeta {
  readonly clvBps: number | null;
  readonly sharpScore: number | null;
}

export interface ProjectLiveWagerDeps {
  readonly parseShortDesc: (raw: unknown) => ParsedShortDescLike;
  readonly sharpCustomerIds: ReadonlySet<string>;
  readonly customerBookLookup?: (
    customerId: string,
  ) => CustomerBookWagerMeta | null;
}

/** Normalize a raw live-wager record and classify its surveillance directive (`autoExecute: false`). */
export function projectLiveWagerRow(
  item: Record<string, unknown>,
  idx: number,
  deps: ProjectLiveWagerDeps,
): ProjectedDevWagerRow & Record<string, unknown> {
  const rawDesc = item.ShortDesc ?? item.shortDesc ?? item.description ?? "";
  const parsed = deps.parseShortDesc(rawDesc);
  const firstLeg = parsed.legs[0];
  const customerId = String(
    item.CustomerID ??
      item.customerId ??
      item.Login ??
      item.login ??
      `CUST-${idx}`,
  ).trim();
  const riskUsd = Number(
    item.AmountWagered ?? item.amountWagered ?? item.riskUsd ?? 500,
  );
  const toWinUsd = Number(
    item.ToWinAmount ??
      item.toWinUsd ??
      item.toWinAmount ??
      Math.round(riskUsd * 0.9),
  );
  const isSharp = deps.sharpCustomerIds.has(customerId.toUpperCase());
  // No invented CLV: a row without an explicit closing-line comparison reports null.
  const clvCents =
    typeof item.clvCents === "number" && Number.isFinite(item.clvCents)
      ? item.clvCents
      : null;
  const legCount = Math.max(1, parsed.legs.length);
  const wireLegCount = Number(item.ItemCount ?? item.NumLegs ?? item.LegCount);
  const isMultiLeg =
    legCount > 1 || (Number.isFinite(wireLegCount) && wireLegCount > 1);

  let alertTier: WagerTier = "RECREATIONAL";
  let alertBadge = "✅ RECREATIONAL";
  let operatorDirective = "Accept Normal (autoExecute: false)";
  let maxRecommendedStake = 25000;

  if ((clvCents !== null && clvCents >= 10) || isSharp) {
    alertTier = "CRITICAL";
    alertBadge = isSharp
      ? "🚨 CRITICAL (T1 Originator)"
      : "🚨 CRITICAL (High CLV)";
    operatorDirective = "Clamp Max $250 (autoExecute: false)";
    maxRecommendedStake = 250;
  } else if (clvCents !== null && clvCents >= 5) {
    alertTier = "STEAM";
    alertBadge = "⚡ STEAM (Line Mover)";
    operatorDirective = "Clamp Max $500 (autoExecute: false)";
    maxRecommendedStake = 500;
  } else if (parsed.isLive || Boolean(item.live)) {
    alertTier = "LATENCY";
    alertBadge = "⚠️ LATENCY (In-Play)";
    operatorDirective = "Delay 3s + Cap $1,000 (autoExecute: false)";
    maxRecommendedStake = 1000;
  }

  // The cap is a floor, not decoration: a ticket above it never keeps "Accept Normal".
  const oversize = Number.isFinite(riskUsd) && riskUsd > maxRecommendedStake;
  if (oversize) {
    operatorDirective = `Oversize: $${riskUsd.toLocaleString("en-US")} > cap $${maxRecommendedStake.toLocaleString("en-US")} — manual review (autoExecute: false)`;
    alertBadge = `${alertBadge} · OVERSIZE`;
  }

  const ticketWriter =
    typeof item.TicketWriter === "string" && item.TicketWriter.trim() !== ""
      ? item.TicketWriter.trim()
      : typeof item.ticketWriter === "string" && item.ticketWriter.trim() !== ""
        ? item.ticketWriter.trim()
        : typeof item.writer === "string" && item.writer.trim() !== ""
          ? item.writer.trim()
          : "Internet";
  const sentinelNoise = isSentinelTickerWriter(ticketWriter);
  const rawVolume = Number(
    item.VolumeAmount ?? item.volumeAmount ?? item.volumeUsd ?? riskUsd,
  );
  const volumeUsd = Number.isFinite(rawVolume) ? rawVolume : riskUsd;
  const vip =
    item.VIP === true ||
    item.vip === true ||
    String(item.VIP ?? "").trim() === "1";
  const wagerTypeProjection = projectWagerType(item);

  return {
    ticketId: String(item.WagerNumber ?? item.ticketId ?? `W-${109280 + idx}`),
    timestamp:
      typeof item.InsertDateTime === "string" ||
      typeof item.InsertDateTime === "number"
        ? new Date(item.InsertDateTime).toLocaleTimeString() + " ET"
        : String(item.timestamp ?? "14:30:00 ET"),
    customerId,
    agentId: String(item.AgentID ?? item.agentId ?? "AG01").trim(),
    masterAgent: String(
      item.AgentLogin ?? item.masterAgent ?? "MASTER_A",
    ).trim(),
    ticketWriter,
    sport: String(
      firstLeg?.sport?.toUpperCase() ||
        (item.sport === undefined || item.sport === null
          ? ""
          : String(item.sport).toUpperCase()),
    ),
    subSport: (() => {
      const rawSubSport = item.SubSport ?? item.subSport ?? item.SportSubType;
      const normalized =
        rawSubSport === undefined || rawSubSport === null
          ? ""
          : String(rawSubSport).trim();
      return normalized === "" ? null : normalized.toUpperCase();
    })(),
    // Declared projection of the raw wire code, not a rewrite of it:
    // `wagerTypeCode` keeps what the vendor sent, `betType` is the label. A multi-leg ticket
    // is labelled from its legs, because the wire code can describe only one of them.
    ...(isMultiLeg
      ? {
          ...wagerTypeProjection,
          betType: "Parlay",
          unknownWagerType: false,
        }
      : wagerTypeProjection),
    legCount,
    event: isMultiLeg
      ? `${legCount}-leg parlay`
      : String(firstLeg?.game || (item.event ?? "Event Matchup")),
    selection: isMultiLeg
      ? `${legCount} legs`
      : String(firstLeg?.pick || (item.selection ?? "Selection")),
    lineDisplay: isMultiLeg
      ? "—"
      : String(firstLeg?.pick || (item.lineDisplay ?? "ML")),
    oddsAmerican:
      typeof item.oddsAmerican === "string" && item.oddsAmerican.trim() !== ""
        ? item.oddsAmerican
        : (impliedAmericanOdds(riskUsd, toWinUsd) ?? "—"),
    riskUsd,
    volumeUsd,
    toWinUsd,
    clvCents,
    ...((): {
      readonly customerClvBps?: number | null;
      readonly customerSharpScore?: number | null;
    } => {
      const bookMeta = customerId
        ? (deps.customerBookLookup?.(customerId) ?? null)
        : null;
      if (bookMeta === null) return {};
      return {
        customerClvBps: bookMeta.clvBps,
        customerSharpScore: bookMeta.sharpScore,
      };
    })(),
    vip,
    isSentinelNoise: sentinelNoise,
    alertTier,
    alertBadge,
    operatorDirective,
    maxRecommendedStake,
    autoExecute: false as const,
  };
}

/** Compute separate ticket-level and customer-book CLV summaries without mixing them. */
export function summarizeWagersClv(
  wagers: ReadonlyArray<Record<string, unknown>>,
): LiveWagersClvSummary {
  let ticketClvCount = 0;
  let ticketClvSum = 0;
  let bookMatchedCount = 0;
  let bookClvSum = 0;
  let positiveCustomerClvCount = 0;
  let negativeCustomerClvCount = 0;
  let totalPositiveClvRiskUsd = 0;
  let totalNegativeClvRiskUsd = 0;

  for (const w of wagers) {
    const ticketClv = w.clvCents;
    if (typeof ticketClv === "number" && Number.isFinite(ticketClv)) {
      ticketClvCount += 1;
      ticketClvSum += ticketClv;
    }
    const custClv = w.customerClvBps;
    if (typeof custClv === "number" && Number.isFinite(custClv)) {
      bookMatchedCount += 1;
      bookClvSum += custClv;
      const risk = Number(w.riskUsd);
      const safeRisk = Number.isFinite(risk) ? risk : 0;
      if (custClv > 0) {
        positiveCustomerClvCount += 1;
        totalPositiveClvRiskUsd += safeRisk;
      } else if (custClv < 0) {
        negativeCustomerClvCount += 1;
        totalNegativeClvRiskUsd += safeRisk;
      }
    }
  }

  return {
    ticketClvCount,
    meanTicketClvCents:
      ticketClvCount > 0
        ? Math.round((ticketClvSum / ticketClvCount) * 10) / 10
        : null,
    bookMatchedCount,
    meanCustomerClvBps:
      bookMatchedCount > 0
        ? Math.round((bookClvSum / bookMatchedCount) * 10) / 10
        : null,
    positiveCustomerClvCount,
    negativeCustomerClvCount,
    totalPositiveClvRiskUsd: Math.round(totalPositiveClvRiskUsd * 100) / 100,
    totalNegativeClvRiskUsd: Math.round(totalNegativeClvRiskUsd * 100) / 100,
  };
}

/**
 * Wire `WagerType` -> operator label.
 *
 * Mirrors the pinned vendor bundle's `getTypeInfo` switch
 * (`verification/manager-boot-oracle/pinned/util.js`, v43.0.27), ported as
 * `getVendorWagerTypeInfo` in `lib/f402_core_vendor.ts`. The two contextual
 * codes (`I`, `G`) are deliberately absent: the vendor resolves them from
 * `birdCage`/`ARLink`/`PlacedOn`, which this projection does not receive, so
 * they surface as `Unknown (<code>)` instead of being guessed.
 *
 * `tests/wagers_field_roundtrip.test.ts` asserts this table agrees with the
 * vendor function for every code it covers.
 */
const WAGER_TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  A: "Manual Play",
  C: "Future/Props",
  E: "Team Total",
  L: "Total",
  M: "Moneyline",
  P: "Parlay",
  S: "Spread",
  T: "Teaser",
});

export const WAGER_TYPE_UNKNOWN_PREFIX = "Unknown";

/**
 * American price implied by the ticket's own risk/payout, or `null` when either is unusable.
 *
 * The wire does not always carry a price; defaulting to `-110` fabricated a price for a
 * four-leg parlay whose true payout was ~+1075. Risk/payout is measured, so it is the honest
 * fallback and the caller can still tell it apart from a wire value by this being absent.
 */
function impliedAmericanOdds(riskUsd: number, toWinUsd: number): string | null {
  if (!Number.isFinite(riskUsd) || !Number.isFinite(toWinUsd)) return null;
  if (riskUsd <= 0 || toWinUsd <= 0) return null;
  const ratio = toWinUsd / riskUsd;
  if (ratio >= 1) return `+${Math.round(ratio * 100)}`;
  return `${-Math.round(100 / ratio)}`;
}

function projectWagerType(item: Record<string, unknown>): {
  readonly wagerTypeCode: string;
  readonly betType: string;
  readonly unknownWagerType: boolean;
} {
  const wagerTypeCode = String(item.WagerType ?? item.wagerType ?? "")
    .trim()
    .toUpperCase();
  if (wagerTypeCode === "") {
    // No wire code on the row: keep a caller-supplied label (showcase rows).
    return {
      wagerTypeCode: "",
      betType: String(item.betType ?? "Straight"),
      unknownWagerType: false,
    };
  }
  const label = WAGER_TYPE_LABELS[wagerTypeCode];
  return {
    wagerTypeCode,
    betType: label ?? `${WAGER_TYPE_UNKNOWN_PREFIX} (${wagerTypeCode})`,
    unknownWagerType: label === undefined,
  };
}

export interface DevLiveWagersLoaderOptions {
  readonly cwd?: string | undefined;
  readonly candidatePaths?: readonly string[] | undefined;
  readonly loadSharpDeps: () => Promise<ProjectLiveWagerDeps>;
  /**
   * Optional raw-row inspector, called with the pre-projection rows. The host
   * injects the vendor contract check here so this package stays vendor-agnostic.
   * A throw is reported as `{ error }` rather than failing the feed.
   */
  readonly inspectRawRows?:
    | ((rows: readonly Record<string, unknown>[]) => unknown | Promise<unknown>)
    | undefined;
  /**
   * Optional slab-policy descriptor. The host injects the validated
   * `config/slab.toml` summary so this package stays config-agnostic.
   */
  readonly describeSlab?: (() => unknown) | undefined;
}

export interface WagerSourceDescriptor {
  readonly kind: "capture" | "fixture";
  readonly label: string;
  readonly sourcePath: string;
}

export interface DevLiveWagersLoadResult {
  readonly rows: Array<Record<string, unknown>>;
  /** Every row read from disk, including sentinel-noise rows (wire conformance scope). */
  readonly rawRows?: readonly Record<string, unknown>[] | undefined;
  readonly rawRowCount?: number | undefined;
  readonly sentinelNoiseCount?: number | undefined;
  readonly source: WagerSourceDescriptor | null;
}

/** Classify a candidate wager JSON path as `"capture"` vs `"fixture"` without leaking absolute host paths. */
export function classifyWagerCandidateSource(
  candidatePath: string,
  cwd: string,
): WagerSourceDescriptor {
  const rel = relative(cwd, candidatePath).replace(/\\/g, "/");
  const safePath =
    rel && !rel.startsWith("..") && !rel.startsWith("/")
      ? rel
      : basename(candidatePath);
  const normFull = candidatePath.replace(/\\/g, "/").toLowerCase();
  if (
    normFull.includes("/fixtures/") ||
    basename(normFull).includes("fixture")
  ) {
    return {
      kind: "fixture",
      label: "Synthetic Fixture",
      sourcePath: safePath,
    };
  }
  return {
    kind: "capture",
    label: "Local Capture",
    sourcePath: safePath,
  };
}

/** Create a stat-cached live wagers loader + KPI aggregator for the dashboard backend. */
export function createDevLiveWagersLoader(options: DevLiveWagersLoaderOptions) {
  const cwd = options.cwd ?? process.cwd();
  const candidatePaths = options.candidatePaths ?? [
    resolve(cwd, "data/live-wagers.json"),
  ];
  const cache = new BoundedStampCache<DevLiveWagersLoadResult>(8);

  const loadDevLiveWagersDetailed =
    async (): Promise<DevLiveWagersLoadResult> => {
      for (const candidatePath of candidatePaths) {
        const stamp = await statStamp(candidatePath);
        if (stamp === null) continue;

        const hit = cache.getIfFresh(candidatePath, stamp);
        if (hit !== undefined) return hit;

        try {
          const data = (await Bun.file(candidatePath).json()) as
            | {
                LIST?: Array<Record<string, unknown>>;
                wagers?: Array<Record<string, unknown>>;
              }
            | Array<Record<string, unknown>>
            | null;
          const list = Array.isArray(
            (data as { LIST?: Array<Record<string, unknown>> })?.LIST,
          )
            ? (data as { LIST: Array<Record<string, unknown>> }).LIST
            : Array.isArray(
                  (data as { wagers?: Array<Record<string, unknown>> })?.wagers,
                )
              ? (data as { wagers: Array<Record<string, unknown>> }).wagers
              : Array.isArray(data)
                ? (data as Array<Record<string, unknown>>)
                : null;

          if (list && list.length > 0) {
            const sharpDeps = await options.loadSharpDeps();
            const projected = list.map((item, idx) =>
              projectLiveWagerRow(item, idx, sharpDeps),
            );
            const actionableRows = projected.filter(
              (row) => !row.isSentinelNoise,
            );
            // Freeze the raw rows: `lib/wagers_wire_contract.ts` memoizes its
            // scan on this array's identity, so an in-place edit would serve a
            // stale summary. A new file load builds a new frozen array.
            const frozenRawRows = Object.freeze(
              list.map((row) => Object.freeze(row)),
            );
            const result: DevLiveWagersLoadResult = {
              rows: actionableRows,
              rawRows: frozenRawRows,
              rawRowCount: projected.length,
              sentinelNoiseCount: projected.length - actionableRows.length,
              source: classifyWagerCandidateSource(candidatePath, cwd),
            };
            cache.set(candidatePath, stamp, result);
            return result;
          }
        } catch {
          // signal-honesty: intentional-fallback-next-wagers-fixture
        }
      }
      return { rows: [], source: null };
    };

  const loadDevLiveWagers = async (): Promise<
    Array<Record<string, unknown>>
  > => {
    const detailed = await loadDevLiveWagersDetailed();
    return detailed.rows;
  };

  const buildLiveWagersPayload = async (): Promise<LiveWagersPayload> => {
    const nowIso = new Date().toISOString();
    const loaded = await loadDevLiveWagersDetailed();
    const wagers: ReadonlyArray<Record<string, unknown>> = loaded.rows;
    const provenance: DashboardSourceProvenance =
      loaded.rows.length > 0 && loaded.source !== null
        ? {
            kind: loaded.source.kind,
            label: loaded.source.label,
            sourcePath: loaded.source.sourcePath,
            observedAt: nowIso,
          }
        : {
            kind: "unavailable",
            label: `No wager rows in ${candidatePaths
              .map(
                (candidatePath) =>
                  classifyWagerCandidateSource(candidatePath, cwd).sourcePath,
              )
              .join(", ")}`,
            sourcePath: null,
            observedAt: nowIso,
          };

    let wire_contract: unknown;
    const rawRows = loaded.rawRows ?? loaded.rows;
    if (options.inspectRawRows && rawRows.length > 0) {
      try {
        wire_contract = await options.inspectRawRows(rawRows);
      } catch (err) {
        wire_contract = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    const slab_policy = options.describeSlab?.();

    return {
      wagers,
      ...(wire_contract === undefined ? {} : { wire_contract }),
      ...(slab_policy === undefined ? {} : { slab_policy }),
      clvSummary: summarizeWagersClv(wagers),
      totalRiskUsd: wagers.reduce(
        (sum, w) => sum + (Number(w.riskUsd) || 0),
        0,
      ),
      totalToWinUsd: wagers.reduce(
        (sum, w) => sum + (Number(w.toWinUsd) || 0),
        0,
      ),
      criticalSteamCount: wagers.filter(
        (w) => w.alertTier === "CRITICAL" || w.alertTier === "STEAM",
      ).length,
      autoExecute: false,
      timestamp: nowIso,
      provenance,
    };
  };

  return {
    loadDevLiveWagers,
    loadDevLiveWagersDetailed,
    buildLiveWagersPayload,
    clearCache: () => cache.clear(),
  };
}
