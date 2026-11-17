/**
 * Map the customer book's rows (the `/api/customers` `fixtures` array) onto the shape the
 * Profiles tab renders.
 *
 * Only derivable values are computed: sharpness from `sharp_score`, CLV from `clv_bps`, sizing
 * strategy and Gini from the row's recent tickets, specialization from the most common
 * league/market. Fields the book does not carry (syndicate probability, line shading, LTV) are
 * left at their explicit zero/none values rather than guessed.
 */
import type { LiveWager, RankedPlayer30d, ShowcaseCustomer } from "./types.ts";

type Row = Record<string, unknown>;

const num = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const DECIMAL_NUMERIC = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function nonNegativeFinite(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "" || !DECIMAL_NUMERIC.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const round = (value: number, places = 2): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

function stakesOf(row: Row): number[] {
  const tickets = Array.isArray(row.recent_tickets) ? row.recent_tickets : [];
  return tickets
    .map((ticket) => num((ticket as Row).risk_usd))
    .filter((risk) => risk > 0);
}

function gini(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  if (sum === 0) return 0;
  const weighted = sorted.reduce((acc, v, i) => acc + (i + 1) * v, 0);
  return (
    (2 * weighted) / (sorted.length * sum) - (sorted.length + 1) / sorted.length
  );
}

function topKey(tickets: readonly Row[], key: string): string {
  const counts = new Map<string, number>();
  for (const ticket of tickets) {
    const value = String(ticket[key] ?? "").trim();
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

const SOURCE_TIERS: ReadonlySet<string> = new Set([
  "TIER_1_ELITE_ORIGINATOR",
  "TIER_2_STEAM_SYNDICATE",
  "TIER_3_SHARP_DISCIPLINED",
  "TIER_4_SEMI_SHARP",
  "TIER_5_RECREATIONAL",
]);

function tierFor(score: number): ShowcaseCustomer["tier"] {
  if (score >= 9) return "TIER_1_ELITE_ORIGINATOR";
  if (score >= 7) return "TIER_2_STEAM_SYNDICATE";
  if (score >= 5) return "TIER_3_SHARP_DISCIPLINED";
  if (score >= 3) return "TIER_4_SEMI_SHARP";
  return "TIER_5_RECREATIONAL";
}

/** Map ranking / API tier codes onto the Profiles tab vocabulary (data-first). */
export function mapRankingTierCode(
  tier: string,
): ShowcaseCustomer["tier"] | null {
  const t = tier.trim().toUpperCase();
  if (t === "TIER_1" || t.includes("ELITE") || t.includes("ORIGINATOR")) {
    return "TIER_1_ELITE_ORIGINATOR";
  }
  if (t === "TIER_2" || t.includes("STEAM") || t.includes("SYNDICATE")) {
    return "TIER_2_STEAM_SYNDICATE";
  }
  if (t === "TIER_3" || t.includes("DISCIPLINED") || t.includes("SHARP")) {
    return "TIER_3_SHARP_DISCIPLINED";
  }
  if (t === "TIER_4" || t.includes("SEMI")) {
    return "TIER_4_SEMI_SHARP";
  }
  if (t === "TIER_5" || t.includes("RECREATIONAL") || t.includes("RETAIL")) {
    return "TIER_5_RECREATIONAL";
  }
  if (SOURCE_TIERS.has(t)) {
    return t as ShowcaseCustomer["tier"];
  }
  return null;
}

function tierFromRow(row: Row, score: number): ShowcaseCustomer["tier"] {
  const rawTier = typeof row.tier === "string" ? row.tier.trim() : "";
  const rawLabel =
    typeof row.tierLabel === "string" ? row.tierLabel.trim() : "";
  for (const candidate of [rawTier, rawLabel]) {
    if (!candidate) continue;
    const mapped = mapRankingTierCode(candidate);
    if (mapped !== null) return mapped;
  }
  return tierFor(score);
}

export function bookRowsToProfiles(
  rows: ReadonlyArray<Row>,
  source: "book" | "fixture" = "book",
): ShowcaseCustomer[] {
  return rows.map((row, idx) => {
    const id = String(row.customer_id ?? row.customerId ?? `BOOK-${idx}`);
    const tickets = Array.isArray(row.recent_tickets)
      ? (row.recent_tickets as Row[])
      : [];
    const stakes = stakesOf(row);
    const meanStake = stakes.length
      ? stakes.reduce((acc, v) => acc + v, 0) / stakes.length
      : 0;
    const variance = stakes.length
      ? stakes.reduce((acc, v) => acc + (v - meanStake) ** 2, 0) / stakes.length
      : 0;
    const sd = Math.sqrt(variance);
    const cv = meanStake > 0 ? sd / meanStake : 0;
    const rawSharp = Number(row.sharp_score);
    const sharpKnown = Number.isFinite(rawSharp);
    const score = sharpKnown ? clamp(rawSharp / 10, 0, 10) : 0;
    const clvScore = clamp(num(row.clv_bps) / 100, -10, 10);
    const rawDelay = nonNegativeFinite(row.delay_seconds);
    const delayKnown = rawDelay !== null;
    const delay = rawDelay ?? 0;
    const league = topKey(tickets, "league");
    const market = topKey(tickets, "market");
    const sizingKnown = stakes.length >= 2;

    const unknown: string[] = [];
    if (!sharpKnown) unknown.push("sharpness");
    if (stakes.length === 0) {
      // A mean of zero observations is undefined; a mean of one is just that stake.
      unknown.push("meanStake");
    }
    if (!sizingKnown) {
      // Gini/VaR of one observation are convention, not measurement; sizing derives from
      // a spread that does not exist yet.
      unknown.push("sizing", "gini", "var95");
    }
    if (!league && !market) unknown.push("specialization");
    // The book carries no syndicate or correlation signal at all.
    unknown.push("syndicate", "correlation");
    if (!delayKnown) unknown.push("delay");

    return {
      id,
      name: id,
      agentId: String(row.agent_id ?? row.agentId ?? "—"),
      masterAgent: String(row.master_agent ?? row.masterAgent ?? "—"),
      tier: tierFromRow(row, score),
      score: round(score, 2),
      clvScore: round(clvScore, 2),
      skillScore: clvScore,
      sizingScore: sizingKnown ? round(clamp(1 - cv, 0, 2), 2) : 0,
      sigScore: 0,
      timingScore: delayKnown && delay > 0 ? 1 : 0,
      sizingStrategy: sizingKnown
        ? cv < 0.15
          ? "FLAT_UNIT"
          : "PROPORTIONAL_KELLY"
        : "PENDING_TICKETS",
      gini: sizingKnown ? round(gini(stakes), 4) : 0,
      meanStake: round(meanStake, 2),
      specialization:
        [league, market].filter(Boolean).join(" ") ||
        String(row.context_type ?? "UNKNOWN"),
      timingArchetype: String(row.context_type ?? "UNKNOWN"),
      correlatedRisk: "NONE",
      correlatedExploitRate: 0,
      syndicateRisk: "LOW",
      syndicateProb: 0,
      subAccountIndex: null,
      var95Usd: sizingKnown ? round(meanStake + 1.645 * sd, 2) : 0,
      cvar95Usd: sizingKnown ? round(meanStake + 2 * sd, 2) : 0,
      holdPct: num(row.hold_pct),
      ltvUsd: num(row.lifetime_net_usd),
      recommendedLimitUsd: num(row.wager_limit_usd),
      inPlayDelaySec: delay,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action: score >= 7 ? "ALERT_OPERATOR" : "ACCEPT_NORMAL",
      ipAddress: String(row.ip_subnet ?? "—"),
      unknown,
      source,
    };
  });
}

/**
 * Map the backtest leaderboard (`/api/customers` `backtestAll`) onto the Profiles shape.
 * The rows carry parlay exposure and CLV, not a per-ticket book: everything that would need
 * tickets or a live profile (Gini, VaR, syndicate, correlation, limits, delay) is listed in
 * `unknown` and rendered as "—" rather than as a measured zero.
 */
export function backtestRowsToProfiles(
  rows: ReadonlyArray<Row>,
): ShowcaseCustomer[] {
  return rows.map((row, idx) => {
    const id = String(
      row.customerId ?? row.customer_id ?? row.customer ?? `BACKTEST-${idx}`,
    );
    const rawSharp = Number(row.sharpScore ?? row.sharp_score);
    const sharpKnown = Number.isFinite(rawSharp) && rawSharp > 0;
    const score = sharpKnown ? clamp(rawSharp / 10, 0, 10) : 0;
    const clvBps = num(row.avgClvBps ?? row.clv_bps);
    const clvScore = clamp(clvBps / 100, -10, 10);
    const tickets = num(row.totalParlayTickets);
    const handle = num(row.totalParlayHandleUsd);
    const meanStake = tickets > 0 && handle > 0 ? handle / tickets : 0;
    const contextType = String(
      row.contextType ?? row.context_type ?? "UNKNOWN",
    );
    const unknown: string[] = [
      "syndicate",
      "correlation",
      "gini",
      "sizing",
      "var95",
      "holdPct",
      "ltv",
      "limit",
      "delay",
      "tickets",
    ];
    if (!sharpKnown) unknown.push("sharpness");
    if (meanStake === 0) unknown.push("meanStake");

    return {
      id,
      name: id,
      agentId: String(row.agentId ?? row.agent_id ?? "—"),
      masterAgent: String(row.masterAgent ?? row.master_agent ?? "—"),
      tier: tierFor(score),
      score: round(score, 2),
      clvScore: round(clvScore, 2),
      skillScore: round(clvScore, 2),
      sizingScore: 0,
      sigScore: 0,
      timingScore: 0,
      sizingStrategy: "PENDING_TICKETS",
      gini: 0,
      meanStake: round(meanStake, 2),
      specialization: String(row.dominantComboFamily ?? contextType),
      timingArchetype: contextType,
      correlatedRisk: "NONE",
      correlatedExploitRate: 0,
      syndicateRisk: "LOW",
      syndicateProb: 0,
      subAccountIndex: null,
      var95Usd: 0,
      cvar95Usd: 0,
      holdPct: 0,
      ltvUsd: 0,
      recommendedLimitUsd: 0,
      inPlayDelaySec: 0,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action: score >= 7 ? "ALERT_OPERATOR" : "ACCEPT_NORMAL",
      ipAddress: String(row.ipSubnet ?? row.ip_subnet ?? "—"),
      unknown,
      source: "backtest",
    };
  });
}

/** Union by customer ID; earlier groups win, so a richer row beats a backtest row. */
export function mergeProfileRows(
  ...groups: ReadonlyArray<ReadonlyArray<ShowcaseCustomer>>
): ShowcaseCustomer[] {
  const byId = new Map<string, ShowcaseCustomer>();
  for (const group of groups) {
    for (const row of group) {
      const key = row.id.trim().toUpperCase();
      if (key && !byId.has(key)) byId.set(key, row);
    }
  }
  return [...byId.values()];
}

/**
 * Which array is the data? `provenance.kind` answers it, so an empty capture stays empty instead
 * of falling back to the fixture corpus (a loaded-but-empty book is not "no book").
 */
export function selectProfileRows(payload: {
  readonly book?: ReadonlyArray<Row> | undefined;
  readonly fixtures: ReadonlyArray<Row>;
  readonly provenance: { readonly kind: string };
}): ShowcaseCustomer[] {
  const kind = payload.provenance.kind;
  const authoritative =
    kind === "capture" || kind === "live"
      ? (payload.book ?? [])
      : payload.fixtures;
  return bookRowsToProfiles(
    authoritative,
    kind === "capture" || kind === "live" ? "book" : "fixture",
  );
}

/** 30d batch rankings → Profiles shape; tier and score come from the ranking payload. */
export function rankingsPlayersToProfiles(
  players: readonly RankedPlayer30d[],
): ShowcaseCustomer[] {
  return players.map((player) => {
    const score = clamp(player.score, 0, 10);
    const mappedTier = mapRankingTierCode(player.tier) ?? tierFor(score);
    const unknown: string[] = ["holdPct", "ltv", "tickets"];
    if (player.handleUsd <= 0) unknown.push("meanStake");
    return {
      id: player.id,
      name: player.id,
      agentId: player.agentId,
      masterAgent: player.masterAgent,
      tier: mappedTier,
      tierLabel: player.tierLabel,
      score: round(score, 2),
      clvScore: round(clamp(player.alertRate / 40, 0, 3), 2),
      skillScore: round(clamp(score * 0.26, 0, 2.5), 2),
      sizingScore: round(clamp(1.5 - player.gini * 0.8, 0, 1.5), 2),
      sigScore: round(clamp(1 + player.alertRate / 100, 0, 2), 2),
      timingScore: player.isProxy ? 0.9 : 0.6,
      sizingStrategy: player.gini > 0.35 ? "VARIABLE_STAKE" : "FLAT_UNIT",
      gini: round(player.gini, 4),
      meanStake:
        player.wagers > 0 ? round(player.handleUsd / player.wagers, 2) : 0,
      specialization: player.dominantSport || "MIXED",
      timingArchetype: player.tierLabel,
      correlatedRisk: player.isProxy ? "HIGH" : "MODERATE",
      correlatedExploitRate: round(player.alertRate / 100, 2),
      syndicateRisk: player.isProxy ? "HIGH" : "ELEVATED",
      syndicateProb: player.isProxy ? 0.75 : 0.35,
      subAccountIndex: null,
      var95Usd: round(Math.max(500, player.handleUsd * 0.05), 2),
      cvar95Usd: round(Math.max(750, player.handleUsd * 0.08), 2),
      holdPct: 0,
      ltvUsd: 0,
      recommendedLimitUsd: player.limitUsd,
      inPlayDelaySec: 0,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action:
        player.tier === "TIER_1" || player.tier === "TIER_2"
          ? "ALERT_OPERATOR"
          : "MONITOR",
      ipAddress: "—",
      unknown,
      source: "rankings",
    };
  });
}

/** Open wager tape → one profile per active customer (matrix overlay). */
export function liveOpenWagersToProfiles(
  wagers: readonly LiveWager[],
): ShowcaseCustomer[] {
  const byCustomer = new Map<
    string,
    {
      agentId: string;
      masterAgent: string;
      riskUsd: number;
      stakes: number[];
      sports: Map<string, number>;
      alerts: number;
    }
  >();
  for (const w of wagers) {
    const id = w.customerId.trim().toUpperCase();
    if (!id) continue;
    let acc = byCustomer.get(id);
    if (!acc) {
      acc = {
        agentId: w.agentId,
        masterAgent: w.masterAgent,
        riskUsd: 0,
        stakes: [],
        sports: new Map(),
        alerts: 0,
      };
      byCustomer.set(id, acc);
    }
    acc.riskUsd += w.riskUsd;
    acc.stakes.push(w.riskUsd);
    const sp = w.sport.trim().toUpperCase() || "OTHER";
    acc.sports.set(sp, (acc.sports.get(sp) ?? 0) + 1);
    if (w.alertTier !== "BASELINE") acc.alerts += 1;
  }

  const out: ShowcaseCustomer[] = [];
  for (const [id, acc] of byCustomer) {
    const meanStake = acc.stakes.length
      ? acc.stakes.reduce((s, v) => s + v, 0) / acc.stakes.length
      : 0;
    const g = gini(acc.stakes);
    let topSport = "MIXED";
    let topCount = 0;
    for (const [sport, count] of acc.sports) {
      if (count > topCount) {
        topSport = sport;
        topCount = count;
      }
    }
    const alertRate =
      acc.stakes.length > 0 ? acc.alerts / acc.stakes.length : 0;
    const unknown: string[] = [
      "holdPct",
      "ltv",
      "sharpness",
      "limit",
      "delay",
      "syndicate",
      "correlation",
    ];

    out.push({
      id,
      name: id,
      agentId: acc.agentId,
      masterAgent: acc.masterAgent,
      tier: "TIER_5_RECREATIONAL",
      tierLabel: "Open book — tier pending 30d rank",
      score: round(clamp(alertRate * 6, 0, 10), 2),
      clvScore: 0,
      skillScore: 0,
      sizingScore: round(clamp(1.5 - g * 0.8, 0, 1.5), 2),
      sigScore: round(alertRate, 2),
      timingScore: 0.5,
      sizingStrategy: g < 0.2 ? "FLAT_UNIT" : "VARIABLE_STAKE",
      gini: round(g, 4),
      meanStake: round(meanStake, 2),
      specialization: topSport,
      timingArchetype: "LIVE_OPEN",
      correlatedRisk: "MODERATE",
      correlatedExploitRate: round(alertRate, 2),
      syndicateRisk: "LOW",
      syndicateProb: 0,
      subAccountIndex: null,
      var95Usd: round(meanStake + 1.645 * Math.sqrt(meanStake), 2),
      cvar95Usd: round(meanStake * 1.35, 2),
      holdPct: 0,
      ltvUsd: 0,
      recommendedLimitUsd: 0,
      inPlayDelaySec: 0,
      lineShadeCents: 0,
      shadowCopyMultiplier: 1,
      action: alertRate > 0.25 ? "ALERT_OPERATOR" : "MONITOR",
      ipAddress: "—",
      openRiskUsd: round(acc.riskUsd, 2),
      unknown,
      source: "live-open",
    });
  }
  return out;
}

/** `?matrix=1` overlay: live-open and 30d rankings under cohort fixtures (cohort wins on id clash). */
export function mergeMatrixProfileOverlay(
  cohortProfiles: readonly ShowcaseCustomer[],
  rankingsPlayers: readonly RankedPlayer30d[] | null | undefined,
  liveWagers: readonly LiveWager[] | null | undefined,
): ShowcaseCustomer[] {
  const ranked = rankingsPlayers?.length
    ? rankingsPlayersToProfiles(rankingsPlayers)
    : [];
  const liveOpen = liveWagers?.length
    ? liveOpenWagersToProfiles(liveWagers)
    : [];
  return mergeProfileRows(cohortProfiles, ranked, liveOpen);
}
