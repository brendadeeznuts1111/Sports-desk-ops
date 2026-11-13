/**
 * @file packages/backend/src/wagers.ts
 * @description Live wager normalization, risk classification, and safe fallback fixtures (`autoExecute: false`).
 */

import { basename, relative, resolve } from "node:path";
import type {
  DashboardSourceProvenance,
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

export interface ProjectedDevWagerRow {
  readonly ticketId: string;
  readonly timestamp: string;
  readonly customerId: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly sport: string;
  readonly betType: string;
  readonly event: string;
  readonly selection: string;
  readonly lineDisplay: string;
  readonly oddsAmerican: string;
  readonly riskUsd: number;
  readonly toWinUsd: number;
  readonly clvCents: number;
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
}

export const FALLBACK_DEV_WAGERS: ReadonlyArray<Record<string, unknown>> = [
  {
    ticketId: "W-109281",
    timestamp: "14:32:01 ET",
    customerId: "GP301",
    agentId: "AG99",
    masterAgent: "MASTER_VEND",
    sport: "NFL",
    betType: "Total",
    event: "Kansas City Chiefs @ Buffalo Bills",
    selection: "Under",
    lineDisplay: "47½",
    oddsAmerican: "-110",
    riskUsd: 5500,
    toWinUsd: 5000,
    clvCents: 14.2,
    alertTier: "CRITICAL",
    alertBadge: "🚨 CRITICAL (T1 Originator)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109282",
    timestamp: "14:32:15 ET",
    customerId: "CCC88412",
    agentId: "FATSNOBOT",
    masterAgent: "NOLAWOLF",
    sport: "CFB",
    betType: "Spread",
    event: "Georgia @ Texas",
    selection: "Texas",
    lineDisplay: "+3½",
    oddsAmerican: "-105",
    riskUsd: 5250,
    toWinUsd: 5000,
    clvCents: 11.5,
    alertTier: "STEAM",
    alertBadge: "🚨 STEAM (Key Number 3)",
    operatorDirective: "Clamp Max $250 (autoExecute: false)",
    maxRecommendedStake: 250,
    autoExecute: false,
  },
  {
    ticketId: "W-109288",
    timestamp: "14:34:25 ET",
    customerId: "RF2003",
    agentId: "FAKEMONEY",
    masterAgent: "NOLAWOLF",
    sport: "SOCCER",
    betType: "Total",
    event: "Real Madrid vs Barcelona",
    selection: "Over",
    lineDisplay: "3½ Goals",
    oddsAmerican: "+130",
    riskUsd: 25000,
    toWinUsd: 32500,
    clvCents: -4.2,
    alertTier: "RECREATIONAL",
    alertBadge: "✅ RECREATIONAL (Whale)",
    operatorDirective: "Accept Normal ($25k) (autoExecute: false)",
    maxRecommendedStake: 25000,
    autoExecute: false,
  },
];

export interface ProjectLiveWagerDeps {
  readonly parseShortDesc: (raw: unknown) => ParsedShortDescLike;
  readonly sharpCustomerIds: ReadonlySet<string>;
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
  const clvCents =
    typeof item.clvCents === "number"
      ? item.clvCents
      : isSharp
        ? 12.5
        : riskUsd >= 5000
          ? 8.2
          : -2.4;

  let alertTier: WagerTier = "RECREATIONAL";
  let alertBadge = "✅ RECREATIONAL";
  let operatorDirective = "Accept Normal (autoExecute: false)";
  let maxRecommendedStake = 25000;

  if (clvCents >= 10 || isSharp) {
    alertTier = "CRITICAL";
    alertBadge = isSharp
      ? "🚨 CRITICAL (T1 Originator)"
      : "🚨 CRITICAL (High CLV)";
    operatorDirective = "Clamp Max $250 (autoExecute: false)";
    maxRecommendedStake = 250;
  } else if (clvCents >= 5) {
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
    sport: String(firstLeg?.sport?.toUpperCase() || (item.sport ?? "FOOTBALL")),
    betType:
      item.WagerType === "M"
        ? "Moneyline"
        : item.WagerType === "S"
          ? "Spread"
          : item.WagerType === "P"
            ? "Parlay"
            : String(item.betType ?? "Straight"),
    event: String(firstLeg?.game || (item.event ?? "Event Matchup")),
    selection: String(firstLeg?.pick || (item.selection ?? "Selection")),
    lineDisplay: String(firstLeg?.pick || (item.lineDisplay ?? "ML")),
    oddsAmerican:
      typeof item.oddsAmerican === "string" ? item.oddsAmerican : "-110",
    riskUsd,
    toWinUsd,
    clvCents,
    alertTier,
    alertBadge,
    operatorDirective,
    maxRecommendedStake,
    autoExecute: false as const,
  };
}

export interface DevLiveWagersLoaderOptions {
  readonly cwd?: string | undefined;
  readonly candidatePaths?: readonly string[] | undefined;
  readonly loadSharpDeps: () => Promise<ProjectLiveWagerDeps>;
}

export interface WagerSourceDescriptor {
  readonly kind: "capture" | "fixture";
  readonly label: string;
  readonly sourcePath: string;
}

export interface DevLiveWagersLoadResult {
  readonly rows: Array<Record<string, unknown>>;
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
    resolve(cwd, "tests/fixtures/live-wagers.partial.json"),
    resolve(cwd, "tests/fixtures/live-wagers-LIST-100.json"),
    resolve(cwd, "tests/fixtures/live-wagers-list-sample.json"),
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
            const rows = list.map((item, idx) =>
              projectLiveWagerRow(item, idx, sharpDeps),
            );
            const result: DevLiveWagersLoadResult = {
              rows,
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
    const wagers: ReadonlyArray<Record<string, unknown>> =
      loaded.rows.length > 0 ? loaded.rows : FALLBACK_DEV_WAGERS;
    const provenance: DashboardSourceProvenance =
      loaded.rows.length > 0 && loaded.source !== null
        ? {
            kind: loaded.source.kind,
            label: loaded.source.label,
            sourcePath: loaded.source.sourcePath,
            observedAt: nowIso,
          }
        : {
            kind: "fallback",
            label: "In-Memory Fallback",
            sourcePath: null,
            observedAt: nowIso,
          };

    return {
      wagers,
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
