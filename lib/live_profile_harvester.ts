/**
 * @file lib/live_profile_harvester.ts
 * @description Automated 24h Live Wager Pattern Anomaly Detector & Customer Profile Harvester.
 *
 * Bridges the gap between live wager velocity (`reports/live-positions-summary.json`,
 * `data/live-wagers.json`, `data/live-bets.json`), the 4-week CFB/NBA backtest
 * (`docs/backtest-4wk-cfb-nba.json`), and the 14,534-customer DOD6 v5.4 binary spine
 * (`data/sportsdesk_unified_baseline_v54.dodbin`) using zero-allocation `lookupInto(login, target)`.
 *
 * Automatically detects 5 live pattern concerns:
 *   1. WHALE_SINGLE_AGENT_CONDUIT  — >= $50k 24h open risk or >= 85% of sub-agent exposure
 *   2. KEY_NUMBER_HOOK_BUYER       — Explicit half/full point buying (`buying ½`, `buying 2`) or Wong teasers
 *   3. VELOCITY_BURST_SNIPER       — >= 3 tickets within 10m window or `ALERT` twin trigger
 *   4. POSITIVE_CLV_OR_NET_SHARP   — DOD6 v5.4 positive CLV (`clvBps > 0`) or positive lifetime net (`> $0`)
 *   5. SUB_ACCOUNT_SUFFIX_SPLITTING — Multi-seat suffix (`_0`, `_1`, trailing `.`) mapped to canonical root
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDod6V54LifetimeReader,
  type Dod6LifetimeLookupTarget,
  type Dod6V54LifetimeReader,
} from "./dod6_v54_lifetime_reader.ts";
import { normalizeCanonicalCustomer } from "./dod6_spine_overlay.ts";
import { ticketWriterDisposition } from "./live_writer_policy.ts";
import { positionIdentity } from "./position_identity.ts";

export type LiveAnomalyFlag =
  | "WHALE_SINGLE_AGENT_CONDUIT"
  | "KEY_NUMBER_HOOK_BUYER"
  | "VELOCITY_BURST_SNIPER"
  | "POSITIVE_CLV_OR_NET_SHARP"
  | "SUB_ACCOUNT_SUFFIX_SPLITTING";

export type HarvestedTier =
  | "TIER_1_ELITE_ORIGINATOR"
  | "TIER_2_STEAM_SYNDICATE"
  | "TIER_3_SHARP_DISCIPLINED"
  | "TIER_4_SEMI_SHARP"
  | "TIER_5_RECREATIONAL";

export interface HarvestedSampleWager {
  readonly sport: string;
  readonly market: string;
  readonly line: string;
  /** Measured closing-line value in bps; null when no closing-line comparison exists. */
  readonly clvBps: number | null;
  readonly stakeUsd: number;
  readonly netUsd: number;
  /** Source timestamp, or null when the input carried none. */
  readonly time: string | null;
}

/**
 * A profile derived from the 24h live window and the DOD6 spine.
 *
 * `score`, `tier`, `var95Usd`, `cvar95Usd`, `recommendedLimitUsd`, `inPlayDelaySec`,
 * `lineShadeCents`, `shadowCopyMultiplier`, `syndicateProb` and the archetype strings are
 * heuristic model outputs, not measurements; they are only as honest as the inputs above
 * (a null `dodClvBps` means unmeasured, never zero).
 */
export interface HarvestedLiveProfile {
  readonly id: string;
  readonly canonicalId: string;
  readonly name: string;
  readonly agentId: string;
  readonly masterAgent: string;
  readonly tier: HarvestedTier;
  readonly score: number;
  readonly clvScore: number;
  readonly skillScore: number;
  readonly sizingScore: number;
  readonly sigScore: number;
  readonly timingScore: number;
  readonly correlatedScore: number;
  readonly sizingStrategy: string;
  readonly gini: number;
  readonly meanStake: number;
  readonly maxMinRatio: number;
  readonly specialization: string;
  readonly timingArchetype: string;
  readonly correlatedRisk: "NONE" | "MODERATE" | "HIGH" | "CRITICAL";
  readonly correlatedExploitRate: number;
  readonly syndicateRisk: "LOW" | "ELEVATED" | "HIGH";
  readonly syndicateProb: number;
  readonly subAccountIndex: number | null;
  readonly rootAccountId?: string | undefined;
  readonly var95Usd: number;
  readonly cvar95Usd: number;
  readonly holdPct: number;
  readonly ltvUsd: number;
  readonly recommendedLimitUsd: number;
  readonly inPlayDelaySec: number;
  readonly lineShadeCents: number;
  readonly shadowCopyMultiplier: number;
  readonly action: "ALERT_OPERATOR" | "MONITOR" | "ALLOW";
  readonly openRisk24hUsd: number;
  readonly openTickets24h: number;
  readonly pointBuyingTickets: number;
  readonly alertMirrorTriggers: number;
  readonly dodClvBps: number | null;
  readonly dodClvLegs: number;
  readonly dodSharpScore: number | null;
  readonly dodBinaryRow: number | null;
  readonly anomalyFlags: readonly LiveAnomalyFlag[];
  readonly sampleWagers: readonly HarvestedSampleWager[];
  /** Open ticket-level positions from the live captures, not the six-row sample. */
  readonly positions: readonly HarvestedPosition[];
}

/** One open ticket attributed to a customer. `status` is open by construction: settled rows come
 * from the graded/ledger artifacts, not these live captures. */
export interface HarvestedPosition {
  /** The pending capture's per-row identity; `wagerNumber` is "1" on every row. */
  readonly ticketNumber: string | null;
  readonly wagerNumber: string | null;
  readonly sport: string;
  readonly wagerType: string;
  readonly description: string;
  readonly riskUsd: number;
  readonly toWinUsd: number | null;
  readonly placedAtIso: string | null;
  readonly writer: string | null;
  readonly vip: boolean;
  /** Placeholder until settled positions are wired: every captured row is open by construction. */
  readonly status: "open";
  readonly source: "live-wagers" | "live-bets";
}

export type HarvestSourceStatus = "ok" | "missing" | "malformed";

/** Which artifact each section of the report was actually derived from. */
export interface HarvestSources {
  readonly summary: HarvestSourceStatus;
  readonly liveWagers: HarvestSourceStatus;
  readonly liveBets: HarvestSourceStatus;
  readonly backtest: HarvestSourceStatus;
  readonly agentTree: HarvestSourceStatus;
  readonly dodSpine: HarvestSourceStatus;
}

export interface LiveProfileHarvestResult {
  readonly schemaVersion: 1;
  readonly generatedAtIso: string;
  readonly totalUniqueCustomersScanned: number;
  readonly dodSpineCustomerCount: number;
  readonly dodSpineMatchedCount: number;
  readonly flaggedProfilesCount: number;
  readonly patternCounts: Readonly<Record<LiveAnomalyFlag, number>>;
  /** Positions dropped for having no honest identity; the denominator travels with the stat. */
  readonly positionRefusals: {
    readonly nullTicket: number;
    readonly nullWager: number;
  };
  /** Missing/malformed inputs are named; a zero scan is never mistaken for a clean read. */
  readonly sources: HarvestSources;
  readonly profiles: readonly HarvestedLiveProfile[];
}

export interface HarvestOptions {
  readonly repoRoot?: string | undefined;
  readonly minScore?: number | undefined;
  readonly limit?: number | undefined;
  readonly onlyFlagged?: boolean | undefined;
}

interface RawAccumulator {
  id: string;
  canonicalId: string;
  agentId: string;
  openRisk24hCents: number;
  openToWin24hCents: number;
  openTickets24h: number;
  liveWagerStakesUsd: number[];
  /** Epoch ms of each counted wager; empty when the source carried no timestamp. */
  wagerTimesMs: number[];
  pointBuyingTickets: number;
  teaserTickets: number;
  alertMirrorTriggers: number;
  gsliveTickets: number;
  sports: Map<string, number>;
  wagerTypes: Map<string, number>;
  sampleWagers: HarvestedSampleWager[];
  /** Every open ticket seen for this customer, deduped by wager number across captures. */
  positions: HarvestedPosition[];
  latestSelection: string;
  dodSettledStakedCents: number | null;
  dodSettledNetCents: number | null;
  dodAvgClvPoints: number | null;
}

let cachedDodReader: Dod6V54LifetimeReader | null | undefined;
let cachedDodReaderPath: string | null = null;

async function getDodReader(
  dodbinPath: string,
): Promise<Dod6V54LifetimeReader | null> {
  if (cachedDodReader !== undefined && cachedDodReaderPath === dodbinPath) {
    return cachedDodReader;
  }
  if (!existsSync(dodbinPath)) {
    cachedDodReader = null;
    cachedDodReaderPath = dodbinPath;
    return null;
  }
  try {
    cachedDodReader = await createDod6V54LifetimeReader(dodbinPath);
    cachedDodReaderPath = dodbinPath;
    return cachedDodReader;
  } catch {
    cachedDodReader = null;
    cachedDodReaderPath = dodbinPath;
    return null;
  }
}

function computeGini(stakes: readonly number[]): number {
  if (stakes.length <= 1) return 0;
  const sorted = [...stakes].sort((a, b) => a - b);
  const n = sorted.length;
  let sum = 0;
  let weightedSum = 0;
  for (let i = 0; i < n; i++) {
    const val = sorted[i]!;
    sum += val;
    weightedSum += (i + 1) * val;
  }
  if (sum <= 0) return 0;
  const g = (2 * weightedSum) / (n * sum) - (n + 1) / n;
  return Number(Math.max(0.01, Math.min(0.95, g)).toFixed(3));
}

function parseSubAccountSuffix(customerId: string): {
  subAccountIndex: number | null;
  rootAccountId: string | undefined;
} {
  const trimmed = customerId.trim().toUpperCase();
  const underscoreMatch = /^([A-Z0-9]+)_(\d+)$/.exec(trimmed);
  if (underscoreMatch) {
    return {
      subAccountIndex: Number(underscoreMatch[2]),
      rootAccountId: underscoreMatch[1]!,
    };
  }
  if (trimmed.endsWith(".")) {
    return {
      subAccountIndex: 1,
      rootAccountId: trimmed.replace(/\.+$/, ""),
    };
  }
  return { subAccountIndex: null, rootAccountId: undefined };
}

function resolveMasterAgent(
  agentId: string,
  treeNodes: Record<string, { p?: string | null }> | null,
): string {
  const norm = agentId.trim().toUpperCase();
  if (!norm || !treeNodes) return norm || "HOUSE";
  let curr = norm;
  let guard = 0;
  while (guard++ < 12) {
    const node = treeNodes[curr];
    const parent = node?.p?.trim().toUpperCase();
    if (!parent || parent === curr || parent === "ROOT") break;
    curr = parent;
  }
  return curr;
}

/** Largest number of wagers that fall inside any `windowMs` span. */
function maxWagersInWindow(
  timesMs: readonly number[],
  windowMs: number,
): number {
  if (timesMs.length < 2) return timesMs.length;
  const sorted = [...timesMs].sort((a, b) => a - b);
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end++) {
    while (sorted[end]! - sorted[start]! > windowMs) start++;
    const count = end - start + 1;
    if (count > best) best = count;
  }
  return best;
}

function buildProfileFromAccumulator(
  acc: RawAccumulator,
  agentRiskMap: ReadonlyMap<string, number>,
  treeNodes: Record<string, { p?: string | null }> | null,
  dodTarget: Dod6LifetimeLookupTarget,
  hasDodMatch: boolean,
): HarvestedLiveProfile {
  const flags: LiveAnomalyFlag[] = [];
  const burstCount = maxWagersInWindow(acc.wagerTimesMs, 10 * 60_000);
  const liveTickerSumUsd = acc.liveWagerStakesUsd.reduce((s, x) => s + x, 0);
  const openRiskUsd = Math.max(
    Math.round(acc.openRisk24hCents / 100),
    liveTickerSumUsd,
  );
  const agentTotalRiskCents =
    agentRiskMap.get(acc.agentId) ?? acc.openRisk24hCents;
  const agentConcentration =
    agentTotalRiskCents > 0 ? acc.openRisk24hCents / agentTotalRiskCents : 0;

  if (
    openRiskUsd >= 50_000 ||
    (openRiskUsd >= 15_000 && agentConcentration >= 0.85)
  ) {
    flags.push("WHALE_SINGLE_AGENT_CONDUIT");
  }
  if (acc.pointBuyingTickets > 0 || acc.teaserTickets > 0) {
    flags.push("KEY_NUMBER_HOOK_BUYER");
  }
  // 3+ wagers inside one 10-minute window; a 24h ticket count is not a burst.
  if (burstCount >= 3 || acc.alertMirrorTriggers > 0) {
    flags.push("VELOCITY_BURST_SNIPER");
  }

  const dodClvBps = hasDodMatch
    ? dodTarget.clvBps
    : acc.dodAvgClvPoints !== null
      ? Math.round(acc.dodAvgClvPoints * 100)
      : null;
  const dodClvLegs = hasDodMatch ? dodTarget.clvLegs : 0;
  const dodSharpScore = hasDodMatch ? dodTarget.sharpScore : null;
  const dodBinaryRow =
    hasDodMatch &&
    dodTarget.handleKind === "binary" &&
    dodTarget.handleValue !== null
      ? dodTarget.handleValue & 0x7fff
      : null;

  const lifetimeNetUsd =
    acc.dodSettledNetCents !== null
      ? Math.round(acc.dodSettledNetCents / 100)
      : hasDodMatch && dodTarget.lifetimeNetUsd !== null
        ? Math.round(dodTarget.lifetimeNetUsd)
        : 0;

  const settledStakedUsd =
    acc.dodSettledStakedCents !== null && acc.dodSettledStakedCents > 0
      ? acc.dodSettledStakedCents / 100
      : Math.max(openRiskUsd * 4, 25_000);

  if ((dodClvBps !== null && dodClvBps > 0) || lifetimeNetUsd > 0) {
    flags.push("POSITIVE_CLV_OR_NET_SHARP");
  }

  const { subAccountIndex, rootAccountId } = parseSubAccountSuffix(acc.id);
  if (subAccountIndex !== null) {
    flags.push("SUB_ACCOUNT_SUFFIX_SPLITTING");
  }

  const stakes =
    acc.liveWagerStakesUsd.length > 0
      ? acc.liveWagerStakesUsd
      : [
          Math.max(
            100,
            Math.round(openRiskUsd / Math.max(1, acc.openTickets24h)),
          ),
        ];
  const gini = computeGini(stakes);
  const sumStakes = stakes.reduce((s, x) => s + x, 0);
  const meanStake = Math.max(
    50,
    Math.round(
      openRiskUsd > 0
        ? openRiskUsd / Math.max(1, acc.openTickets24h)
        : sumStakes / stakes.length,
    ),
  );
  const minStake = Math.max(1, Math.min(...stakes));
  const maxStake = Math.max(...stakes, meanStake);
  const maxMinRatio = Number(
    Math.min(50, Math.max(1.0, maxStake / minStake)).toFixed(1),
  );

  // Score components (0.0 - 10.0)
  const clvScore = Number(
    Math.min(
      3.0,
      Math.max(
        0.8,
        dodClvBps !== null && dodClvBps > 0
          ? 2.2 + Math.min(0.8, dodClvBps / 150)
          : acc.pointBuyingTickets > 0 || acc.teaserTickets > 0
            ? 2.4
            : openRiskUsd >= 50_000
              ? 2.1
              : 1.5,
      ),
    ).toFixed(1),
  );

  const skillScore = Number(
    Math.min(
      2.5,
      Math.max(
        0.7,
        lifetimeNetUsd > 0
          ? 2.2
          : dodClvLegs >= 10
            ? 2.0
            : openRiskUsd >= 25_000
              ? 1.9
              : 1.4,
      ),
    ).toFixed(1),
  );

  const sizingScore = Number(
    Math.min(
      1.5,
      Math.max(0.5, gini < 0.18 ? 1.4 : gini < 0.3 ? 1.2 : 0.9),
    ).toFixed(1),
  );

  const sigScore = Number(
    Math.min(
      2.0,
      Math.max(
        0.6,
        acc.pointBuyingTickets >= 3 || acc.teaserTickets > 0
          ? 1.9
          : acc.pointBuyingTickets > 0 || acc.gsliveTickets >= 2
            ? 1.7
            : openRiskUsd >= 50_000
              ? 1.6
              : 1.1,
      ),
    ).toFixed(1),
  );

  const timingScore = Number(
    Math.min(
      1.0,
      Math.max(
        0.3,
        acc.liveWagerStakesUsd.length >= 5 || acc.alertMirrorTriggers > 0
          ? 0.9
          : acc.gsliveTickets > 0
            ? 0.8
            : 0.6,
      ),
    ).toFixed(1),
  );

  const score = Number(
    Math.min(
      9.9,
      clvScore + skillScore + sizingScore + sigScore + timingScore,
    ).toFixed(1),
  );

  const tier: HarvestedTier =
    score >= 8.6 ||
    (flags.includes("POSITIVE_CLV_OR_NET_SHARP") && openRiskUsd >= 20_000)
      ? "TIER_1_ELITE_ORIGINATOR"
      : score >= 7.8 ||
          flags.includes("VELOCITY_BURST_SNIPER") ||
          flags.includes("SUB_ACCOUNT_SUFFIX_SPLITTING")
        ? "TIER_2_STEAM_SYNDICATE"
        : score >= 7.0 || flags.includes("KEY_NUMBER_HOOK_BUYER")
          ? "TIER_3_SHARP_DISCIPLINED"
          : score >= 5.8
            ? "TIER_4_SEMI_SHARP"
            : "TIER_5_RECREATIONAL";

  const topSport =
    [...acc.sports.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "Football";
  const specialization =
    acc.pointBuyingTickets >= 3
      ? `${topSport} Key-Number & Half-Point Hook Buying (${acc.pointBuyingTickets} tix)`
      : acc.teaserTickets > 0
        ? `${topSport} Wong Key-Number Teaser Crosses`
        : acc.gsliveTickets > 0
          ? `GSLive In-Play ${topSport} High-Velocity Totals`
          : openRiskUsd >= 50_000
            ? `${topSport} High-Limit Single-Agent Conduit ($${(openRiskUsd / 1000).toFixed(0)}k 24h)`
            : `${topSport} Spread & Total Syndicate Action`;

  const timingArchetype =
    burstCount >= 5
      ? "HIGH_FREQUENCY_STEAM_BURST"
      : acc.gsliveTickets > 0
        ? "IN_PLAY_LATENCY_SNIPER"
        : acc.pointBuyingTickets > 0
          ? "KEY_NUMBER_HOOK_BUYER"
          : "EARLY_OPENER_ORIGINATOR";

  const sizingStrategy =
    gini < 0.16
      ? "FLAT_UNIT"
      : gini < 0.3
        ? "PROPORTIONAL_KELLY"
        : "STEPPED_WHALE_SIZING";

  // Book hold % on customer = -customerNet / settledStaked
  const rawHoldPct =
    settledStakedUsd > 0 ? (-lifetimeNetUsd / settledStakedUsd) * 100 : -3.5;
  const holdPct = Number(Math.max(-25, Math.min(25, rawHoldPct)).toFixed(1));

  const var95Usd = Math.max(
    2500,
    Math.round(Math.max(openRiskUsd * 0.45, meanStake * 3.2)),
  );
  const cvar95Usd = Math.round(var95Usd * 1.25);

  const recommendedLimitUsd =
    tier === "TIER_1_ELITE_ORIGINATOR"
      ? 500
      : tier === "TIER_2_STEAM_SYNDICATE"
        ? 1000
        : tier === "TIER_3_SHARP_DISCIPLINED"
          ? 1500
          : 2500;

  const action: "ALERT_OPERATOR" | "MONITOR" | "ALLOW" =
    score >= 8.0 || openRiskUsd >= 25_000 || flags.length >= 2
      ? "ALERT_OPERATOR"
      : score >= 6.8 || flags.length >= 1
        ? "MONITOR"
        : "ALLOW";

  const masterAgent = resolveMasterAgent(acc.agentId, treeNodes);

  const labelTag = flags.includes("WHALE_SINGLE_AGENT_CONDUIT")
    ? "24h Whale Conduit"
    : flags.includes("KEY_NUMBER_HOOK_BUYER")
      ? "Key-Number Hook Buyer"
      : flags.includes("VELOCITY_BURST_SNIPER")
        ? "Velocity Burst Sniper"
        : flags.includes("POSITIVE_CLV_OR_NET_SHARP")
          ? "DOD6 Positive-Edge Sharp"
          : "24h Active Surveillance Profile";

  return {
    id: acc.id,
    canonicalId: acc.canonicalId,
    name: `${acc.agentId || "Desk"} ${labelTag}`,
    agentId: acc.agentId || "UNASSIGNED",
    masterAgent,
    tier,
    score,
    clvScore,
    skillScore,
    sizingScore,
    sigScore,
    timingScore,
    correlatedScore: Number(Math.min(1.0, sigScore * 0.4).toFixed(1)),
    sizingStrategy,
    gini,
    meanStake,
    maxMinRatio,
    specialization,
    timingArchetype,
    correlatedRisk:
      acc.teaserTickets > 0 || acc.pointBuyingTickets >= 3
        ? "HIGH"
        : "MODERATE",
    correlatedExploitRate:
      acc.teaserTickets > 0 || acc.pointBuyingTickets >= 3 ? 0.52 : 0.28,
    syndicateRisk:
      flags.length >= 2 ? "HIGH" : flags.length === 1 ? "ELEVATED" : "LOW",
    syndicateProb: flags.length >= 2 ? 0.86 : flags.length === 1 ? 0.65 : 0.35,
    subAccountIndex,
    ...(rootAccountId !== undefined ? { rootAccountId } : {}),
    var95Usd,
    cvar95Usd,
    holdPct,
    ltvUsd: lifetimeNetUsd,
    recommendedLimitUsd,
    inPlayDelaySec:
      acc.gsliveTickets > 0 || action === "ALERT_OPERATOR" ? 3 : 2,
    lineShadeCents:
      tier === "TIER_1_ELITE_ORIGINATOR"
        ? 20
        : tier === "TIER_2_STEAM_SYNDICATE"
          ? 15
          : 10,
    shadowCopyMultiplier:
      dodClvBps !== null && dodClvBps > 0
        ? 1.25
        : lifetimeNetUsd > 0
          ? 1.0
          : 0.5,
    action,
    openRisk24hUsd: openRiskUsd,
    openTickets24h: Math.max(acc.openTickets24h, acc.liveWagerStakesUsd.length),
    pointBuyingTickets: acc.pointBuyingTickets,
    alertMirrorTriggers: acc.alertMirrorTriggers,
    dodClvBps,
    dodClvLegs,
    dodSharpScore,
    dodBinaryRow,
    anomalyFlags: flags,
    sampleWagers: acc.sampleWagers.slice(0, 6),
    positions: [...acc.positions].sort((a, b) => b.riskUsd - a.riskUsd),
  };
}

/**
 * Scans all local 24h & 10m live wager artifacts + 4-week backtest + DOD6 v5.4 binary spine
 * (`lookupInto`) and returns ranked, pattern-flagged customer profiles.
 */
export async function harvestLiveCustomerProfiles(
  options: HarvestOptions = {},
): Promise<LiveProfileHarvestResult> {
  const repoRoot = options.repoRoot ?? resolve(import.meta.dir, "..");
  const summaryPath = resolve(repoRoot, "reports/live-positions-summary.json");
  const liveWagersPath = resolve(repoRoot, "data/live-wagers.json");
  const liveBetsPath = resolve(repoRoot, "data/live-bets.json");
  const backtestPath = resolve(repoRoot, "docs/backtest-4wk-cfb-nba.json");
  const agentTreePath = resolve(repoRoot, "data/agent-tree.json");
  const dodbinPath = resolve(
    repoRoot,
    "data/sportsdesk_unified_baseline_v54.dodbin",
  );

  const byCustomer = new Map<string, RawAccumulator>();
  const agentRiskMap = new Map<string, number>();
  const sources: {
    -readonly [K in keyof HarvestSources]: HarvestSourceStatus;
  } = {
    summary: "missing",
    liveWagers: "missing",
    liveBets: "missing",
    backtest: "missing",
    agentTree: "missing",
    dodSpine: "missing",
  };

  const positionRefusals = { nullTicket: 0, nullWager: 0 };

  const getOrCreate = (rawId: string, rawAgent: string): RawAccumulator => {
    const id = rawId.trim().toUpperCase();
    const agentId = rawAgent.trim().toUpperCase() || "UNASSIGNED";
    let acc = byCustomer.get(id);
    if (!acc) {
      acc = {
        id,
        canonicalId: normalizeCanonicalCustomer(id),
        agentId,
        openRisk24hCents: 0,
        openToWin24hCents: 0,
        openTickets24h: 0,
        liveWagerStakesUsd: [],
        wagerTimesMs: [],
        pointBuyingTickets: 0,
        teaserTickets: 0,
        alertMirrorTriggers: 0,
        gsliveTickets: 0,
        sports: new Map(),
        wagerTypes: new Map(),
        sampleWagers: [],
        positions: [],
        latestSelection: "",
        dodSettledStakedCents: null,
        dodSettledNetCents: null,
        dodAvgClvPoints: null,
      };
      byCustomer.set(id, acc);
    } else if (acc.agentId === "UNASSIGNED" && agentId !== "UNASSIGNED") {
      acc.agentId = agentId;
    }
    return acc;
  };

  // 1. Load 24h summary (`reports/live-positions-summary.json`)
  if (existsSync(summaryPath)) {
    try {
      const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
        window24hOpenPositions?: {
          topAgents?: readonly { key: string; riskCents: number }[];
          topActiveAccounts?: readonly {
            customerId: string;
            agentId: string;
            wagersCount: number;
            riskCents: number;
            toWinCents: number;
            latestSelection?: string;
            dodSettledStakedCents?: number | null;
            dodSettledNetCents?: number | null;
            dodAvgClvPoints?: number | null;
          }[];
        };
      };
      for (const ag of summary.window24hOpenPositions?.topAgents ?? []) {
        agentRiskMap.set(ag.key.trim().toUpperCase(), ag.riskCents);
      }
      for (const row of summary.window24hOpenPositions?.topActiveAccounts ??
        []) {
        const acc = getOrCreate(row.customerId, row.agentId);
        acc.openRisk24hCents = Math.max(acc.openRisk24hCents, row.riskCents);
        acc.openToWin24hCents = Math.max(acc.openToWin24hCents, row.toWinCents);
        acc.openTickets24h = Math.max(acc.openTickets24h, row.wagersCount);
        if (row.latestSelection) {
          acc.latestSelection = row.latestSelection;
          if (/buying/i.test(row.latestSelection)) acc.pointBuyingTickets++;
          if (/^T\./i.test(row.latestSelection)) acc.teaserTickets++;
          acc.sampleWagers.push({
            sport: row.latestSelection.includes("Basketball")
              ? "NBA"
              : row.latestSelection.includes("Soccer")
                ? "SOCCER"
                : "CFB/NFL",
            market: /^T\./i.test(row.latestSelection)
              ? "TEASER"
              : /^L\.|Total/i.test(row.latestSelection)
                ? "TOTAL"
                : "SPREAD",
            line: row.latestSelection.slice(0, 48),
            clvBps:
              row.dodAvgClvPoints !== null && row.dodAvgClvPoints !== undefined
                ? Math.round(row.dodAvgClvPoints * 100)
                : null,
            stakeUsd: Math.round(
              row.riskCents / 100 / Math.max(1, row.wagersCount),
            ),
            netUsd: 0,
            time: null,
          });
        }
        acc.dodSettledStakedCents = row.dodSettledStakedCents ?? null;
        acc.dodSettledNetCents = row.dodSettledNetCents ?? null;
        acc.dodAvgClvPoints = row.dodAvgClvPoints ?? null;
      }
      sources.summary = "ok";
    } catch {
      sources.summary = "malformed";
    }
  }

  // 2. Load `data/live-wagers.json`
  if (existsSync(liveWagersPath)) {
    try {
      const lw = JSON.parse(readFileSync(liveWagersPath, "utf8")) as {
        LIST?: readonly Record<string, unknown>[];
      };
      for (const r of lw.LIST ?? []) {
        const cid = String(r.CustomerID ?? r.Login ?? "").trim();
        if (!cid) continue;
        const ag = String(r.AgentID ?? r.AgentLogin ?? "").trim();
        const acc = getOrCreate(cid, ag);
        const writer = String(r.TicketWriter ?? "")
          .trim()
          .toLowerCase();
        const riskCents = Number(r.AmountWagered) || 0;
        const stakeUsd = Math.round(riskCents / 100);
        const desc = String(r.ShortDesc ?? "").trim();
        const wt = String(r.WagerType ?? "S").trim();

        const writerDisposition = ticketWriterDisposition(writer);
        if (writerDisposition === "alert") {
          acc.alertMirrorTriggers++;
          continue;
        }
        if (writerDisposition === "blocked") continue;

        const whenMs = Date.parse(String(r.InsertDateTime ?? ""));
        acc.liveWagerStakesUsd.push(stakeUsd);
        if (Number.isFinite(whenMs)) acc.wagerTimesMs.push(whenMs);
        if (writer.includes("gslive")) acc.gsliveTickets++;
        if (/buying/i.test(desc)) acc.pointBuyingTickets++;
        if (wt === "T" || /^T\./i.test(desc)) acc.teaserTickets++;

        const sport = desc.includes("Basketball")
          ? "Basketball"
          : desc.includes("Hockey")
            ? "Hockey"
            : desc.includes("Soccer")
              ? "Soccer"
              : "Football";
        acc.sports.set(sport, (acc.sports.get(sport) ?? 0) + 1);
        acc.wagerTypes.set(wt, (acc.wagerTypes.get(wt) ?? 0) + 1);

        const toWinCents = Number(r.ToWinAmount);
        const wagerNumber = String(r.WagerNumber ?? "").trim();
        const tickerPosition: HarvestedPosition = {
          ticketNumber: null,
          wagerNumber: wagerNumber === "" ? null : wagerNumber,
          sport,
          wagerType: wt,
          description: desc,
          riskUsd: riskCents / 100,
          toWinUsd: Number.isFinite(toWinCents) ? toWinCents / 100 : null,
          placedAtIso: Number.isFinite(whenMs)
            ? new Date(whenMs).toISOString()
            : null,
          writer: writer === "" ? null : writer,
          vip: Boolean(r.VIP),
          status: "open",
          source: "live-wagers",
        };
        const tickerIdentity = positionIdentity(tickerPosition);
        if (tickerIdentity.key === null) {
          if (tickerIdentity.refusal === "null_ticket")
            positionRefusals.nullTicket++;
          else positionRefusals.nullWager++;
        } else {
          acc.positions.push(tickerPosition);
        }

        if (acc.sampleWagers.length < 6 && desc) {
          acc.sampleWagers.push({
            sport: sport.toUpperCase(),
            market:
              wt === "M"
                ? "ML"
                : wt === "L"
                  ? "TOTAL"
                  : wt === "P"
                    ? "PARLAY"
                    : wt === "T"
                      ? "TEASER"
                      : "SPREAD",
            line: desc.replace(/\s+/g, " ").slice(0, 48),
            clvBps: null,
            stakeUsd,
            netUsd: 0,
            time: Number.isFinite(whenMs)
              ? new Date(whenMs).toISOString().slice(0, 16).replace("T", " ")
              : null,
          });
        }
      }
      sources.liveWagers = "ok";
    } catch {
      sources.liveWagers = "malformed";
    }
  }

  // 3. Load `data/live-bets.json`
  if (existsSync(liveBetsPath)) {
    try {
      const lb = JSON.parse(readFileSync(liveBetsPath, "utf8")) as {
        games?: readonly Record<string, unknown>[];
      };
      for (const g of lb.games ?? []) {
        const cid = String(g.customerID ?? "").trim();
        if (!cid) continue;
        const agentObj = g.agent as { id?: string; key?: string } | undefined;
        const ag = String(agentObj?.id ?? agentObj?.key ?? "").trim();
        const acc = getOrCreate(cid, ag);
        const riskCents = Number(g.wagered) || 0;
        if (acc.openRisk24hCents === 0) {
          acc.openRisk24hCents += riskCents;
          acc.openTickets24h += 1;
        }

        const wagerNumber = String(g.wagerNumber ?? "").trim();
        const ticketNumber = String(g.ticketNumber ?? "").trim();
        const toWinCents = Number(g.toWin);
        const position: HarvestedPosition = {
          ticketNumber: ticketNumber === "" ? null : ticketNumber,
          wagerNumber: wagerNumber === "" ? null : wagerNumber,
          sport:
            String(g.sport ?? "")
              .trim()
              .toUpperCase() || "OTHER",
          wagerType: String(g.wagerType ?? "").trim(),
          description: String(g.description ?? "").trim(),
          riskUsd: riskCents / 100,
          toWinUsd: Number.isFinite(toWinCents) ? toWinCents / 100 : null,
          placedAtIso: String(g.acceptedAt ?? "").trim() || null,
          writer: null,
          vip: false,
          status: "open",
          source: "live-bets",
        };
        const positionKey = positionIdentity(position);
        if (positionKey.key === null) {
          if (positionKey.refusal === "null_ticket")
            positionRefusals.nullTicket++;
          else positionRefusals.nullWager++;
          continue;
        }
        const existingIndex = acc.positions.findIndex(
          (p) => positionIdentity(p).key === positionKey.key,
        );
        if (existingIndex >= 0) {
          const existing = acc.positions[existingIndex]!;
          acc.positions[existingIndex] = {
            ...existing,
            sport: position.sport !== "OTHER" ? position.sport : existing.sport,
            wagerType: position.wagerType || existing.wagerType,
            description: position.description || existing.description,
            toWinUsd: position.toWinUsd ?? existing.toWinUsd,
            placedAtIso: position.placedAtIso ?? existing.placedAtIso,
          };
        } else {
          acc.positions.push(position);
        }
      }
      sources.liveBets = "ok";
    } catch {
      sources.liveBets = "malformed";
    }
  }

  // 4. Load `docs/backtest-4wk-cfb-nba.json`
  if (existsSync(backtestPath)) {
    try {
      const bt = JSON.parse(readFileSync(backtestPath, "utf8")) as {
        customerLeaderboard?: readonly {
          customer?: string;
          customerId?: string;
          agent?: string;
          agentId?: string;
          totalRiskUsd?: number;
          tickets?: number;
          avgClvBps?: number;
        }[];
      };
      for (const row of bt.customerLeaderboard ?? []) {
        const cid = String(row.customerId ?? row.customer ?? "").trim();
        if (!cid) continue;
        const ag = String(row.agentId ?? row.agent ?? "").trim();
        const acc = getOrCreate(cid, ag);
        // The 4-week backtest is not a 24h exposure window; only its measured CLV is usable.
        if (acc.dodAvgClvPoints === null && typeof row.avgClvBps === "number") {
          acc.dodAvgClvPoints = row.avgClvBps / 100;
        }
      }
      sources.backtest = "ok";
    } catch {
      sources.backtest = "malformed";
    }
  }

  // 5. Load `data/agent-tree.json`
  let treeNodes: Record<string, { p?: string | null }> | null = null;
  if (existsSync(agentTreePath)) {
    try {
      const tree = JSON.parse(readFileSync(agentTreePath, "utf8")) as {
        nodes?: Record<string, { p?: string | null }>;
      };
      treeNodes = tree.nodes ?? null;
      sources.agentTree = "ok";
    } catch {
      treeNodes = null;
      sources.agentTree = "malformed";
    }
  }

  // 6. Cross-grade against DOD6 v5.4 binary spine using zero-allocation `lookupInto`
  const dodReader = await getDodReader(dodbinPath);
  sources.dodSpine =
    dodReader !== null
      ? "ok"
      : existsSync(dodbinPath)
        ? "malformed"
        : "missing";
  const dodTarget: Dod6LifetimeLookupTarget = {
    clvBps: null,
    sharpScore: null,
    lifetimeNetUsd: null,
    clvLegs: 0,
    avgClvPoints: null,
    sharpCandidateGatePassed: false,
    source: "dodbin_columnar",
    handleKind: "row-index-fallback",
    handleValue: null,
  };

  let dodSpineMatchedCount = 0;
  const patternCounts: Record<LiveAnomalyFlag, number> = {
    WHALE_SINGLE_AGENT_CONDUIT: 0,
    KEY_NUMBER_HOOK_BUYER: 0,
    VELOCITY_BURST_SNIPER: 0,
    POSITIVE_CLV_OR_NET_SHARP: 0,
    SUB_ACCOUNT_SUFFIX_SPLITTING: 0,
  };

  const allProfiles: HarvestedLiveProfile[] = [];
  for (const acc of byCustomer.values()) {
    const hasDod =
      dodReader !== null &&
      (dodReader.lookupInto(acc.canonicalId, dodTarget) ||
        dodReader.lookupInto(acc.id, dodTarget));
    if (hasDod) dodSpineMatchedCount++;

    const profile = buildProfileFromAccumulator(
      acc,
      agentRiskMap,
      treeNodes,
      dodTarget,
      hasDod,
    );
    for (const f of profile.anomalyFlags) {
      patternCounts[f]++;
    }
    allProfiles.push(profile);
  }

  const priorityOf = (p: HarvestedLiveProfile): number =>
    p.anomalyFlags.length * 10 +
    (p.openRisk24hUsd >= 50_000
      ? 25
      : p.openRisk24hUsd >= 20_000
        ? 15
        : p.openRisk24hUsd >= 1_000
          ? 5
          : 0) +
    p.score;

  allProfiles.sort((a, b) => {
    const diff = priorityOf(b) - priorityOf(a);
    if (Math.abs(diff) > 0.01) return diff;
    return b.openRisk24hUsd - a.openRisk24hUsd;
  });

  const minScore = options.minScore ?? 0;
  const filtered = allProfiles.filter((p) => {
    if (options.onlyFlagged && p.anomalyFlags.length === 0) return false;
    return p.score >= minScore;
  });

  const limit = options.limit ?? filtered.length;

  return {
    schemaVersion: 1,
    generatedAtIso: new Date().toISOString(),
    totalUniqueCustomersScanned: byCustomer.size,
    dodSpineCustomerCount: dodReader?.meta.customerCount ?? 0,
    dodSpineMatchedCount,
    flaggedProfilesCount: allProfiles.filter((p) => p.anomalyFlags.length > 0)
      .length,
    patternCounts,
    positionRefusals,
    sources,
    profiles: filtered.slice(0, limit),
  };
}
